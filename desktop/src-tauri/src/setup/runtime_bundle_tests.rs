//! Unpacking and restore policy with small fixture archives; Windows tools are shell scripts here.
use super::*;
use std::cell::Cell;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;

fn quiet(_: &str) {}

fn tar_gz(entries: &[(&str, &str, u32, u8)]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    for (name, contents, mode, kind) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::new(*kind));
        header.set_mode(*mode);
        header.set_size(if *kind == b'0' { contents.len() as u64 } else { 0 });
        if *kind == b'2' {
            header.set_link_name(contents).unwrap();
        }
        header.set_cksum();
        let bytes = if *kind == b'0' { contents.as_bytes() } else { &[] };
        builder.append_data(&mut header, name, bytes).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn seven_zip(path: &Path, files: &[(&str, &str)]) {
    let mut writer = sevenz_rust2::ArchiveWriter::create(path).unwrap();
    for (name, contents) in files {
        writer
            .push_archive_entry(sevenz_rust2::ArchiveEntry::new_file(name), Some(contents.as_bytes()))
            .unwrap();
    }
    writer.finish().unwrap();
}

fn node_bundle(dir: &Path, node: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let node = format!("#!/bin/sh\n{node}\n");
    let archive = tar_gz(&[
        ("node-fixture/bin/node", &node, 0o755, b'0'),
        ("node-fixture/lib/node_modules/npm/bin/npm-cli.js", "npm", 0o644, b'0'),
        ("node-fixture/bin/npm", "../lib/node_modules/npm/bin/npm-cli.js", 0o777, b'2'),
    ]);
    std::fs::write(dir.join("node.tar.gz"), archive).unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        r#"{"node":{"version":"24.21.0","archive":"node.tar.gz","root":"node-fixture"}}"#,
    )
    .unwrap();
    dir.to_path_buf()
}

