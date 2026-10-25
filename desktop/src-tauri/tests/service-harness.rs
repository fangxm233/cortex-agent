// Standalone: rustc --edition=2021 --test desktop/src-tauri/tests/service-harness.rs -o /tmp/cortex-service-tests
extern crate self as tauri;
pub struct AppHandle;

mod process {
    pub struct RunOutcome {
        pub code: i32,
    }
    impl RunOutcome {
        pub fn ok(&self) -> bool {
            self.code == 0
        }
    }
    pub fn run_streaming(
        _: &crate::AppHandle,
        _: &str,
        _: &str,
        _: &[impl AsRef<std::ffi::OsStr>],
    ) -> Result<RunOutcome, String> {
        panic!("tests must not register real services")
    }
}

mod autostart {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum AutostartState {
        On,
        Off,
        External,
    }
}

mod service {
    include!("../src/setup/service.rs");

    #[cfg(test)]
    mod tests {
        use std::collections::VecDeque;

        struct Step {
            command: Vec<OsString>,
            private: bool,
            output: Result<Output, String>,
        }

        fn step(program: &str, args: &[&str], private: bool, stdout: &str) -> Step {
            Step {
                command: std::iter::once(program)
                    .chain(args.iter().copied())
                    .map(OsString::from)
                    .collect(),
                private,
                output: Ok(Output {
                    ok: true,
                    stdout: stdout.into(),
                }),
            }
        }

        fn run_steps(os: &str, home: &Path, steps: Vec<Step>) -> Result<bool, String> {
            let mut steps = VecDeque::from(steps);
            let result = enable_for(os, home, &launch(), &mut |program, args, private| {
                let expected = steps.pop_front().expect("unexpected service-manager call");
                let actual: Vec<OsString> = std::iter::once(OsString::from(program))
                    .chain(args.iter().cloned())
                    .collect();
                assert_eq!(actual, expected.command);
                assert_eq!(private, expected.private, "inspection must never be logged");
                expected.output
            });
            assert!(steps.is_empty(), "missing service-manager calls");
            result
        }

        fn systemd_show(stdout: &str) -> Step {
            step(
                "/usr/bin/systemctl",
                &[
                    "--user",
                    "show",
                    UNIT,
                    "--property=LoadState,ActiveState,FragmentPath,DropInPaths,NeedDaemonReload",
                ],
                true,
                stdout,
            )
        }

        fn systemd_loaded(home: &Path) -> String {
            format!(
                "LoadState=loaded\nFragmentPath={}\nDropInPaths=\nNeedDaemonReload=no\n",
                home.join(".config/systemd/user/cortex.service").display()
            )
        }

        #[test]
        fn linux_registration_is_user_only_and_never_starts_or_restarts_a_daemon() {
            let home = scratch();
            let steps = vec![
                systemd_show(
                    "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\n",
                ),
                step(
                    "/usr/bin/systemctl",
                    &["--user", "daemon-reload"],
                    false,
                    "",
                ),
                systemd_show(&systemd_loaded(&home)),
                step("/usr/bin/systemctl", &["--user", "enable", UNIT], false, ""),
            ];
            assert_eq!(run_steps("linux", &home, steps), Ok(true));
            assert!(home.join(".config/systemd/user/cortex.service").is_file());
        }

        #[test]
        fn exact_loaded_linux_service_is_enabled_without_reloading() {
            let home = scratch();
            ensure_file(
                &home.join(".config/systemd/user/cortex.service"),
                &render_systemd(&launch()).unwrap(),
            )
            .unwrap();
            let steps = vec![
                systemd_show(&systemd_loaded(&home)),
                step("/usr/bin/systemctl", &["--user", "enable", UNIT], false, ""),
            ];
            assert_eq!(run_steps("linux", &home, steps), Ok(true));
        }

        #[test]
        fn unknown_loaded_linux_service_is_not_reloaded_or_written() {
            let home = scratch();
            let steps = vec![systemd_show(&systemd_loaded(&home))];
            assert!(run_steps("linux", &home, steps)
                .unwrap_err()
                .contains("preserved"));
            assert!(!home.join(".config").exists());
        }

