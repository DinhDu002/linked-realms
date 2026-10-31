use std::io::{Read, Write};
use std::net::TcpStream;

use jsonrpsee_core::client::{ClientT, Error as ClientError, Subscription, SubscriptionClientT};
use jsonrpsee_core::rpc_params;
use jsonrpsee_ws_client::WsClientBuilder;
use linked_realms_core::issuance::BASE_UNITS_PER_GOLD as GOLD;

use super::*;
use crate::chain::tests::{Builder, File, PARAMS, Test, checkpoint, ledger, nobody, submit_all};
use crate::mempool::tests::{key, pay};
use crate::{Mempool, Policy};

type Hash = fn(&[u8], &[u8; 32]) -> [u8; 32];
type TestNode = Node<Hash>;

/// A Node at work on a database of its own, with its RPC on 127.0.0.1.
struct Served {
    rpc: Rpc,
    running: Arc<Running<Hash>>,
    _file: File,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.running.stop().unwrap();
    }
}

fn serve(file: File, chain: Test, config: Config) -> Served {
    let pool = Mempool::new(PARAMS, Policy::default());
    let node = Node::new(chain, pool, &PARAMS, 0, &[]);
    let running = Arc::new(Running::start(node, Tcp::new(None).unwrap()));
    let config = Config {
        listen: SocketAddr::from(([127, 0, 0, 1], 0)),
        ..config
    };
    let rpc = Rpc::start(running.clone(), PARAMS, &config).unwrap();
    Served {
        rpc,
        running,
        _file: file,
    }
}

/// Sends `request` as it is, and gives back the answer's head and body.
fn http(address: SocketAddr, request: &str) -> (String, String) {
    let mut stream = TcpStream::connect(address).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let (head, body) = answer.split_once("\r\n\r\n").unwrap();
    (head.to_lowercase(), body.to_string())
}

fn request(body: &str) -> String {
    format!(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn post(address: SocketAddr, body: &str) -> (String, Value) {
    let (head, body) = http(address, &request(body));
    (head, serde_json::from_str(&body).unwrap())
}

impl Served {
    fn call(&self, method: &str, params: Value) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        post(self.rpc.local_addr(), &body.to_string()).1
    }

    fn result(&self, method: &str, params: Value) -> Value {
        let answer = self.call(method, params);
        assert!(answer.get("error").is_none(), "{method}: {answer}");
        answer["result"].clone()
    }

    /// The error's code, and its data if it has any.
    fn error(&self, method: &str, params: Value) -> (i64, Value) {
        let answer = self.call(method, params);
        assert!(answer.get("result").is_none(), "{method}: {answer}");
        let error = &answer["error"];
        (error["code"].as_i64().unwrap(), error["data"].clone())
    }

    /// Runs `look` on the Node's thread.
    fn on_node<T: Send + 'static>(
        &self,
        look: impl FnOnce(&mut TestNode, &mut Tcp) -> T + Send + 'static,
    ) -> T {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(self.running.call(look)).unwrap()
    }

    fn ws(&self) -> String {
        format!("ws://{}", self.rpc.local_addr())
    }
}

fn hex_id(block: &Block) -> String {
    hex::encode(block.header.id())
}

fn heights(placed: &Value) -> Vec<u64> {
    placed
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["block"]["height"].as_u64().unwrap())
        .collect()
}