#[test]
fn tar_extraction_keeps_relative_links_and_executable_bits_but_not_setuid() {
    let bytes = tar_gz(&[
        ("node/lib/npm.js", "npm fixture", 0o4755, b'0'),
        ("node/bin/npm", "../lib/npm.js", 0o777, b'2'),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("node.tar.gz");
    std::fs::write(&archive, bytes).unwrap();
    let stage = dir.path().join("stage");
    extract(&archive, &stage, &CancelToken::default()).unwrap();
    let npm = stage.join("node/bin/npm");
    assert_eq!(std::fs::read_to_string(&npm).unwrap(), "npm fixture");
    assert_eq!(std::fs::read_link(&npm).unwrap(), Path::new("../lib/npm.js"));
    assert_eq!(npm.metadata().unwrap().permissions().mode() & 0o4777, 0o755);
}

#[test]
fn entries_must_stay_inside_the_stage() {
    let stage = Path::new("/stage");
    assert_eq!(inside(stage, "git/usr/bin/bash.exe").unwrap(), stage.join("git/usr/bin/bash.exe"));
    for name in ["", "../outside", "git/../../outside", "/etc/passwd", "./git"] {
        assert!(inside(stage, name).is_err(), "{name}");
    }
}

#[test]
fn zip_and_7z_archives_unpack_their_root_folder() {
    let dir = tempfile::tempdir().unwrap();
    let zip_path = dir.path().join("node.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    zip.add_directory("node-win/", options).unwrap();
    zip.start_file("node-win/node_modules/npm/bin/npm-cli.js", options).unwrap();
    zip.write_all(b"npm").unwrap();
    zip.finish().unwrap();
    let seven = dir.path().join("git.7z");
    seven_zip(&seven, &[("git-x/usr/bin/bash.exe", "bash"), ("git-x/cmd/git.exe", "git")]);
    let stage = dir.path().join("stage");
    extract(&zip_path, &stage, &CancelToken::default()).unwrap();
    extract(&seven, &stage, &CancelToken::default()).unwrap();
    assert_eq!(std::fs::read(stage.join("node-win/node_modules/npm/bin/npm-cli.js")).unwrap(), b"npm");
    assert_eq!(std::fs::read(stage.join("git-x/usr/bin/bash.exe")).unwrap(), b"bash");

    let escape = dir.path().join("escape.7z");
    seven_zip(&escape, &[("../outside", "x")]);
    assert!(extract(&escape, &dir.path().join("stage2"), &CancelToken::default()).is_err());
    assert!(!dir.path().join("outside").exists());
}

#[test]
fn a_missing_or_malformed_manifest_means_the_build_has_no_runtime() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(Manifest::load(dir.path()).unwrap_err(), NOT_BUNDLED);
    std::fs::write(
        dir.path().join("manifest.json"),
        r#"{"node":{"version":"1","archive":"node.tar.gz","root":"../escape"}}"#,
    )
    .unwrap();
    assert_eq!(Manifest::load(dir.path()).unwrap_err(), NOT_BUNDLED);
    node_bundle(dir.path(), "echo v24.21.0");
    std::fs::remove_file(dir.path().join("node.tar.gz")).unwrap();
    let manifest = Manifest::load(dir.path()).unwrap();
    let runtime = dir.path().join("home/runtime");
    let error = ensure_node(&manifest, dir.path(), &runtime, &CancelToken::default(), &quiet);
    assert_eq!(error.unwrap_err(), NOT_BUNDLED);
}

#[test]
fn node_is_unpacked_once_reused_and_restored_when_removed_or_broken() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = node_bundle(&dir.path().join("bundle"), "echo v24.21.0");
    let manifest = Manifest::load(&bundle).unwrap();
    let runtime = dir.path().join("home/runtime");
    let token = CancelToken::default();
    let unpacked = Cell::new(0);
    let log = |_: &str| unpacked.set(unpacked.get() + 1);
    let root = ensure_node(&manifest, &bundle, &runtime, &token, &log).unwrap();
    assert_eq!(root, runtime.join("node-fixture"));
    assert_eq!(ensure_node(&manifest, &bundle, &runtime, &token, &log).unwrap(), root);
    assert_eq!(unpacked.get(), 1, "a runnable copy is reused");

    std::fs::remove_dir_all(&root).unwrap();
    ensure_node(&manifest, &bundle, &runtime, &token, &log).unwrap();
    std::fs::write(root.join("bin/node"), "#!/bin/sh\nexit 1\n").unwrap();
    ensure_node(&manifest, &bundle, &runtime, &token, &log).unwrap();
    assert_eq!(unpacked.get(), 3);
    assert!(NodeLayout::of(&root).runs(&token).unwrap());
    let leftovers: Vec<_> = std::fs::read_dir(&runtime).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers, ["node-fixture"], "stage and replaced copies are cleaned up");
}

#[test]
fn a_bundled_node_that_cannot_run_here_is_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = node_bundle(&dir.path().join("bundle"), "exit 1");
    let manifest = Manifest::load(&bundle).unwrap();
    let error = ensure_node(&manifest, &bundle, &dir.path().join("runtime"), &CancelToken::default(), &quiet);
    assert!(error.unwrap_err().starts_with("RUNTIME_UNSUPPORTED"));
}

fn git_bundle(dir: &Path, bash: &str) -> Archive {
    std::fs::create_dir_all(dir).unwrap();
    let bash = format!("#!/bin/sh\n{bash}\n");
    seven_zip(
        &dir.join("git.7z"),
        &[
            ("git-fixture/cmd/git.exe", "#!/bin/sh\necho git version 2.56.0.windows.2\n"),
            ("git-fixture/usr/bin/bash.exe", &bash),
            ("git-fixture/usr/bin/sh.exe", "#!/bin/sh\n"),
            ("git-fixture/usr/bin/grep.exe", "#!/bin/sh\n"),
        ],
    );
    Archive { version: "2.56.0.2".into(), archive: "git.7z".into(), root: "git-fixture".into() }
}