        #[test]
        fn legacy_file_prevents_all_manager_mutations() {
            let home = scratch();
            let path = home.join(".config/systemd/user/cortex.service");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "legacy CLI-generated content").unwrap();
            assert!(run_steps("linux", &home, vec![]).is_err());
            assert_eq!(
                fs::read_to_string(path).unwrap(),
                "legacy CLI-generated content"
            );
        }

        fn launchd_state(home: &Path) -> String {
            format!(concat!("gui/501/cc.cortex.agent-server = {{\n\tpath = {}/Library/LaunchAgents/cc.cortex.agent-server.plist\n",
                "\tprogram = /opt/运行 时/node\n\targuments = {{\n\t\t/opt/运行 时/node\n\t\t/opt/Cortex App/cli.js\n\t\tdaemon\n\t}}\n",
                "\tenvironment = {{\n\t\tCORTEX_HOME => /home/用户/Cortex & <home>\n\t\tPATH => /opt/运行 时:/usr/bin\n",
                "\t\tXPC_SERVICE_NAME => cc.cortex.agent-server\n\t}}\n}}\n"), home.display())
        }

        fn launchd_probes(loaded: bool) -> Vec<Step> {
            let listing = if loaded {
                "PID\tStatus\tLabel\n123\t0\tcc.cortex.agent-server\n"
            } else {
                "PID\tStatus\tLabel\n"
            };
            vec![
                step("/usr/bin/id", &["-u"], true, "501\n"),
                step("/bin/launchctl", &["list"], true, listing),
            ]
        }

        #[test]
        fn mac_registration_defers_launch_until_next_login_without_a_second_daemon() {
            let home = scratch();
            let path = home.join("Library/LaunchAgents/cc.cortex.agent-server.plist");
            let mut steps = launchd_probes(false);
            steps.push(step(
                "/bin/launchctl",
                &["enable", "gui/501/cc.cortex.agent-server"],
                false,
                "",
            ));
            assert_eq!(run_steps("macos", &home, steps), Ok(true));
            assert_eq!(
                fs::read_to_string(path).unwrap(),
                render_launchd(&launch()).unwrap()
            );
        }

        #[test]
        fn exact_loaded_mac_service_is_enabled_without_bootstrap_or_restart() {
            let home = scratch();
            ensure_file(
                &home.join("Library/LaunchAgents/cc.cortex.agent-server.plist"),
                &render_launchd(&launch()).unwrap(),
            )
            .unwrap();
            let mut steps = launchd_probes(true);
            steps.push(step(
                "/bin/launchctl",
                &["print", "gui/501/cc.cortex.agent-server"],
                true,
                &launchd_state(&home),
            ));
            steps.push(step(
                "/bin/launchctl",
                &["enable", "gui/501/cc.cortex.agent-server"],
                false,
                "",
            ));
            assert_eq!(run_steps("macos", &home, steps), Ok(true));
        }

        #[test]
        fn loaded_mac_environment_mismatch_is_preserved_without_leaking_values() {
            let home = scratch();
            let path = home.join("Library/LaunchAgents/cc.cortex.agent-server.plist");
            let content = render_launchd(&launch()).unwrap();
            ensure_file(&path, &content).unwrap();
            let state = launchd_state(&home).replace(
                "PATH => /opt/运行 时:/usr/bin",
                "PATH => private-test-value",
            );
            let mut steps = launchd_probes(true);
            steps.push(step(
                "/bin/launchctl",
                &["print", "gui/501/cc.cortex.agent-server"],
                true,
                &state,
            ));
            let error = run_steps("macos", &home, steps).unwrap_err();
            assert!(error.contains("preserved"));
            assert!(!error.contains("private-test-value"));
            assert_eq!(fs::read_to_string(path).unwrap(), content);
        }