#[test]
fn every_method_answers_on_a_running_node() {
    let file = File::new("rpc-methods");
    let chain = file.open();
    let mut build = Builder::new();
    let miner = key(1);
    let blocks = ledger(&mut build, &miner);
    submit_all(&chain, &blocks);
    let latest = checkpoint(20, blocks[19].header.id());
    chain.add_checkpoint(&latest).unwrap();
    let served = serve(file, chain, Config::default());
    let tip = &blocks[24];

    let info = served.result("lr_getInfo", json!([]));
    let expected = json!({
        "networkId": PARAMS.network_id,
        "genesis": hex::encode(PARAMS.genesis().id()),
        "height": 25,
        "tip": hex_id(tip),
        "time": tip.header.timestamp,
        "latestCheckpoint": { "height": 20, "blockId": hex_id(&blocks[19]) },
        "pruned": 0,
        "archive": true,
        "connections": 0,
    });
    assert_eq!(info, expected);

    let header = served.result("lr_getHeader", json!([25]));
    assert_eq!(header, header_json(&tip.header));
    assert_eq!(header["rewardAddress"], miner.address().to_string());
    assert_eq!(served.result("lr_getHeader", json!([hex_id(tip)])), header);
    assert_eq!(served.result("lr_getHeader", json!([26])), Value::Null);
    let unknown = hex::encode([7; 32]);
    assert_eq!(served.result("lr_getHeader", json!([unknown])), Value::Null);
    let headers = served.result("lr_getHeaders", json!([24, 10]));
    assert_eq!(headers, json!([header_json(&blocks[23].header), header]));
    assert_eq!(
        served.result("lr_getHeaders", json!([0, 3]))[0]["height"],
        0
    );
    assert_eq!(served.result("lr_getHeaders", json!([0, 0])), json!([]));
    assert_eq!(served.result("lr_getHeaders", json!([26, 5])), json!([]));

    // The Accounts each Block created: the miner's in Block 1, a payee's in Blocks 15 and 22.
    let counts = served.result("lr_getNewAccountCounts", json!([0, 30]));
    let counted: Vec<_> = counts
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["newAccounts"].clone())
        .collect();
    let mut expected = vec![json!(0); 26];
    expected[0] = Value::Null;
    for height in [1, 15, 22] {
        expected[height] = json!(1);
    }
    assert_eq!(counted, expected);
    assert_eq!(counts[15]["id"], hex_id(&blocks[14]));
    assert_eq!(
        served.result("lr_getNewAccountCounts", json!([22, 2])),
        json!([
            { "id": hex_id(&blocks[21]), "newAccounts": 1 },
            { "id": hex_id(&blocks[22]), "newAccounts": 0 },
        ])
    );
    assert_eq!(
        served.result("lr_getNewAccountCounts", json!([26, 5])),
        json!([])
    );

    let block = served.result("lr_getBlock", json!([15]));
    assert_eq!(block, block_json(&PARAMS, &blocks[14]));
    let paid = &block["txs"][0];
    assert_eq!(paid["kind"], "transfer");
    assert_eq!(paid["to"], nobody(5).to_string());
    assert_eq!(paid["amount"], "1000");
    assert_eq!(paid["fee"], "10");
    assert_eq!(
        served.result("lr_getBlock", json!([hex_id(&blocks[14])])),
        block
    );
    assert_eq!(served.result("lr_getBlock", json!([26])), Value::Null);

    let account = served.result("lr_getAccount", json!([nobody(5).to_string()]));
    assert_eq!(
        account,
        json!({ "balance": "1000", "nonce": 0, "hasKey": false })
    );
    let nobody9 = nobody(9).to_string();
    assert_eq!(
        served.result("lr_getAccount", json!([nobody9])),
        Value::Null
    );

    let tx = &blocks[14].txs[0];
    let found = served.result("lr_getTransaction", json!([hex::encode(tx.id(&PARAMS))]));
    let place = json!({ "id": hex_id(&blocks[14]), "height": 15, "place": 0 });
    assert_eq!(found, json!({ "tx": tx_json(&PARAMS, tx), "block": place }));
    let sender = miner.address().to_string();
    let sent = served.result("lr_getAddressTxs", json!([sender]));
    assert_eq!(heights(&sent), [22, 15]);
    let older = served.result("lr_getAddressTxs", json!([sender, sent[0]["block"]]));
    assert_eq!(heights(&older), [15]);

    // A transfer sent: held, found, and counted in its sender's account with the mempool.
    let held = pay(&miner, 2, nobody(7), GOLD, 10);
    let bytes = hex::encode(held.to_bytes());
    let id = served.result("lr_sendTransaction", json!([bytes]));
    assert_eq!(id, hex::encode(held.id(&PARAMS)));
    // Sent again, it is the same transaction.
    assert_eq!(served.result("lr_sendTransaction", json!([bytes])), id);
    let found = served.result("lr_getTransaction", json!([id]));
    assert_eq!(
        found,
        json!({ "tx": tx_json(&PARAMS, &held), "block": null })
    );
    let nonce = |with: Value| served.result("lr_getAccount", with)["nonce"].clone();
    assert_eq!(nonce(json!([sender])), 2);
    assert_eq!(nonce(json!([sender, false])), 2);
    assert_eq!(nonce(json!([sender, true])), 3);
    // An address with nothing held reads as on the chain.
    let five = nobody(5).to_string();
    assert_eq!(served.result("lr_getAccount", json!([five, true])), account);
    let policy = Policy::default();
    let expected = json!({
        "count": 1,
        "bytes": held.to_bytes().len(),
        "maxBytes": policy.max_bytes,
        "minFeeRate": "10",
        "dust": policy.dust.to_string(),
    });
    assert_eq!(served.result("lr_getMempoolInfo", json!([])), expected);
    assert_eq!(served.result("lr_estimateFee", json!([])), "10");

    let expected = json!({
        "height": 20,
        "blockId": hex_id(&blocks[19]),
        "signature": hex::encode(latest.signature),
    });
    assert_eq!(served.result("lr_getCheckpoint", json!([])), expected);
    // A lower one is taken, and the latest stays.
    let lower = checkpoint(10, blocks[9].header.id());
    let given = json!([{
        "height": 10,
        "blockId": hex_id(&blocks[9]),
        "signature": hex::encode(lower.signature),
    }]);
    assert_eq!(served.result("lr_submitCheckpoint", given), true);
    assert_eq!(served.result("lr_getCheckpoint", json!([])), expected);
}

