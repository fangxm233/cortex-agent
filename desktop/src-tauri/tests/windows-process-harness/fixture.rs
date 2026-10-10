use std::{
    io::{self, Write},
    process::Command,
    time::{Duration, Instant},
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    type Handler = (&'static str, fn(&[String]));
    let handlers: &[Handler] = &[
        ("sleep", |a| sleep(&a[1])),
        ("tree-exit", |a| tree(&a[0], &a[1])),
        ("tree-wait", |a| tree(&a[0], &a[1])),
        ("fast", |_| fast()),
        ("echo", |a| echo(&a[1..])),
        ("flood", |_| flood()),
        ("exit", |a| exit(&a[1])),
        #[cfg(windows)]
        ("breakaway", |_| breakaway()),
    ];
    handlers
        .iter()
        .find(|(name, _)| *name == args[0])
        .expect("known fixture")
        .1(&args);
}

fn sleep(marker: &str) {
    std::fs::write(marker, std::process::id().to_string()).unwrap();
    std::thread::sleep(Duration::from_secs(60));
}

fn child_command() -> Command {
    let command = Command::new(std::env::current_exe().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        return command;
    }
    #[cfg(not(windows))]
    command
}

fn tree(mode: &str, marker: &str) {
    let mut child = child_command().args(["sleep", marker]).spawn().unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(marker).is_ok_and(|s| s.parse::<u32>().is_ok()) {
        assert!(Instant::now() < end, "descendant did not run");
        std::thread::sleep(Duration::from_millis(10));
    }
    println!("descendant={}", child.id());
    if mode == "tree-wait" {
        child.wait().unwrap();
    }
}

fn fast() {
    let status = child_command().args(["exit", "0"]).status().unwrap();
    assert!(status.success());
}

fn echo(args: &[String]) {
    println!("{args:?}");
    println!("Path={:?}", std::env::var_os("PATH"));
    println!("Removed={:?}", std::env::var_os("CORTEX_REMOVED"));
}

fn flood() {
    io::stdout().write_all(&vec![b'x'; 80 * 1024]).unwrap();
    io::stderr().write_all(&vec![b'y'; 80 * 1024]).unwrap();
}

#[cfg(windows)]
fn breakaway() {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW};
    let child = child_command()
        .args(["exit", "0"])
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW)
        .spawn();
    assert!(child.is_err(), "non-breakaway ownership must reject escape");
    println!("breakaway denied");
}

fn exit(code: &str) {
    println!("out");
    eprintln!("err");
    std::process::exit(code.parse().unwrap());
}