/// 7z keeps no Unix modes; mark the fixture scripts runnable as PortableGit's .exe files are.
fn executable_scripts(stage: &Path) {
    for name in ["cmd/git.exe", "usr/bin/bash.exe", "usr/bin/sh.exe", "usr/bin/grep.exe"] {
        std::fs::set_permissions(stage.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn git_post_install_runs_once_on_the_fresh_copy_before_it_is_moved_into_place() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("bundle");
    let archive = git_bundle(&bundle, "echo cortex-git-qualified");
    let runtime = dir.path().join("runtime");
    let token = CancelToken::default();
    let runs = Cell::new(0);
    let post_install = |stage: &Path, _: &CancelToken| {
        runs.set(runs.get() + 1);
        assert!(stage.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with(".stage-"));
        executable_scripts(stage);
        Ok(())
    };
    let git = ensure_git(&archive, &bundle, &runtime, &token, &quiet, post_install).unwrap();
    assert_eq!(git.root, runtime.join("git-fixture"));
    assert!(git.managed);
    let again = ensure_git(&archive, &bundle, &runtime, &token, &quiet, |_: &Path, _: &CancelToken| {
        panic!("a qualified copy is reused")
    });
    assert_eq!(again.unwrap(), git);
    assert_eq!(runs.get(), 1);

    std::fs::remove_file(&git.bash).unwrap();
    ensure_git(&archive, &bundle, &runtime, &token, &quiet, |stage: &Path, _: &CancelToken| {
        executable_scripts(stage);
        Ok(())
    })
    .unwrap();
    assert!(git.bash.is_file(), "a damaged copy is unpacked again");
}

#[test]
fn git_bash_that_still_cannot_run_after_unpacking_is_a_retryable_failure() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("bundle");
    let archive = git_bundle(&bundle, "exit 1");
    let error = ensure_git(&archive, &bundle, &dir.path().join("runtime"), &CancelToken::default(), &quiet,
        |stage: &Path, _: &CancelToken| {
            executable_scripts(stage);
            Ok(())
        });
    assert!(error.unwrap_err().starts_with("RUNTIME_MISSING"));
}

/// Unpack a real staged bundle (desktop/scripts/fetch-bundled-runtime.mjs output) on this host.
/// `CORTEX_BUNDLE_TEST_DIR=<staged dir> cargo test real_bundle -- --ignored`
#[test]
#[ignore = "needs a staged bundled-runtime directory"]
fn real_bundle_archives_unpack_in_process() {
    let bundle = PathBuf::from(std::env::var_os("CORTEX_BUNDLE_TEST_DIR").expect("staged bundle dir"));
    let manifest = Manifest::load(&bundle).unwrap();
    let stage = tempfile::tempdir().unwrap();
    for archive in [Some(&manifest.node), manifest.git.as_ref()].into_iter().flatten() {
        let started = std::time::Instant::now();
        extract(&bundle.join(&archive.archive), stage.path(), &CancelToken::default()).unwrap();
        let root = stage.path().join(&archive.root);
        let count = walk(&root);
        eprintln!("{}: {count} files in {:?}", archive.archive, started.elapsed());
        assert!(count > 1000, "{}", archive.archive);
    }
    let node = stage.path().join(&manifest.node.root);
    assert!(["node.exe", "bin/node"].iter().any(|n| node.join(n).is_file()));
    if let Some(git) = &manifest.git {
        let git = stage.path().join(&git.root);
        for name in ["cmd/git.exe", "usr/bin/bash.exe", "usr/bin/sh.exe", "usr/bin/grep.exe", "git-bash.exe", "post-install.bat"] {
            assert!(git.join(name).is_file(), "{name}");
        }
    }
}

fn walk(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() { walk(&e.path()) } else { 1 }
        })
        .sum()
}