#[test]
fn a_checkpoint_sent_over_rpc_is_checked_and_held_until_its_block_comes() {
    let file = File::new("rpc-checkpoint");
    let chain = file.open();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let main = build.branch(&genesis, nobody(1), 12);
    let other = build.branch(&genesis, nobody(2), 10);
    submit_all(&chain, &main);
    let served = serve(file, chain, Config::default());
    let give = |c: &Checkpoint| {
        let given = json!([{
            "height": c.height,
            "blockId": hex::encode(c.block_id),
            "signature": hex::encode(c.signature),
        }]);
        served.call("lr_submitCheckpoint", given)
    };
    let tip = || served.result("lr_getInfo", json!([]))["tip"].clone();

    let mut forged = checkpoint(10, other[9].header.id());
    forged.signature[0] ^= 1;
    assert_eq!(give(&forged)["error"]["code"], INVALID_INPUT);
    assert_eq!(served.result("lr_getCheckpoint", json!([])), Value::Null);
    assert_eq!(tip(), hex_id(&main[11]));
    let short = json!([{ "height": 10, "blockId": hex_id(&other[9]), "signature": "00" }]);
    assert_eq!(served.error("lr_submitCheckpoint", short).0, -32602);

    // One for a Block not known yet is taken: the branch that contradicts it ends below it,
    // and the Checkpoint's branch is the best once its Blocks come.
    let good = checkpoint(10, other[9].header.id());
    assert_eq!(give(&good)["result"], true);
    assert_eq!(tip(), hex_id(&main[8]));
    served.on_node(move |node, _| submit_all(&node.chain, &other));
    let tip = tip();
    let latest = served.result("lr_getCheckpoint", json!([]));
    assert_eq!(latest["blockId"], tip);
}