        #[test]
        fn manager_failure_does_not_fall_back_to_privileged_registration() {
            let home = scratch();
            let mut failed = systemd_show("");
            failed.output = Ok(Output {
                ok: false,
                stdout: "private-test-value".into(),
            });
            let error = run_steps("linux", &home, vec![failed]).unwrap_err();
            assert!(error.contains("user session/service manager"));
            assert!(!error.contains("private-test-value"));
            assert!(!home.join(".config").exists());
        }

        #[test]
        fn missing_unit_file_does_not_authorize_replacing_a_running_unit() {
            let path = Path::new("/home/u/.config/systemd/user/cortex.service");
            let active = "LoadState=not-found\nActiveState=active\nFragmentPath=\nDropInPaths=\n";
            assert!(check_systemd_state(active, path, false).is_err());
            assert!(check_systemd_state("LoadState=not-found\n", path, false).is_err());
        }

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        #[test]
        fn public_failure_has_autostart_code_without_echoing_launch_values() {
            let mut value = launch();
            value.program = "relative-private-test-value".into();
            let error = enable_user_service(&crate::AppHandle, "test", &value).unwrap_err();
            assert!(error.starts_with("AUTOSTART_FAILED:"));
            assert!(!error.contains("private-test-value"));
        }

        #[test]
        fn unsupported_platform_has_no_service_side_effects() {
            assert_eq!(run_steps("windows", &scratch(), vec![]), Ok(false));
        }

        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        fn launch() -> ServiceLaunch {
            ServiceLaunch {
                program: "/opt/运行 时/node".into(),
                args: vec!["/opt/Cortex App/cli.js".into(), "daemon".into()],
                home: "/home/用户/Cortex & <home>".into(),
                path: "/opt/运行 时:/usr/bin".into(),
                npm_prefix: None,
            }
        }

        fn scratch() -> PathBuf {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "cortex-service-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            path
        }

        #[test]
        fn plist_preserves_separate_arguments_and_minimal_environment() {
            let content = render_launchd(&launch()).unwrap();
            assert!(content.contains("<string>/opt/运行 时/node</string>"));
            assert!(content.contains("<string>/opt/Cortex App/cli.js</string>"));
            assert!(content.contains("<string>daemon</string>"));
            assert!(content.contains("/home/用户/Cortex &amp; &lt;home&gt;"));
            assert!(!content.contains("CORTEX_NPM_PREFIX"));
            assert!(!content.contains("UserName"));
        }

        #[test]
        fn xml_escapes_quotes_and_preserves_line_endings() {
            assert_eq!(
                xml("<&>\"'\r\n").unwrap(),
                "&lt;&amp;&gt;&quot;&apos;&#13;\n"
            );
            assert!(xml("bad\0").is_err());
            assert!(xml("bad\u{b}").is_err());
        }

