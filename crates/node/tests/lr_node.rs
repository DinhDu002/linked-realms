//! The `lr-node` binary as a supervisor runs it: its settings, what it prints, its RPC, and how it
//! stops.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use linked_realms_core::params::DEV_CHECKPOINT_SEED;
use linked_realms_core::{Address, PUBLIC_KEY_LEN, SCHEME_ML_DSA_44, words_from_entropy};
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
    let mut child = lr_node(args)
        .args(["--network", "dev", "--data", data.0.to_str().unwrap()])
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

/// One JSON-RPC call over HTTP on `stream`, with the extra `headers`: the status code, and the
/// body if it is JSON.
fn post(mut stream: impl Read + Write, headers: &str, method: &str, params: Value) -> (u16, Value) {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let body = body.to_string();
    write!(
        stream,
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{headers}\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head[9..12].parse().unwrap();
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

fn call(rpc: &str, method: &str) -> Value {
    call_with(rpc, method, json!([]))
}

fn call_with(rpc: &str, method: &str, params: Value) -> Value {
    post(TcpStream::connect(rpc).unwrap(), "", method, params).1["result"].clone()
}

/// An LR address to mine for.
fn address() -> String {
    let address = Address::from_public_key(SCHEME_ML_DSA_44, &[7; PUBLIC_KEY_LEN]);
    address.unwrap().to_string()
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
fn lr_node_mines_for_one_address_from_the_start() {
    let data = Data::new("mines");
    let address = address();
    let socket = data.0.join("control.sock");
    let control = format!("unix:{}", socket.display());
    let (mut child, mut stdout, lines) = start(
        &data,
        &[
            "mine",
            "--reward-address",
            &address,
            "--mode",
            "light",
            "--rpc",
            "127.0.0.1:0",
            "--control",
            &control,
        ],
        "mine ",
    );
    assert_eq!(lines[2], format!("control {}", socket.display()));
    assert_eq!(lines[3], format!("mine {address} threads 1"));
    let status = || {
        let (_, body) = post(
            UnixStream::connect(&socket).unwrap(),
            "",
            "mine_status",
            json!({ "id": "land" }),
        );
        body["result"].clone()
    };
    assert_eq!(status()["rewardAddress"], json!(address));
    assert_ne!(status()["state"], json!("off"));

    // The public RPC has no mine_* method.
    let rpc = lines[1].strip_prefix("rpc ").unwrap();
    let params = json!({ "id": "land", "rewardAddress": address, "threads": 1, "mode": "light" });
    let (_, refused) = post(TcpStream::connect(rpc).unwrap(), "", "mine_start", params);
    assert_eq!(refused["error"]["code"], json!(-32601));

    // A Block won is printed, and is on the Node's chain: the first above its genesis.
    let deadline = Instant::now() + Duration::from_secs(300);
    while status()["blocksWon"] == json!(0) {
        assert!(Instant::now() < deadline, "no Block won: {}", status());
        std::thread::sleep(Duration::from_millis(500));
    }
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let won = line.trim_end().strip_prefix("won ").unwrap().to_string();
    assert_eq!(status()["state"], json!("on"));
    let (_, header) = post(
        TcpStream::connect(rpc).unwrap(),
        "",
        "lr_getHeader",
        json!([won]),
    );
    assert_eq!(header["result"]["height"], json!(1), "{header}");
    assert!(signal(&mut child, libc::SIGTERM).success());
    assert!(!socket.exists());
}

#[test]
fn lr_node_serves_control_on_tcp_only_with_its_secret() {
    let data = Data::new("tcp-control");
    std::fs::create_dir(&data.0).unwrap();
    let secret = data.0.join("control.secret");
    std::fs::write(&secret, [9; 32]).unwrap();
    let secret = secret.to_str().unwrap();
    let args = [
        "--rpc",
        "off",
        "--control",
        "127.0.0.1:0",
        "--control-secret",
        secret,
    ];
    let (mut child, _, lines) = start(&data, &args, "control ");
    let control = lines[1].strip_prefix("control ").unwrap();
    let node_info = |headers: &str| {
        let stream = TcpStream::connect(control).unwrap();
        post(stream, headers, "node_info", json!([]))
    };
    assert_eq!(node_info("").0, 401);
    let (status, info) = node_info(&format!(
        "Authorization: Bearer {}\r\n",
        hex::encode([9; 32])
    ));
    assert_eq!((status, &info["result"]["height"]), (200, &json!(0)));
    assert!(signal(&mut child, libc::SIGTERM).success());

    // A secret shorter than 32 bytes is refused.
    std::fs::write(secret, [9; 31]).unwrap();
    let output = lr_node(&args)
        .args(["--data", data.0.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn lr_node_refuses_a_control_socket_another_user_could_replace() {
    let data = Data::new("loose");
    std::fs::create_dir(&data.0).unwrap();
    std::fs::set_permissions(&data.0, PermissionsExt::from_mode(0o777)).unwrap();
    let control = format!("unix:{}", data.0.join("control.sock").display());
    let output = lr_node(&["--rpc", "off", "--control", &control])
        .args(["--network", "dev", "--data", data.0.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(output.stdout, b"", "nothing printed before it failed");
}

/// The lines `stdout` prints from now on, read on a thread of their own.
fn lines(stdout: BufReader<ChildStdout>) -> mpsc::Receiver<String> {
    let (send, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in stdout.lines() {
            let Ok(line) = line else { return };
            if send.send(line).is_err() {
                return;
            }
        }
    });
    lines
}

#[test]
fn a_signer_following_a_seed_signs_checkpoints_the_seed_takes() {
    let (seed_data, signer_data) = (Data::new("seed"), Data::new("signer"));
    std::fs::create_dir(&signer_data.0).unwrap();
    let words = signer_data.0.join("checkpoint-words");
    std::fs::write(&words, words_from_entropy(&DEV_CHECKPOINT_SEED)).unwrap();
    let cores = std::thread::available_parallelism().map_or(1, |cores| cores.get());
    let threads = cores.saturating_sub(1).max(1).to_string();
    let (_seed, stdout_of_seed, lines_of_seed) = start(
        &seed_data,
        &[
            "mine",
            "--reward-address",
            &address(),
            "--threads",
            &threads,
            "--mode",
            "light",
            "--listen",
            "127.0.0.1:0",
            "--rpc",
            "127.0.0.1:0",
        ],
        "mine ",
    );
    // Read on, so the seed can print each Block it wins.
    let won = lines(stdout_of_seed);
    let p2p = lines_of_seed[1].strip_prefix("p2p ").unwrap();
    // By name, as a Node on another machine names the company's seed.
    let p2p = &format!("localhost:{}", p2p.rsplit_once(':').unwrap().1);
    let rpc = lines_of_seed[2].strip_prefix("rpc ").unwrap();
    let words = words.to_str().unwrap();
    let signing = [
        "sign",
        "--checkpoint-words",
        words,
        "--seed",
        p2p,
        "--rpc",
        "off",
    ];
    let (mut signer, stdout, _) = start(&signer_data, &signing, "network ");
    let printed = lines(stdout);
    let line = printed.recv_timeout(Duration::from_secs(600)).unwrap();
    let (height, id) = line
        .strip_prefix("checkpoint ")
        .unwrap()
        .split_once(' ')
        .unwrap();
    assert_eq!(height, "10", "{line}");
    // The seed takes it from the signer, its other Node, and holds it on its best chain.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let latest = call(rpc, "lr_getInfo")["latestCheckpoint"].clone();
        if latest["height"] == json!(10) {
            assert_eq!(latest["blockId"], json!(id));
            break;
        }
        assert!(Instant::now() < deadline, "{latest}");
        std::thread::sleep(Duration::from_millis(200));
    }
    let header = call_with(rpc, "lr_getHeaders", json!([10, 1]));
    assert_eq!(header[0]["id"], json!(id));
    assert!(signal(&mut signer, libc::SIGTERM).success());
    // The seed printed each Block it won once.
    let won: Vec<_> = won.try_iter().collect();
    let once: std::collections::HashSet<_> = won.iter().collect();
    assert!(won.len() >= 10 && once.len() == won.len(), "{won:?}");
}

#[test]
fn a_signer_needs_the_network_s_own_key() {
    let data = Data::new("wrong-key");
    std::fs::create_dir(&data.0).unwrap();
    let words = data.0.join("checkpoint-words");
    for (network, text) in [
        ("test", words_from_entropy(&DEV_CHECKPOINT_SEED)),
        ("dev", "not twenty-four words".to_string()),
    ] {
        std::fs::write(&words, text).unwrap();
        let output = lr_node(&["sign", "--checkpoint-words", words.to_str().unwrap()])
            .args(["--network", network, "--data", data.0.to_str().unwrap()])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{network}");
        assert_eq!(output.stdout, b"");
    }
}

#[test]
fn lr_node_refuses_bad_settings() {
    let (address, data) = (address(), Data::new("refused"));
    let mine = |rest: &[&'static str]| [&["mine", "--reward-address", &address][..], rest].concat();
    for args in [
        &["--network", "main"][..],
        &["--rpc"],
        &["--listen", "localhost"],
        &["--seed", "1.2.3.4"],
        &["--seed", "no-such-node.invalid:9444"],
        &["--mine"],
        &["--control", "127.0.0.1:0"],
        &["--control-secret", "secret"],
        &[
            "--control",
            "unix:control.sock",
            "--control-secret",
            "secret",
        ],
        &["--control", "localhost:1", "--control-secret", "secret"],
        &["--threads", "1"],
        &["--reward-address", &address],
        &["mine"],
        &["mine", "--reward-address", "lr1nope"],
        &mine(&["--threads", "0"]),
        &mine(&["--threads", "x"]),
        &mine(&["--mode", "turbo"]),
        &["sign"],
        &["--checkpoint-words", "words"],
        &["mine", "--checkpoint-words", "words"],
        &["--rpc-proxy", "caddy"],
    ] {
        let stderr = refused(lr_node(args), &data);
        assert!(stderr.contains("usage: lr-node"), "{args:?}: {stderr}");
    }
    // The thread cap, one fewer than the cores, lowered by MINE_MAX_THREADS, which must be a
    // count.
    let cores = std::thread::available_parallelism().map_or(1, |cores| cores.get());
    let cores: &'static str = cores.max(2).to_string().leak();
    for (limit, threads) in [
        (None, cores),
        (Some("1"), "2"),
        (Some("0"), "1"),
        (Some("x"), "1"),
    ] {
        let mut command = lr_node(&mine(&["--threads", threads]));
        command.env_remove("MINE_MAX_THREADS");
        if let Some(limit) = limit {
            command.env("MINE_MAX_THREADS", limit);
        }
        refused(command, &data);
    }
}

/// Runs `command` in `data` and asserts it exits with code 2 within 10 seconds: its stderr. A
/// Node that starts instead of refusing is stopped, and keeps its chain in `data`.
fn refused(mut command: Command, data: &Data) -> String {
    std::fs::create_dir_all(&data.0).unwrap();
    command
        .current_dir(&data.0)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = Process(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.0.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let code = child.0.try_wait().unwrap().and_then(|status| status.code());
    let mut stderr = String::new();
    if code.is_some() {
        let mut pipe = child.0.stderr.take().unwrap();
        pipe.read_to_string(&mut stderr).unwrap();
    }
    assert_eq!(code, Some(2), "{command:?}: {stderr}");
    stderr
}