#[test]
fn the_errors_have_their_codes() {
    let file = File::new("rpc-errors");
    let chain = file.open().pruning(2);
    let mut build = Builder::new();
    let miner = key(1);
    let blocks = ledger(&mut build, &miner);
    submit_all(&chain, &blocks);
    chain
        .add_checkpoint(&checkpoint(20, blocks[19].header.id()))
        .unwrap();
    let served = serve(file, chain, Config::default());
    let address = served.rpc.local_addr();

    assert_eq!(post(address, "{nope").1["error"]["code"], -32700);
    assert_eq!(served.error("lr_nope", json!([])).0, -32601);
    for (method, params) in [
        ("lr_getAccount", json!(["lr1nope"])),
        ("lr_getAccount", json!([])),
        ("lr_getBlock", json!(["1234"])),
        ("lr_getHeaders", json!([1])),
        ("lr_getNewAccountCounts", json!([1])),
        (
            "lr_getAddressTxs",
            json!([nobody(1).to_string(), { "height": 1 }]),
        ),
        ("lr_sendTransaction", json!(["zz"])),
        ("lr_sendTransaction", json!(["00"])),
        ("lr_subscribeBlocks", json!([])),
    ] {
        let code = served.error(method, params.clone()).0;
        // jsonrpsee answers a subscription over HTTP with an internal error.
        let expected = if method == "lr_subscribeBlocks" {
            -32603
        } else {
            -32602
        };
        assert_eq!(code, expected, "{method} {params}");
    }

    // A body this pruning Node no longer holds.
    let info = served.result("lr_getInfo", json!([]));
    assert_eq!(
        (info["pruned"].clone(), info["archive"].clone()),
        (json!(18), json!(false))
    );
    assert_eq!(
        served.error("lr_getBlock", json!([5])).0,
        RESOURCE_UNAVAILABLE as i64
    );
    let pruned = hex_id(&blocks[4]);
    assert_eq!(
        served.error("lr_getBlock", json!([pruned])).0,
        RESOURCE_UNAVAILABLE as i64
    );
    assert!(served.result("lr_getBlock", json!([25])).is_object());
    // ... nor its undo record, so it cannot count the Accounts that Block created.
    assert_eq!(
        served.result("lr_getNewAccountCounts", json!([18, 5])),
        json!([
            { "id": hex_id(&blocks[17]), "newAccounts": null },
            { "id": hex_id(&blocks[18]), "newAccounts": 0 },
            { "id": hex_id(&blocks[19]), "newAccounts": 0 },
            { "id": hex_id(&blocks[20]), "newAccounts": 0 },
            { "id": hex_id(&blocks[21]), "newAccounts": 1 },
        ])
    );

    // Each refusal of the mempool, with its reason.
    let mut cheap = pay(&miner, 2, nobody(7), GOLD, 10);
    cheap.fee -= 1;
    cheap.sign(&PARAMS, &miner, &[0; 32]).unwrap();
    let mut forged = pay(&miner, 2, nobody(7), GOLD, 10);
    forged.signature[0] ^= 1;
    for (tx, reason) in [
        (cheap, "fee-too-low"),
        (pay(&miner, 3, nobody(7), GOLD, 10), "nonce-gap"),
        (pay(&miner, 2, nobody(7), 1, 10), "dust"),
        (forged, "rule"),
    ] {
        let sent = json!([hex::encode(tx.to_bytes())]);
        let (code, data) = served.error("lr_sendTransaction", sent);
        assert_eq!(
            (code, data),
            (TRANSACTION_REJECTED as i64, json!({ "reason": reason }))
        );
    }

    // A batch is not served.
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "lr_getInfo", "params": [] });
    let batch = json!([call, call]).to_string();
    assert_eq!(post(address, &batch).1["error"]["code"], LIMIT_EXCEEDED);
}

#[test]
fn each_client_has_a_limited_number_of_calls() {
    let file = File::new("rpc-limit");
    let chain = file.open();
    let config = Config {
        per_second: 1,
        burst: 3,
        ..Config::default()
    };
    let served = serve(file, chain, config);
    for _ in 0..3 {
        served.result("lr_getInfo", json!([]));
    }
    let answer = served.call("lr_getInfo", json!([]));
    assert_eq!(answer["error"]["code"], LIMIT_EXCEEDED);
    assert_eq!(answer["id"], 1);
    // Over a WebSocket too, a second later: one call came back.
    std::thread::sleep(Duration::from_millis(1_100));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let client = WsClientBuilder::default().build(served.ws()).await.unwrap();
        let info: Result<Value, _> = client.request("lr_getInfo", rpc_params![]).await;
        assert!(info.is_ok());
        let info: Result<Value, _> = client.request("lr_getInfo", rpc_params![]).await;
        assert!(matches!(info, Err(ClientError::Call(e)) if e.code() == LIMIT_EXCEEDED));
    });
}

