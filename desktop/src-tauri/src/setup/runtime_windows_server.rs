//! Windows npm's global prefix is flat. Bind the real package JS, not cmd/PowerShell.
use super::Server;
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const PACKAGE: &str = "node_modules/@cortex-agent/server";
const ENTRY: &str = "dist/entry/cortex-cli.js";

pub(super) fn package_cli(prefix: &Path) -> Result<PathBuf, String> {
    let fail = || "CLI_NOT_ON_PATH: qualified Windows package CLI missing or outside prefix".to_string();
    let prefix = prefix.canonicalize().map_err(|_| fail())?;
    let root = prefix.join(PACKAGE).canonicalize().map_err(|_| fail())?;
    let cli = root.join(ENTRY).canonicalize().map_err(|_| fail())?;
    if !root.starts_with(&prefix) || !cli.starts_with(&root) || !cli.is_file() {
        return Err(fail());
    }
    let bytes = small_file(&root.join("package.json")).map_err(|_| fail())?;
    let metadata: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    if metadata["name"] != "@cortex-agent/server" || metadata["bin"]["cortex"] != ENTRY {
        return Err(fail());
    }
    Ok(cli)
}

pub(super) fn bind_external(server: &mut Server) -> Result<(), String> {
    let fail = || {
        "SERVER_EXTERNAL_AMBIGUOUS: existing Cortex wrapper cannot be bound to selected Node; its owner must repair it".to_string()
    };
    if !server
        .bin
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"))
    {
        return Err(fail());
    }
    let bytes = small_file(&server.bin).map_err(|_| fail())?;
    let shim = std::str::from_utf8(&bytes)
        .map_err(|_| fail())?
        .replace("\r\n", "\n");
    if shim != npm_shim() {
        return Err(fail());
    }
    let prefix = server.bin.parent().ok_or_else(fail)?;
    server.node_entry = Some(package_cli(prefix)?);
    Ok(())
}

fn small_file(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(std::io::Error::other("metadata/shim limit"));
    }
    Ok(bytes)
}

// Recognize only npm cmd-shim's standard Node launcher (not custom batch code).
// We never execute it. Other templates/native launchers are explicitly ambiguous.
fn npm_shim() -> &'static str {
    concat!(
        "@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\n",
        "IF EXIST \"%dp0%\\node.exe\" (\n  SET \"_prog=%dp0%\\node.exe\"\n) ELSE (\n",
        "  SET \"_prog=node\"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\n",
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  ",
        "\"%dp0%\\node_modules\\@cortex-agent\\server\\dist\\entry\\cortex-cli.js\" %*\n"
    )
}

#[cfg(test)]
#[path = "runtime_windows_server_tests.rs"]
mod tests;
