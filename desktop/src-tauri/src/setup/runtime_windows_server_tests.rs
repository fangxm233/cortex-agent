use super::*;

#[test]
fn flat_prefix_requires_actual_packaged_cli_not_shim() {
    let dir = tempfile::tempdir().unwrap();
    let cli = package_fixture(dir.path());
    assert_eq!(package_cli(dir.path()).unwrap(), cli);
    std::fs::remove_file(&cli).unwrap();
    std::fs::write(dir.path().join("cortex.cmd"), npm_shim()).unwrap();
    assert!(package_cli(dir.path()).is_err());
}

#[test]
fn external_packaged_shim_is_bound_without_executing_or_overwriting_it() {
    let dir = tempfile::tempdir().unwrap();
    let cli = package_fixture(dir.path());
    let bin = dir.path().join("cortex.cmd");
    std::fs::write(&bin, npm_shim()).unwrap();
    let mut server = super::super::Server {
        bin: bin.clone(),
        managed: false,
        node_entry: None,
    };
    bind_external(&mut server).unwrap();
    assert_eq!(server.bin, bin);
    assert_eq!(server.node_entry, Some(cli.clone()));
    assert!(!server.managed);
    assert_eq!(std::fs::read_to_string(&bin).unwrap(), npm_shim());
    let mut selected = super::super::Selection::new(
        dir.path().join("node.exe"),
        dir.path().join("npm.cmd"),
        dir.path().join("private"),
    );
    selected.server = Some(server);
    let command = selected.command(bin.as_os_str());
    assert_eq!(command.get_program(), selected.node);
    assert_eq!(command.get_args().next(), Some(cli.as_os_str()));
}

#[test]
fn arbitrary_external_cmd_or_exe_reports_identity_ambiguity() {
    let dir = tempfile::tempdir().unwrap();
    package_fixture(dir.path());
    for (name, body) in [
        ("cortex.cmd", "@other-node unrelated.js %*"),
        ("cortex.exe", "native wrapper"),
    ] {
        let bin = dir.path().join(name);
        std::fs::write(&bin, body).unwrap();
        let mut server = super::super::Server {
            bin,
            managed: false,
            node_entry: None,
        };
        assert!(bind_external(&mut server)
            .unwrap_err()
            .starts_with("SERVER_EXTERNAL_AMBIGUOUS"));
        assert!(server.node_entry.is_none());
    }
}

#[test]
fn package_metadata_and_path_cannot_escape_or_substitute_another_cli() {
    let dir = tempfile::tempdir().unwrap();
    package_fixture(dir.path());
    let metadata = dir.path().join("node_modules/@cortex-agent/server/package.json");
    std::fs::write(metadata, r#"{"name":"other","bin":{"cortex":"../../evil.js"}}"#).unwrap();
    assert!(package_cli(dir.path()).is_err());
}

fn package_fixture(prefix: &Path) -> PathBuf {
    let root = prefix.join("node_modules/@cortex-agent/server");
    std::fs::create_dir_all(root.join("dist/entry")).unwrap();
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"@cortex-agent/server","bin":{"cortex":"dist/entry/cortex-cli.js"}}"#,
    )
    .unwrap();
    let cli = root.join("dist/entry/cortex-cli.js");
    std::fs::write(&cli, "#!/usr/bin/env node\nfixture").unwrap();
    cli.canonicalize().unwrap()
}