#[test]
fn behind_a_trusted_proxy_the_client_is_the_one_it_names() {
    let ip = |text: &str| text.parse::<IpAddr>().unwrap();
    let proxies = [ip("172.30.0.10"), ip("10.0.0.1")];
    let client = |peer: &str, forwarded: &str| client_of(ip(peer), forwarded, &proxies);
    assert_eq!(client("1.2.3.4", "5.6.7.8"), ip("1.2.3.4"), "not a proxy");
    assert_eq!(client("172.30.0.10", "5.6.7.8"), ip("5.6.7.8"));
    assert_eq!(client("::ffff:172.30.0.10", "5.6.7.8"), ip("5.6.7.8"));
    assert_eq!(
        client("172.30.0.10", "9.9.9.9, 5.6.7.8"),
        ip("5.6.7.8"),
        "what the client sent is left of it"
    );
    assert_eq!(
        client("172.30.0.10", "9.9.9.9,10.0.0.1"),
        ip("9.9.9.9"),
        "through two proxies"
    );
    assert_eq!(client("172.30.0.10", "2001:db8::1"), ip("2001:db8::1"));
    assert_eq!(client("172.30.0.10", ""), ip("172.30.0.10"));
    assert_eq!(client("172.30.0.10", "junk"), ip("172.30.0.10"));
    assert_eq!(client("172.30.0.10", "5.6.7.8, junk"), ip("172.30.0.10"));
    assert_eq!(
        client_of(ip("172.30.0.10"), "5.6.7.8", &[]),
        ip("172.30.0.10"),
        "no proxy set"
    );
}

#[test]
fn a_proxy_s_clients_each_have_their_own_calls() {
    let file = File::new("rpc-proxy");
    let chain = file.open();
    let config = Config {
        per_second: 1,
        burst: 2,
        proxies: vec!["127.0.0.1".parse().unwrap()],
        ..Config::default()
    };
    let served = serve(file, chain, config);
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "lr_getInfo", "params": [] });
    let from = |client: &str| {
        let request = request(&body.to_string()).replacen(
            "Host: localhost\r\n",
            &format!("Host: localhost\r\nX-Forwarded-For: {client}\r\n"),
            1,
        );
        let (_, answer) = http(served.rpc.local_addr(), &request);
        serde_json::from_str::<Value>(&answer).unwrap()["error"]["code"].clone()
    };
    assert_eq!(from("5.6.7.8"), Value::Null);
    assert_eq!(from("5.6.7.8"), Value::Null);
    assert_eq!(from("5.6.7.8"), LIMIT_EXCEEDED);
    assert_eq!(
        from("5.6.7.9"),
        Value::Null,
        "another client behind the same proxy"
    );
}