        #[test]
        fn systemd_quotes_each_word_without_expansion_or_line_injection() {
            let mut value = launch();
            value
                .args
                .push("%h ${SECRET} \"quoted\" \\path\nnext\r\t".into());
            let content = render_systemd(&value).unwrap();
            assert!(content.contains(
                "ExecStart=:\"/opt/运行 时/node\" \"/opt/Cortex App/cli.js\" \"daemon\""
            ));
            assert!(content.contains(r#""%%h ${SECRET} \"quoted\" \\path\nnext\r\t""#));
            assert!(content.contains("WantedBy=default.target"));
            assert!(!content.contains("User="));
            assert!(!content.contains("sudo"));
        }

        #[test]
        fn executable_dollars_are_literal_and_control_characters_are_rejected() {
            let mut value = launch();
            value.program = "/opt/$node/bin/node".into();
            assert!(render_systemd(&value)
                .unwrap()
                .contains("ExecStart=:\"/opt/$node/bin/node\""));
            value.program = "/opt/new\nline/node".into();
            assert!(render_systemd(&value).is_err());
        }

        #[test]
        fn unicode_control_characters_are_not_encoded_as_invalid_utf8_bytes() {
            assert_eq!(systemd_quote("\u{85}"), "\"\\u0085\"");
        }

        #[test]
        fn environment_escapes_percent_but_not_dollar_and_prefix_is_optional() {
            let mut value = launch();
            value.npm_prefix = Some("/space dir/%h/$literal".into());
            assert!(render_systemd(&value)
                .unwrap()
                .contains("Environment=\"CORTEX_NPM_PREFIX=/space dir/%%h/$literal\""));
            assert!(render_launchd(&value)
                .unwrap()
                .contains("<key>CORTEX_NPM_PREFIX</key>"));
            for key in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
                assert!(render_systemd(&value).unwrap().contains(&format!("Environment=\"{key}=/space dir/%%h/$literal\"")));
                assert!(render_launchd(&value).unwrap().contains(&format!("<key>{key}</key>")));
            }
            assert_eq!(environment(&value).unwrap().len(), 5);
            value.npm_prefix = None;
            assert_eq!(environment(&value).unwrap().len(), 2);
        }

        #[test]
        fn file_guard_preserves_foreign_and_legacy_files() {
            let file = scratch().join("cortex.service");
            fs::write(&file, "old autogenerated unit").unwrap();
            let error = ensure_file(&file, "new unit").unwrap_err();
            assert!(error.contains("existing"));
            assert_eq!(fs::read_to_string(file).unwrap(), "old autogenerated unit");
        }

        #[test]
        fn exact_owned_file_is_idempotent_and_parents_are_created() {
            let file = scratch().join("nested/user/cortex.service");
            let content = render_systemd(&launch()).unwrap();
            ensure_file(&file, &content).unwrap();
            let before = fs::metadata(&file).unwrap().modified().unwrap();
            ensure_file(&file, &content).unwrap();
            assert_eq!(fs::metadata(file).unwrap().modified().unwrap(), before);
        }

        #[cfg(unix)]
        #[test]
        fn file_guard_rejects_symlinks_even_when_contents_match() {
            let dir = scratch();
            let target = dir.join("target");
            fs::write(&target, "same").unwrap();
            std::os::unix::fs::symlink(&target, dir.join("unit")).unwrap();
            assert!(ensure_file(&dir.join("unit"), "same").is_err());
            assert_eq!(fs::read_to_string(target).unwrap(), "same");
        }

        #[test]
        fn systemd_loaded_guard_requires_matching_fragment_and_no_overrides() {
            let path = Path::new("/home/u/.config/systemd/user/cortex.service");
            let exact = format!(
                "LoadState=loaded\nFragmentPath={}\nDropInPaths=\nNeedDaemonReload=no\n",
                path.display()
            );
            assert!(check_systemd_state(&exact, path, true).is_ok());
            assert!(check_systemd_state(&exact, path, false).is_err());
            assert!(check_systemd_state(&exact.replace("=no", "=yes"), path, true).is_err());
            assert!(check_systemd_state(
                &exact.replace("DropInPaths=", "DropInPaths=/override"),
                path,
                true
            )
            .is_err());
            assert!(check_systemd_state(
                "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\n",
                path,
                false
            )
            .is_ok());
            assert!(check_systemd_state("LoadState=masked\n", path, true).is_err());
        }

        #[test]
        fn invalid_launch_values_fail_without_lossy_conversion() {
            let mut value = launch();
            value.program = "relative/node".into();
            assert!(render_systemd(&value).is_err());
            value = launch();
            value.args.push("bad\0arg".into());
            assert!(render_launchd(&value).is_err());
        }

        fn run_disable(os: &str, home: &Path, steps: Vec<Step>) -> Result<bool, String> {
            let mut steps = VecDeque::from(steps);
            let result = disable_for(os, home, &mut |program, args, _| {
                let expected = steps.pop_front().expect("unexpected service-manager call");
                let actual: Vec<OsString> = std::iter::once(OsString::from(program))
                    .chain(args.iter().cloned())
                    .collect();
                assert_eq!(actual, expected.command);
                expected.output
            });
            assert!(steps.is_empty(), "missing service-manager calls");
            result
        }

        #[test]
        fn disabling_without_a_registration_touches_nothing() {
            let home = scratch();
            assert_eq!(run_disable("linux", &home, vec![]), Ok(false));
            assert_eq!(run_disable("macos", &home, vec![]), Ok(false));
            assert_eq!(run_disable("windows", &home, vec![]), Ok(false));
        }

        #[cfg(unix)]
        #[test]
        fn owned_systemd_unit_is_disabled_and_removed_even_when_never_loaded() {
            let home = scratch();
            let unit = home.join(".config/systemd/user/cortex.service");
            ensure_file(&unit, &render_systemd(&launch()).unwrap()).unwrap();
            let wants = home.join(".config/systemd/user/default.target.wants");
            fs::create_dir_all(&wants).unwrap();
            std::os::unix::fs::symlink(&unit, wants.join(UNIT)).unwrap();
            let mut disable = step("/usr/bin/systemctl", &["--user", "disable", "--now", UNIT], false, "");
            disable.output = Ok(Output { ok: false, stdout: String::new() });
            let steps = vec![disable, step("/usr/bin/systemctl", &["--user", "daemon-reload"], false, "")];
            assert_eq!(run_disable("linux", &home, steps), Ok(true));
            assert!(!unit.exists());
            assert!(fs::symlink_metadata(wants.join(UNIT)).is_err());
        }

        #[test]
        fn launchd_agent_is_booted_out_before_its_plist_is_removed() {
            let home = scratch();
            let plist = home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"));
            ensure_file(&plist, &render_launchd(&launch()).unwrap()).unwrap();
            let steps = vec![
                step("/usr/bin/id", &["-u"], true, "501\n"),
                step("/bin/launchctl", &["bootout", &format!("gui/501/{LABEL}")], false, ""),
            ];
            assert_eq!(run_disable("macos", &home, steps), Ok(true));
            assert!(!plist.exists());
        }

        #[test]
        fn a_registration_cortex_did_not_write_is_preserved() {
            let home = scratch();
            let unit = home.join(".config/systemd/user/cortex.service");
            fs::create_dir_all(unit.parent().unwrap()).unwrap();
            fs::write(&unit, "[Service]\nExecStart=/usr/bin/cortex daemon\n").unwrap();
            assert!(run_disable("linux", &home, vec![]).unwrap_err().contains("preserved"));
            assert!(unit.is_file());
        }

        fn replay<T>(steps: Vec<Step>, call: impl FnOnce(&mut Runner<'_>) -> T) -> T {
            let mut steps = VecDeque::from(steps);
            let result = call(&mut |program, args, _| {
                let expected = steps.pop_front().expect("unexpected service-manager call");
                let actual: Vec<OsString> = std::iter::once(OsString::from(program))
                    .chain(args.iter().cloned())
                    .collect();
                assert_eq!(actual, expected.command);
                expected.output
            });
            assert!(steps.is_empty(), "missing service-manager calls");
            result
        }

        fn owned_unit(home: &Path) -> PathBuf {
            let unit = home.join(".config/systemd/user/cortex.service");
            ensure_file(&unit, &render_systemd(&launch()).unwrap()).unwrap();
            unit
        }

        fn owned_plist(home: &Path) -> PathBuf {
            let plist = home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"));
            ensure_file(&plist, &render_launchd(&launch()).unwrap()).unwrap();
            plist
        }

        fn is_enabled(answer: &str) -> Step {
            let mut step = step("/usr/bin/systemctl", &["--user", "is-enabled", UNIT], true, answer);
            step.output = Ok(Output { ok: answer.trim() == "enabled", stdout: answer.into() });
            step
        }

        fn print_disabled(listing: &str) -> Vec<Step> {
            vec![
                step("/usr/bin/id", &["-u"], true, "501\n"),
                step("/bin/launchctl", &["print-disabled", "gui/501"], true, listing),
            ]
        }

        #[test]
        fn state_without_a_registration_is_off_and_asks_nothing() {
            let home = scratch();
            assert_eq!(replay(vec![], |r| state_for("linux", &home, r)), AutostartState::Off);
            assert_eq!(replay(vec![], |r| state_for("macos", &home, r)), AutostartState::Off);
        }

        #[test]
        fn a_foreign_registration_is_external() {
            let home = scratch();
            let unit = home.join(".config/systemd/user/cortex.service");
            fs::create_dir_all(unit.parent().unwrap()).unwrap();
            fs::write(&unit, "[Service]\nExecStart=/usr/bin/cortex daemon\n").unwrap();
            assert_eq!(replay(vec![], |r| state_for("linux", &home, r)), AutostartState::External);
        }

        #[test]
        fn linux_state_follows_is_enabled() {
            let home = scratch();
            owned_unit(&home);
            let on = replay(vec![is_enabled("enabled\n")], |r| state_for("linux", &home, r));
            assert_eq!(on, AutostartState::On);
            let off = replay(vec![is_enabled("disabled\n")], |r| state_for("linux", &home, r));
            assert_eq!(off, AutostartState::Off);
        }

        #[test]
        fn mac_state_follows_the_launchd_override() {
            let home = scratch();
            owned_plist(&home);
            let listing = format!("disabled services = {{\n\t\"{LABEL}\" => disabled\n}}\n");
            let off = replay(print_disabled(&listing), |r| state_for("macos", &home, r));
            assert_eq!(off, AutostartState::Off);
            let enabled = format!("disabled services = {{\n\t\"{LABEL}\" => enabled\n}}\n");
            let on = replay(print_disabled(&enabled), |r| state_for("macos", &home, r));
            assert_eq!(on, AutostartState::On);
            let absent = replay(print_disabled("disabled services = {\n}\n"), |r| state_for("macos", &home, r));
            assert_eq!(absent, AutostartState::On);
        }

        #[test]
        fn older_launchd_overrides_read_true_as_disabled() {
            assert!(launchd_disabled(&format!("\t\"{LABEL}\" => true\n")));
            assert!(!launchd_disabled(&format!("\t\"{LABEL}\" => false\n")));
            assert!(!launchd_disabled("\t\"com.example.other\" => disabled\n"));
        }

        #[test]
        fn withdrawing_on_linux_disables_without_stopping_or_deleting() {
            let home = scratch();
            let unit = owned_unit(&home);
            let steps = vec![step("/usr/bin/systemctl", &["--user", "disable", UNIT], false, "")];
            assert_eq!(replay(steps, |r| withdraw_for("linux", &home, r)), Ok(()));
            assert!(unit.is_file());
        }

        #[test]
        fn withdrawing_on_mac_disables_without_booting_out() {
            let home = scratch();
            let plist = owned_plist(&home);
            let steps = vec![
                step("/usr/bin/id", &["-u"], true, "501\n"),
                step("/bin/launchctl", &["disable", &format!("gui/501/{LABEL}")], false, ""),
            ];
            assert_eq!(replay(steps, |r| withdraw_for("macos", &home, r)), Ok(()));
            assert!(plist.is_file());
        }

        #[test]
        fn withdrawing_leaves_absent_and_foreign_registrations_alone() {
            let home = scratch();
            assert_eq!(replay(vec![], |r| withdraw_for("linux", &home, r)), Ok(()));
            let plist = home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"));
            fs::create_dir_all(plist.parent().unwrap()).unwrap();
            fs::write(&plist, "<plist/>").unwrap();
            assert!(replay(vec![], |r| withdraw_for("macos", &home, r)).is_err());
        }

        #[cfg(unix)]
        #[test]
        fn non_utf8_launch_is_rejected() {
            use std::os::unix::ffi::OsStringExt;
            let mut value = launch();
            value.path = OsString::from_vec(vec![0xff]);
            assert!(render_systemd(&value).is_err());
        }
    }
}
