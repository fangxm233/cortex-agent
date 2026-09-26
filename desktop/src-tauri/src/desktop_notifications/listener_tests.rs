use super::{Listeners, CAPACITY};
use tokio::sync::oneshot;

fn register(listeners: &mut Listeners) -> oneshot::Receiver<()> {
    let (signal, dropped) = oneshot::channel();
    listeners.retain(tauri::async_runtime::spawn(async move {
        let _signal = signal;
        std::future::pending::<()>().await;
    }));
    dropped
}

async fn assert_cancelled(receiver: oneshot::Receiver<()>) {
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
        .await
        .expect("listener must cancel rather than wait for an OS response");
    assert!(result.is_err());
}

#[test]
fn listener_eviction_cancels_the_oldest_wait() {
    tauri::async_runtime::block_on(async {
        let mut listeners = Listeners::default();
        let oldest = register(&mut listeners);
        for _ in 0..CAPACITY {
            let _receiver = register(&mut listeners);
        }
        assert_eq!(listeners.0.len(), CAPACITY);
        assert_cancelled(oldest).await;
    });
}

#[test]
fn state_drop_cancels_remaining_waits() {
    tauri::async_runtime::block_on(async {
        let mut listeners = Listeners::default();
        let receiver = register(&mut listeners);
        drop(listeners);
        assert_cancelled(receiver).await;
    });
}