#[test]
fn the_calls_left_fill_again_and_count_an_ipv6_host_once() {
    let clients = Clients {
        per_second: 2,
        burst: 3,
        left: Mutex::new(HashMap::new()),
    };
    let ip = |text: &str| text.parse::<IpAddr>().unwrap();
    let start = Instant::now();
    let at = |ms: u64| start + Duration::from_millis(ms);
    assert!(clients.take(ip("10.0.0.1"), 3, at(0)));
    assert!(!clients.take(ip("10.0.0.1"), 1, at(0)));
    // The same client through a dual-stack listener.
    assert!(!clients.take(ip("::ffff:10.0.0.1"), 1, at(0)));
    assert!(clients.take(ip("10.0.0.2"), 1, at(0)));
    // Two a second, never more than the burst.
    assert!(clients.take(ip("10.0.0.1"), 1, at(500)));
    assert!(!clients.take(ip("10.0.0.1"), 1, at(500)));
    assert!(clients.take(ip("10.0.0.1"), 3, at(100_000)));
    assert!(!clients.take(ip("10.0.0.1"), 1, at(100_000)));
    // A refused call takes nothing.
    assert!(!clients.take(ip("10.0.0.2"), 3, at(0)));
    assert!(clients.take(ip("10.0.0.2"), 2, at(0)));
    // One IPv6 /64 is one client.
    assert!(clients.take(ip("2001:db8::1"), 3, at(0)));
    assert!(!clients.take(ip("2001:db8::ffff:0:0:1"), 1, at(0)));
    assert!(clients.take(ip("2001:db8:0:1::1"), 1, at(0)));

    // Past `MAX_CLIENTS`, a new client takes the place of one whose calls filled again, or
    // waits for one.
    let busy = |from: usize, to: usize| {
        for i in from..to {
            let ip = IpAddr::from([11, (i >> 16) as u8, (i >> 8) as u8, i as u8]);
            assert!(clients.take(ip, 1, at(100_000)));
        }
    };
    let held = || clients.left.lock().unwrap().len();
    busy(held(), MAX_CLIENTS);
    // 10.0.0.2 and the two IPv6 hosts are full again, so they go.
    assert!(clients.take(ip("12.0.0.1"), 1, at(100_000)));
    assert_eq!(held(), MAX_CLIENTS - 2);
    busy(MAX_CLIENTS, MAX_CLIENTS + 2);
    assert!(!clients.take(ip("12.0.0.2"), 1, at(100_000)));
    // One already known is never turned away for room.
    assert!(clients.take(ip("12.0.0.1"), 1, at(100_000)));
    assert!(clients.take(ip("12.0.0.2"), 1, at(101_000)));
    assert!(held() < MAX_CLIENTS);
}

#[test]
fn no_admin_method_is_on_the_public_listener() {
    let file = File::new("rpc-admin");
    let chain = file.open();
    let served = serve(file, chain, Config::default());
    for method in [
        "node_info",
        "mine_status",
        "mine_start",
        "mine_stop",
        "mine_subscribe",
        "lr_getConnections",
        "lr_addNode",
        "rpc_methods",
    ] {
        assert_eq!(served.error(method, json!([])).0, -32601, "{method}");
    }
    let context = Context {
        running: served.running.clone(),
        params: PARAMS,
    };
    let module = methods(context).unwrap();
    let mut names: Vec<&str> = module.method_names().collect();
    names.sort_unstable();
    let expected = [
        "lr_estimateFee",
        "lr_getAccount",
        "lr_getAddressTxs",
        "lr_getBlock",
        "lr_getCheckpoint",
        "lr_getHeader",
        "lr_getHeaders",
        "lr_getInfo",
        "lr_getMempoolInfo",
        "lr_getNewAccountCounts",
        "lr_getTransaction",
        "lr_sendTransaction",
        "lr_submitCheckpoint",
        "lr_subscribeAddress",
        "lr_subscribeBlocks",
        "lr_unsubscribeAddress",
        "lr_unsubscribeBlocks",
    ];
    assert_eq!(names, expected);
}

#[test]
fn browsers_may_call_from_any_origin() {
    let file = File::new("rpc-cors");
    let chain = file.open();
    let served = serve(file, chain, Config::default());
    let address = served.rpc.local_addr();
    let preflight = "OPTIONS / HTTP/1.1\r\nHost: localhost\r\nOrigin: https://land.example\r\n\
                     Access-Control-Request-Method: POST\r\nConnection: close\r\n\r\n";
    let (head, _) = http(address, preflight);
    assert!(head.starts_with("http/1.1 204"), "{head}");
    for line in [
        "access-control-allow-origin: *",
        "access-control-allow-methods: post, options",
        "access-control-allow-headers: content-type",
        "access-control-max-age: 86400",
    ] {
        assert!(head.contains(line), "{line} in {head}");
    }
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "lr_getInfo", "params": [] });
    let (head, answer) = post(address, &call.to_string());
    assert!(head.contains("access-control-allow-origin: *"), "{head}");
    assert_eq!(answer["result"]["height"], 0);
}

