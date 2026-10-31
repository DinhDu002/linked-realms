//! The `lr-node` binary as a supervisor runs it: its settings, what it prints, its RPC, and how it
//! stops.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Data(PathBuf);

impl Data {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("lr-node-bin-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        Data(path)
    }
}

impl Drop for Data {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A running `lr-node`, killed if a test ends before it stops.
struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn lr_node(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lr-node"));
    command.args(args);
    command
}

/// Starts `lr-node` and reads the lines it prints until the one starting with `last`.
fn start(data: &Data, args: &[&str], last: &str) -> (Process, BufReader<ChildStdout>, Vec<String>) {
    let mut child = lr_node(&["--network", "dev", "--data", data.0.to_str().unwrap()])
        .args(args)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout: BufReader<ChildStdout> = BufReader::new(child.stdout.take().unwrap());
    let child = Process(child);
    let mut lines = Vec::new();
    while lines
        .last()
        .is_none_or(|line: &String| !line.starts_with(last))
    {
        let mut line = String::new();
        assert_ne!(
            stdout.read_line(&mut line).unwrap(),
            0,
            "lr-node printed {lines:?}"
        );
        lines.push(line.trim_end().to_string());
    }
    (child, stdout, lines)
}

fn call(rpc: &str, method: &str) -> Value {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method }).to_string();
    let mut stream = TcpStream::connect(rpc).unwrap();
    write!(
        stream,
        "POST / HTTP/1.1\r\nHost: {rpc}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    serde_json::from_str::<Value>(body).unwrap()["result"].clone()
}

fn signal(child: &mut Process, signal: libc::c_int) -> std::process::ExitStatus {
    // SAFETY: a plain system call with no pointers, to a child this test started.
    assert_eq!(
        unsafe { libc::kill(child.0.id() as libc::pid_t, signal) },
        0
    );
    child.0.wait().unwrap()
}

#[test]
fn lr_node_serves_its_rpc_and_stops_cleanly_on_a_signal() {
    let data = Data::new("serves");
    let (mut child, _, lines) = start(
        &data,
        &["--listen", "127.0.0.1:0", "--rpc", "127.0.0.1:0"],
        "rpc ",
    );
    assert_eq!(lines[0], "network 2");
    assert!(lines[1].starts_with("p2p 127.0.0.1:"), "{lines:?}");
    let rpc = lines[2].strip_prefix("rpc ").unwrap();
    let info = call(rpc, "lr_getInfo");
    assert_eq!(
        (&info["networkId"], &info["height"]),
        (&json!(2), &json!(0))
    );
    assert_eq!(info["archive"], json!(false));
    assert!(signal(&mut child, libc::SIGTERM).success());
    assert!(data.0.join("chain.redb").is_file());

    // The same data again, as an archive and stopped by SIGINT.
    let (mut child, _, lines) = start(&data, &["--rpc", "127.0.0.1:0", "--archive"], "rpc ");
    assert_eq!(
        lines.len(),
        2,
        "no P2P listener without --listen: {lines:?}"
    );
    let info = call(lines[1].strip_prefix("rpc ").unwrap(), "lr_getInfo");
    assert_eq!(info["archive"], json!(true));
    assert!(signal(&mut child, libc::SIGINT).success());

    // Without an RPC it prints only the network.
    let (mut child, mut stdout, lines) = start(&data, &["--rpc", "off"], "network ");
    assert!(signal(&mut child, libc::SIGTERM).success());
    let mut rest = String::new();
    stdout.read_to_string(&mut rest).unwrap();
    assert_eq!(
        (lines, rest),
        (vec!["network 2".to_string()], String::new())
    );
}

#[test]
fn lr_node_refuses_bad_settings() {
    for args in [
        &["--network", "main"][..],
        &["--rpc"],
        &["--listen", "localhost"],
        &["--seed", "1.2.3.4"],
        &["--mine"],
    ] {
        let output = lr_node(args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("usage: lr-node"), "{args:?}: {stderr}");
    }
}
