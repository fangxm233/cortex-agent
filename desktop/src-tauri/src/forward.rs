// input:  a remote loopback port, the stored server URL + token
// output: forward_* Tauri commands and a local listener piping TCP over the server WebSocket
// pos:    Desktop-only: makes a service on the Cortex server reachable at 127.0.0.1 here
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::AppState;

/// Port forwarding, VS Code's model (plan/embedded-browser.md §4): we bind a REAL local port here
/// and relay every connection over the already-authenticated channel to the server, which connects
/// to its own loopback. Forwarding at the TCP layer moves the whole origin to this machine, so
/// absolute paths, cookies, storage and the HMR WebSocket all work with no rewriting — and the
/// previewed page can never be same-origin with the app page or the API.

/// How many ports to probe past the requested one before falling back to an ephemeral port.
/// Keeping the same number as the server matters: cookies are per-origin, so a port that moves
/// on every launch throws away the dev app's login state.
const PORT_PROBE_SPAN: u16 = 20;

/// Frame size for the TCP → WebSocket direction.
const READ_BUF: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    /// Port on the SERVER's loopback.
    pub remote_port: u16,
    /// Port bound here. Equals `remote_port` unless it was taken.
    pub local_port: u16,
    /// Ready-to-open URL for the preview pane.
    pub url: String,
}

struct Entry {
    info: ForwardInfo,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Tears down relays that are ALREADY established. Closing the listener only stops new
    /// connections, and a browser holds its keep-alive socket open for a minute or more — so
    /// without this, "stop" would leave the page still loading through a tunnel the user closed.
    shutdown: broadcast::Sender<()>,
}

#[derive(Default)]
pub struct ForwardState {
    entries: Mutex<HashMap<u16, Entry>>,
}

/// `https://host` → `wss://host/forward?port=N` (and `http` → `ws`).
fn forward_ws_url(server_url: &str, port: u16) -> Result<String, String> {
    let trimmed = server_url.trim_end_matches('/');
    let base = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(format!("unsupported server URL: {server_url}"));
    };
    Ok(format!("{base}/forward?port={port}"))
}

/// Bind the requested port if free, else the next free one, else any ephemeral port.
async fn bind_local(preferred: u16) -> Result<(TcpListener, u16), String> {
    for candidate in preferred..preferred.saturating_add(PORT_PROBE_SPAN) {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", candidate)).await {
            return Ok((l, candidate));
        }
    }
    let l = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("no local port available: {e}"))?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    Ok((l, port))
}

/// One accepted local connection ⇄ one server WebSocket ⇄ one TCP connection on the server.
/// No multiplexing: per-stream flow control would have to be re-invented, and the browser opens
/// its own sockets anyway.
async fn relay(mut tcp: TcpStream, ws_url: String, token: String, mut shutdown: broadcast::Receiver<()>) {
    let mut request = match ws_url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("forward: bad request url: {e}");
            return;
        }
    };
    match token.parse() {
        Ok(value) => {
            request.headers_mut().insert("x-cortex-token", value);
        }
        Err(_) => {
            eprintln!("forward: token is not a valid header value");
            return;
        }
    }

    let (ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("forward: connect failed: {e}");
            return;
        }
    };
    let (mut sink, mut stream) = ws.split();
    let (mut reader, mut writer) = tcp.split();
    let mut buf = vec![0u8; READ_BUF];

    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if sink.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            },
            _ = shutdown.recv() => break,
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    if writer.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                // Text/ping/pong are not part of this protocol; ignore rather than tear down.
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = sink.close().await;
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// Start (or return the existing) forward for a server-side loopback port.
#[tauri::command]
pub async fn forward_start(
    state: State<'_, ForwardState>,
    app_state: State<'_, AppState>,
    port: u16,
) -> Result<ForwardInfo, String> {
    if port < 1024 {
        return Err("only ports ≥ 1024 can be forwarded".into());
    }
    // Idempotent: the pane calls this whenever it opens a target.
    if let Some(existing) = state.entries.lock().unwrap().get(&port) {
        return Ok(existing.info.clone());
    }

    let (server_url, token) = {
        let cfg = app_state.config.lock().unwrap();
        (cfg.server_url.clone(), cfg.token.clone())
    };
    let server_url = server_url.ok_or("no server configured")?;
    let token = token.ok_or("no token configured")?;
    let ws_url = forward_ws_url(&server_url, port)?;

    let (listener, local_port) = bind_local(port).await?;
    let (shutdown, _) = broadcast::channel::<()>(1);
    let relay_shutdown = shutdown.clone();
    let info = ForwardInfo {
        remote_port: port,
        local_port,
        url: format!("http://127.0.0.1:{local_port}/"),
    };

    let task = tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((tcp, _)) => {
                    let _ = tcp.set_nodelay(true);
                    let ws_url = ws_url.clone();
                    let token = token.clone();
                    let rx = relay_shutdown.subscribe();
                    tauri::async_runtime::spawn(relay(tcp, ws_url, token, rx));
                }
                Err(e) => {
                    eprintln!("forward: accept failed: {e}");
                    break;
                }
            }
        }
    });

    eprintln!("forward: 127.0.0.1:{local_port} → server :{port}");
    state
        .entries
        .lock()
        .unwrap()
        .insert(port, Entry { info: info.clone(), task, shutdown });
    Ok(info)
}

/// Stop a forward: close the listener AND tear down every relay it opened.
#[tauri::command]
pub fn forward_stop(state: State<'_, ForwardState>, port: u16) -> bool {
    match state.entries.lock().unwrap().remove(&port) {
        Some(entry) => {
            // Send before aborting the accept loop: a receiver-less send is a no-op, which is the
            // correct behaviour when no connection was ever made.
            let _ = entry.shutdown.send(());
            entry.task.abort();
            eprintln!("forward: stopped :{port}");
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn forward_list(state: State<'_, ForwardState>) -> Vec<ForwardInfo> {
    let mut all: Vec<ForwardInfo> = state
        .entries
        .lock()
        .unwrap()
        .values()
        .map(|e| e.info.clone())
        .collect();
    all.sort_by_key(|i| i.remote_port);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ws_urls_for_both_schemes() {
        assert_eq!(
            forward_ws_url("https://app-lab2.fangxm.me", 5173).unwrap(),
            "wss://app-lab2.fangxm.me/forward?port=5173"
        );
        assert_eq!(
            forward_ws_url("http://127.0.0.1:3005/", 6080).unwrap(),
            "ws://127.0.0.1:3005/forward?port=6080"
        );
    }

    #[test]
    fn rejects_a_non_http_server_url() {
        assert!(forward_ws_url("cortexui://localhost", 5173).is_err());
    }
}