/// A subscription's next item, within 5 seconds.
async fn next(subscription: &mut Subscription<Value>) -> Value {
    let next = tokio::time::timeout(Duration::from_secs(5), subscription.next()).await;
    next.expect("in time").unwrap().unwrap()
}

#[test]
fn subscriptions_tell_of_new_blocks_and_of_an_address_s_transactions() {
    let file = File::new("rpc-subscribe");
    let chain = file.open();
    let mut build = Builder::new();
    let blocks = ledger(&mut build, &key(1));
    submit_all(&chain, &blocks[..20]);
    let served = serve(file, chain, Config::default());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let client = WsClientBuilder::default().build(served.ws()).await.unwrap();
        let submit = |from: usize, to: usize| {
            let some = blocks[from..to].to_vec();
            served
                .running
                .call(move |node, _| submit_all(&node.chain, &some))
        };
        let mut joined: Subscription<Value> = client
            .subscribe("lr_subscribeBlocks", rpc_params![], "lr_unsubscribeBlocks")
            .await
            .unwrap();
        // One subscriber is enough to hear of a Block.
        submit(20, 21).await.unwrap();
        assert_eq!(next(&mut joined).await, header_json(&blocks[20].header));

        let watched = nobody(6).to_string();
        let mut paid: Subscription<Value> = client
            .subscribe(
                "lr_subscribeAddress",
                rpc_params![watched],
                "lr_unsubscribeAddress",
            )
            .await
            .unwrap();
        let bad: Result<Subscription<Value>, _> = client
            .subscribe(
                "lr_subscribeAddress",
                rpc_params!["lr1nope"],
                "lr_unsubscribeAddress",
            )
            .await;
        assert!(matches!(bad, Err(ClientError::Call(e)) if e.code() == -32602));

        submit(21, blocks.len()).await.unwrap();
        for block in &blocks[21..] {
            assert_eq!(next(&mut joined).await, header_json(&block.header));
        }
        let placed = Placed {
            tx: blocks[21].txs[0].clone(),
            block: blocks[21].header.id(),
            height: 22,
            place: 0,
        };
        assert_eq!(next(&mut paid).await, placed_json(&PARAMS, &placed));
    });
}

#[test]
fn a_subscription_ends_when_the_node_stops() {
    let file = File::new("rpc-stopped");
    let chain = file.open();
    let served = serve(file, chain, Config::default());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let client = WsClientBuilder::default().build(served.ws()).await.unwrap();
        let blocks =
            || client.subscribe("lr_subscribeBlocks", rpc_params![], "lr_unsubscribeBlocks");
        let mut joined: Subscription<Value> = blocks().await.unwrap();
        served.running.stop().unwrap();
        let next = tokio::time::timeout(Duration::from_secs(5), joined.next()).await;
        let next = next.expect("told, not left waiting");
        assert!(!matches!(next, Some(Ok(_))), "{next:?}");
        let late: Result<Subscription<Value>, _> = blocks().await;
        assert!(matches!(late, Err(ClientError::Call(e)) if e.code() == -32603));
    });
}

#[test]
fn idle_sockets_wait_past_twice_the_connections() {
    let file = File::new("rpc-sockets");
    let chain = file.open();
    let config = Config {
        max_connections: 1,
        ..Config::default()
    };
    let served = serve(file, chain, config);
    let address = served.rpc.local_addr();
    let idle: Vec<TcpStream> = (0..2)
        .map(|_| TcpStream::connect(address).unwrap())
        .collect();
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "lr_getInfo", "params": [] });
    let mut waiting = TcpStream::connect(address).unwrap();
    waiting
        .write_all(request(&call.to_string()).as_bytes())
        .unwrap();
    waiting
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    assert!(waiting.read(&mut [0; 1]).is_err(), "not accepted yet");
    drop(idle);
    waiting
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut answer = String::new();
    waiting.read_to_string(&mut answer).unwrap();
    assert!(answer.contains("\"height\":0"), "{answer}");
}
