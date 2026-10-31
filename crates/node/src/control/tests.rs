use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;

use super::*;
use crate::chain::tests::File;
use crate::mempool::tests::key;
use crate::mine::max_threads;
use crate::mine::tests::dev_node;
use crate::pow::Keys;

/// A directory with the mode `mode`, removed after.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str, mode: u32) -> Self {
        let path = std::env::temp_dir().join(format!("lr-control-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, Permissions::from_mode(mode)).unwrap();
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

/// One JSON-RPC call over HTTP on `stream`, with the extra `headers`: the status code, and the
/// body if it is JSON.
fn post(mut stream: impl Stream, headers: &str, method: &str, params: Value) -> (u16, Value) {
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

/// A WebSocket client just big enough for these tests: text frames out, masked as a client's
/// must be, text frames in, and pings answered.
struct Ws(Box<dyn Stream>);

impl Ws {
    /// Upgrades `stream`, or gives the head of the response that refused it.
    fn connect(mut stream: impl Stream + 'static, headers: &str) -> Result<Ws, String> {
        write!(
            stream,
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
             {headers}\r\n"
        )
        .unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        let head = String::from_utf8(head).unwrap();
        match head.starts_with("HTTP/1.1 101") {
            true => Ok(Ws(Box::new(stream))),
            false => Err(head),
        }
    }

    fn frame(&mut self, opcode: u8, payload: &[u8]) {
        let mut frame = vec![0x80 | opcode];
        match payload.len() {
            n if n < 126 => frame.push(0x80 | n as u8),
            n => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
        }
        // A mask of zeros leaves the payload as it is.
        frame.extend_from_slice(&[0; 4]);
        frame.extend_from_slice(payload);
        self.0.write_all(&frame).unwrap();
    }

    fn send(&mut self, value: &Value) {
        self.frame(1, value.to_string().as_bytes());
    }

    /// The next text frame, as JSON.
    fn next(&mut self) -> Value {
        loop {
            let mut head = [0; 2];
            self.0.read_exact(&mut head).unwrap();
            let len = match head[1] & 0x7f {
                126 => {
                    let mut len = [0; 2];
                    self.0.read_exact(&mut len).unwrap();
                    u16::from_be_bytes(len) as usize
                }
                127 => {
                    let mut len = [0; 8];
                    self.0.read_exact(&mut len).unwrap();
                    u64::from_be_bytes(len) as usize
                }
                len => len as usize,
            };
            let mut payload = vec![0; len];
            self.0.read_exact(&mut payload).unwrap();
            match head[0] & 0x0f {
                1 => return serde_json::from_slice(&payload).unwrap(),
                9 => self.frame(10, &payload),
                _ => {}
            }
        }
    }
}

fn start(id: &str, reward_address: &str, threads: usize) -> Value {
    json!({ "id": id, "rewardAddress": reward_address, "threads": threads, "mode": "light" })
}

#[test]
fn the_control_socket_serves_the_node_and_its_mine() {
    let (file, dir) = (File::new("control"), Dir::new("serves", 0o700));
    let keys = Arc::new(Keys::default());
    let running = dev_node(&file, &keys);
    let cap = max_threads(None);
    let mine = Arc::new(Mine::new(running.clone(), keys, cap));
    let path = dir.0.join("control.sock");
    let control = Control::start(running.clone(), mine.clone(), Listen::Unix(path.clone()));
    let control = control.unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let call = |method: &str, params: Value| {
        post(UnixStream::connect(&path).unwrap(), "", method, params).1
    };

    let info = call("node_info", json!([]))["result"].clone();
    let seen = [&info["height"], &info["connections"], &info["synced"]];
    assert_eq!(seen, [&json!(0), &json!(0), &json!(true)]);
    assert_eq!(info["maxThreads"], json!(cap));
    assert!(
        info["memoryAvailableMiB"]
            .as_u64()
            .is_some_and(|mib| mib > 0)
    );
    let land = json!({ "id": "land" });
    assert_eq!(call("mine_status", land.clone())["result"]["state"], "off");

    // Each refusal, with its reason.
    let address = key(1).address().to_string();
    let refused = |params: Value| {
        let error = call("mine_start", params)["error"].clone();
        (error["code"].clone(), error["message"].clone())
    };
    let reason = |text: &str| (json!(-32602), json!(text));
    assert_eq!(refused(start("other", &address, 1)), reason("unknown-mine"));
    assert_eq!(
        refused(start("land", "lr1nothing", 1)),
        reason("bad-address")
    );
    assert_eq!(refused(start("land", &address, 0)), reason("bad-threads"));
    assert_eq!(
        refused(start("land", &address, cap + 1)),
        reason("bad-threads")
    );
    let other = call("mine_status", json!({ "id": "other" }));
    assert_eq!(other["error"]["message"], "unknown-mine");
    assert_eq!(mine.status().state, State::Off);

    // A subscriber hears the Mine start, and the Block it won once the Node took it.
    let mut ws = Ws::connect(UnixStream::connect(&path).unwrap(), "").unwrap();
    let subscribe =
        json!({ "jsonrpc": "2.0", "id": 1, "method": "mine_subscribe", "params": land });
    ws.send(&subscribe);
    let subscription = ws.next()["result"].clone();
    let first = ws.next();
    assert_eq!(first["method"], "mine_status");
    assert_eq!(first["params"]["subscription"], subscription);
    assert_eq!(first["params"]["result"]["state"], "off");
    let started = call("mine_start", start("land", &address, cap))["result"].clone();
    assert_eq!(started["state"], "starting");
    assert_eq!(started["rewardAddress"], json!(address));
    let mut states = Vec::new();
    let found = loop {
        let message = ws.next();
        assert_eq!(message["params"]["subscription"], subscription);
        let result = message["params"]["result"].clone();
        match message["method"].as_str() {
            Some("mine_blockFound") => break result,
            Some("mine_status") => states.push(result["state"].clone()),
            other => panic!("{other:?}"),
        }
    };
    assert!(states.contains(&json!("on")), "{states:?}");
    let id = bytes32(found["hash"].as_str().unwrap());
    let header = (running.call_blocking(move |node, _| node.chain.header(&id).unwrap())).unwrap();
    let header = header.unwrap();
    let expected = json!({
        "id": "land",
        "height": header.height,
        "hash": hex::encode(id),
        "reward": reward(header.height).to_string(),
        "rewardAddress": address,
        "time": header.timestamp,
    });
    assert_eq!(found, expected);
    assert!(mine.won(&id));

    let stopped = call("mine_stop", land)["result"].clone();
    assert_eq!(
        (&stopped["state"], &stopped["threads"]),
        (&json!("off"), &json!(0))
    );
    drop(control);
    assert!(!path.exists(), "the socket goes with its listener");
    drop(mine);
    running.stop().unwrap();
}

fn bytes32(text: &str) -> [u8; 32] {
    hex::decode(text).unwrap().try_into().unwrap()
}

#[test]
fn a_node_that_stopped_cannot_start_its_mine() {
    let (file, dir) = (File::new("control-stopped"), Dir::new("stopped", 0o700));
    let keys = Arc::new(Keys::default());
    let running = dev_node(&file, &keys);
    let mine = Arc::new(Mine::new(running.clone(), keys, 1));
    let path = dir.0.join("control.sock");
    let _control =
        Control::start(running.clone(), mine.clone(), Listen::Unix(path.clone())).unwrap();
    running.stop().unwrap();
    let call = |method: &str, params: Value| {
        let response = post(UnixStream::connect(&path).unwrap(), "", method, params).1;
        (
            response["error"]["code"].clone(),
            response["error"]["message"].clone(),
        )
    };
    let unavailable = (json!(-32002), json!("node-unavailable"));
    assert_eq!(call("node_info", json!([])), unavailable);
    let address = key(1).address().to_string();
    assert_eq!(call("mine_start", start("land", &address, 1)), unavailable);
    assert_eq!(mine.status().state, State::Off);
}

#[test]
fn a_control_socket_is_refused_where_another_could_take_its_place() {
    let (file, keys) = (File::new("control-refused"), Arc::new(Keys::default()));
    let running = dev_node(&file, &keys);
    let mine = Arc::new(Mine::new(running.clone(), keys, 1));
    let bind = |path: PathBuf| {
        let control = Control::start(running.clone(), mine.clone(), Listen::Unix(path));
        control.map(drop).map_err(|error| error.kind())
    };
    let open = Dir::new("open", 0o777);
    assert_eq!(
        bind(open.0.join("control.sock")),
        Err(io::ErrorKind::PermissionDenied)
    );
    let group = Dir::new("group", 0o770);
    assert_eq!(
        bind(group.0.join("control.sock")),
        Err(io::ErrorKind::PermissionDenied)
    );
    // Where others cannot remove what is not theirs, it is fine.
    let sticky = Dir::new("sticky", 0o1777);
    assert_eq!(bind(sticky.0.join("control.sock")), Ok(()));

    let own = Dir::new("own", 0o700);
    let path = own.0.join("control.sock");
    fs::write(&path, "kept").unwrap();
    assert_eq!(bind(path.clone()), Err(io::ErrorKind::AlreadyExists));
    assert_eq!(fs::read_to_string(&path).unwrap(), "kept");
    fs::remove_file(&path).unwrap();
    let live = std::os::unix::net::UnixListener::bind(&path).unwrap();
    assert_eq!(bind(path.clone()), Err(io::ErrorKind::AddrInUse));
    // One left by a listener that is gone is replaced.
    drop(live);
    assert!(path.exists());
    assert_eq!(bind(path), Ok(()));
    drop(mine);
    running.stop().unwrap();
}

#[test]
fn a_tcp_control_listener_checks_the_secret_on_every_request() {
    let (file, keys) = (File::new("control-tcp"), Arc::new(Keys::default()));
    let running = dev_node(&file, &keys);
    let mine = Arc::new(Mine::new(running.clone(), keys, 1));
    let any = SocketAddr::from(([127, 0, 0, 1], 0));
    let short = vec![7; MIN_SECRET - 1];
    let refused = Control::start(running.clone(), mine.clone(), Listen::Tcp(any, short));
    assert!(refused.is_err());
    let secret = vec![7; MIN_SECRET];
    let control = Control::start(
        running.clone(),
        mine.clone(),
        Listen::Tcp(any, secret.clone()),
    );
    let control = control.unwrap();
    let address = control.local_addr().unwrap();
    let call = |headers: &str| {
        let stream = TcpStream::connect(address).unwrap();
        post(stream, headers, "mine_status", json!({ "id": "land" }))
    };
    let bearer = |secret: &[u8]| format!("Authorization: Bearer {}\r\n", hex::encode(secret));
    assert_eq!(call("").0, 401);
    assert_eq!(call(&bearer(&[8; MIN_SECRET])).0, 401);
    assert_eq!(call(&bearer(&secret[1..])).0, 401);
    let (status, body) = call(&bearer(&secret));
    assert_eq!((status, &body["result"]["state"]), (200, &json!("off")));

    // A WebSocket carries it too.
    let ws = |headers: &str| Ws::connect(TcpStream::connect(address).unwrap(), headers);
    let head = ws("").err().unwrap();
    assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    let mut ws = ws(&bearer(&secret)).unwrap();
    let subscribe = json!({ "jsonrpc": "2.0", "id": 1, "method": "mine_subscribe", "params": { "id": "land" } });
    ws.send(&subscribe);
    let subscription = ws.next()["result"].clone();
    let first = ws.next();
    assert_eq!(first["params"]["subscription"], subscription);
    assert_eq!(first["params"]["result"]["state"], "off");
    drop(control);
    drop(mine);
    running.stop().unwrap();
}

#[test]
fn only_the_same_bytes_are_the_same() {
    assert!(same(b"secret", b"secret"));
    assert!(!same(b"secret", b"secreT"));
    assert!(!same(b"secret", b"secre"));
    assert!(same(b"", b""));
}
