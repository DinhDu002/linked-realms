use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use linked_realms_core::SigningKey;
use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::issuance::BASE_UNITS_PER_GOLD as GOLD;
use linked_realms_core::keccak256;
use linked_realms_core::params::{DEV_CHECKPOINT_SEED, TESTNET};

use super::*;
use crate::Policy;
use crate::chain::tests::{Builder, File, PARAMS, Test, balance, nobody, submit_all};
use crate::mempool::tests::{key, pay};

type TestNode = Node<fn(&[u8], &[u8; 32]) -> [u8; 32]>;

fn node(file: &File, listen: u16, seeds: &[SocketAddr]) -> TestNode {
    let chain: Test = file.open();
    Node::new(
        chain,
        Mempool::new(PARAMS, Policy::default()),
        &PARAMS,
        listen,
        seeds,
    )
}

/// Where Node `i` of a `Mesh` takes connections.
fn address(i: usize) -> SocketAddr {
    SocketAddr::from(([10, 0, 0, i as u8 + 1], 9444))
}

/// Connections in memory between the Nodes of a `Mesh`; frames wait in one queue, in order.
#[derive(Default)]
struct Wires {
    nodes: usize,
    /// Each end of a connection, `(Node, peer)`, to its other end.
    links: HashMap<(usize, PeerId), (usize, PeerId)>,
    queue: VecDeque<(usize, Event)>,
    next_peer: PeerId,
}

/// The `Network` as Node `from` sees it.
struct Wire<'a> {
    from: usize,
    wires: &'a mut Wires,
}

impl Network for Wire<'_> {
    fn send(&mut self, peer: PeerId, frame: Vec<u8>) {
        if let Some(&(to, theirs)) = self.wires.links.get(&(self.from, peer)) {
            let event = Event::Received {
                peer: theirs,
                bytes: frame,
            };
            self.wires.queue.push_back((to, event));
        }
    }

    fn disconnect(&mut self, peer: PeerId) {
        if let Some((to, theirs)) = self.wires.links.remove(&(self.from, peer)) {
            self.wires.links.remove(&(to, theirs));
            let event = Event::Disconnected { peer: theirs };
            self.wires.queue.push_back((to, event));
        }
    }

    fn dial(&mut self, to: SocketAddr) {
        let Some(node) = (0..self.wires.nodes).find(|i| address(*i) == to) else {
            return;
        };
        let (mine, theirs) = (self.wires.next_peer, self.wires.next_peer + 1);
        self.wires.next_peer += 2;
        self.wires.links.insert((self.from, mine), (node, theirs));
        self.wires.links.insert((node, theirs), (self.from, mine));
        let outbound = Event::Connected {
            peer: mine,
            address: to,
            outbound: true,
        };
        let inbound = Event::Connected {
            peer: theirs,
            address: SocketAddr::new(address(self.from).ip(), 40_000 + mine as u16),
            outbound: false,
        };
        self.wires.queue.push_back((self.from, outbound));
        self.wires.queue.push_back((node, inbound));
    }
}

/// Nodes joined in memory, all on one clock.
struct Mesh {
    nodes: Vec<TestNode>,
    wires: Wires,
    now: u64,
    _files: Vec<File>,
}

impl Mesh {
    /// `n` Nodes; each `(i, j)` of `seeds` makes Node `j` a seed of Node `i`.
    fn new(name: &str, n: usize, seeds: &[(usize, usize)]) -> Self {
        let files: Vec<File> = (0..n).map(|i| File::new(&format!("{name}-{i}"))).collect();
        let nodes = files
            .iter()
            .enumerate()
            .map(|(i, file)| {
                let seeds: Vec<_> = seeds
                    .iter()
                    .filter(|(from, _)| *from == i)
                    .map(|(_, to)| address(*to))
                    .collect();
                node(file, 9444, &seeds)
            })
            .collect();
        Mesh {
            nodes,
            wires: Wires {
                nodes: n,
                ..Wires::default()
            },
            now: PARAMS.genesis().timestamp,
            _files: files,
        }
    }

    /// Delivers every frame, and the ones they bring, until none is left.
    fn run(&mut self) {
        let mut steps = 0;
        while let Some((i, event)) = self.wires.queue.pop_front() {
            steps += 1;
            assert!(steps < 100_000, "the Nodes never settle");
            let mut wire = Wire {
                from: i,
                wires: &mut self.wires,
            };
            self.nodes[i].handle(&mut wire, event, self.now).unwrap();
        }
    }

    fn tick(&mut self) {
        for i in 0..self.nodes.len() {
            let mut wire = Wire {
                from: i,
                wires: &mut self.wires,
            };
            self.nodes[i].tick(&mut wire, self.now).unwrap();
        }
        self.run();
    }

    /// Runs `act` on Node `i`, then delivers what it sent.
    fn with<T>(&mut self, i: usize, act: impl FnOnce(&mut TestNode, &mut Wire) -> T) -> T {
        let mut wire = Wire {
            from: i,
            wires: &mut self.wires,
        };
        let done = act(&mut self.nodes[i], &mut wire);
        self.run();
        done
    }

    fn tip(&self, i: usize) -> [u8; 32] {
        self.nodes[i].chain.tip().unwrap().id()
    }

    /// Whether Node `i` holds a connection with Node `to`, whichever dialed.
    fn connected(&self, i: usize, to: usize) -> bool {
        let ip = address(to).ip();
        self.nodes[i].peers.values().any(|p| p.address.ip() == ip)
    }
}

/// What a Node sent, read back, and what it dropped and dialed.
#[derive(Default)]
struct Recorder {
    sent: Vec<(PeerId, Message)>,
    dropped: Vec<PeerId>,
}

impl Network for Recorder {
    fn send(&mut self, peer: PeerId, mut frame: Vec<u8>) {
        let message = message::next_frame(&mut frame, PARAMS.magic()).unwrap();
        self.sent.push((peer, message.unwrap().unwrap()));
    }

    fn disconnect(&mut self, peer: PeerId) {
        self.dropped.push(peer);
    }

    fn dial(&mut self, _: SocketAddr) {}
}

fn frame(message: &Message) -> Vec<u8> {
    message.to_frame(PARAMS.magic())
}

fn connect(node: &mut TestNode, net: &mut Recorder, peer: PeerId, from: SocketAddr, now: u64) {
    let event = Event::Connected {
        peer,
        address: from,
        outbound: false,
    };
    node.handle(net, event, now).unwrap();
}

fn receive(node: &mut TestNode, net: &mut Recorder, peer: PeerId, bytes: Vec<u8>, now: u64) {
    node.handle(net, Event::Received { peer, bytes }, now)
        .unwrap();
}

/// Connects `peer` from `from` and goes through `version` and `verack`.
fn greet(node: &mut TestNode, net: &mut Recorder, peer: PeerId, from: SocketAddr, now: u64) {
    connect(node, net, peer, from, now);
    let version = Version {
        version: message::PROTOCOL_VERSION,
        genesis: PARAMS.genesis().id(),
        height: 0,
        listen: 0,
        nonce: 7,
    };
    receive(node, net, peer, frame(&Message::Version(version)), now);
    receive(node, net, peer, frame(&Message::Verack), now);
}

#[test]
fn every_message_reads_back_and_a_bad_frame_does_not() {
    let magic = PARAMS.magic();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let block = build.child(&genesis, key(1).address(), Vec::new());
    let signer = SigningKey::from_seed(&DEV_CHECKPOINT_SEED);
    let checkpoint = Checkpoint::sign(&PARAMS, &signer, 10, block.header.id(), &[0; 32]).unwrap();
    let version = Version {
        version: message::PROTOCOL_VERSION,
        genesis: genesis.header.id(),
        height: 7,
        listen: 9444,
        nonce: u64::MAX,
    };
    let messages = [
        Message::Version(version),
        Message::Verack,
        Message::Ping(1),
        Message::Pong(2),
        Message::Inv(vec![[1; 32]]),
        Message::GetData(vec![[2; 32]; MAX_IDS]),
        Message::NotFound(Vec::new()),
        Message::GetHeaders(vec![[3; 32]; message::MAX_LOCATOR]),
        Message::Headers(vec![genesis.header, block.header]),
        Message::Block(block),
        Message::Tx(pay(&key(1), 0, nobody(2), GOLD, 10)),
        Message::Checkpoint(Box::new(checkpoint)),
        Message::GetCheckpoint,
        Message::GetNodes,
        Message::Nodes(vec![address(0), "[2001:db8::1]:9444".parse().unwrap()]),
    ];
    let mut stream: Vec<u8> = messages.iter().flat_map(|m| m.to_frame(magic)).collect();
    // A frame not all come waits for the rest.
    let mut part = stream[..message::FRAME_HEADER_LEN + 3].to_vec();
    assert_eq!(message::next_frame(&mut part, magic), Ok(None));
    for message in messages {
        assert_eq!(
            message::next_frame(&mut stream, magic),
            Ok(Some(Some(message)))
        );
    }
    assert_eq!(message::next_frame(&mut stream, magic), Ok(None));

    let raw = |command: u8, payload: &[u8]| {
        let mut frame = magic.to_vec();
        frame.push(command);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&keccak256(&[payload])[..4]);
        frame.extend_from_slice(payload);
        frame
    };
    // A command a later version may add is skipped.
    assert_eq!(
        message::next_frame(&mut raw(200, b"new"), magic),
        Ok(Some(None))
    );
    let mut bad = Message::Ping(9).to_frame(magic);
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(
        message::next_frame(&mut bad, magic),
        Err(Malformed::Checksum)
    );
    let extra = [9u64.to_be_bytes().as_slice(), &[0]].concat();
    assert_eq!(
        message::next_frame(&mut raw(2, &extra), magic),
        Err(Malformed::Payload)
    );
    let too_many = [
        ((MAX_IDS + 1) as u16).to_be_bytes().as_slice(),
        &[0; 32 * (MAX_IDS + 1)],
    ]
    .concat();
    assert_eq!(
        message::next_frame(&mut raw(5, &too_many), magic),
        Err(Malformed::Payload)
    );
    let other = Message::Verack.to_frame(TESTNET.magic());
    assert_eq!(
        message::next_frame(&mut other.clone(), magic),
        Err(Malformed::Magic)
    );
}

#[test]
fn three_nodes_find_each_other_converge_and_relay() {
    // Node 1 knows Node 0, Node 2 knows Node 1 only.
    let mut mesh = Mesh::new("p2p-converge", 3, &[(1, 0), (2, 1)]);
    let mut build = Builder::new();
    let genesis = build.genesis();
    let miner = key(1);
    let ours = build.branch(&genesis, miner.address(), 5);
    let theirs = build.branch(&genesis, nobody(7), 3);
    mesh.with(0, |node, net| {
        ours.iter().for_each(|b| node.mined(net, b).unwrap())
    });
    mesh.with(1, |node, net| {
        theirs.iter().for_each(|b| node.mined(net, b).unwrap())
    });
    mesh.now = ours[4].header.timestamp;

    mesh.tick();
    // Node 2 heard of Node 0 from Node 1, and of itself.
    assert!(!mesh.connected(2, 0));
    mesh.tick();
    assert!(mesh.connected(2, 0) && mesh.connected(0, 2));
    assert!(mesh.nodes[2].own.contains(&address(2)));
    for i in 0..3 {
        assert_eq!(mesh.tip(i), ours[4].header.id(), "Node {i}");
    }

    // A transaction sent to Node 2 reaches every mempool, and Node 1 mines it.
    let tx = pay(&miner, 0, nobody(9), GOLD, 10);
    mesh.with(2, |node, net| {
        node.send_tx(net, tx.clone()).unwrap().unwrap()
    });
    let mut held = Vec::new();
    for node in &mut mesh.nodes {
        held.push(
            node.pool
                .template(&node.chain, nobody(8), mesh.now)
                .unwrap(),
        );
        assert_eq!(held.last().unwrap().txs, std::slice::from_ref(&tx));
    }
    let mut block = held.swap_remove(1);
    block.header.nonce = 1;
    mesh.with(1, |node, net| node.mined(net, &block).unwrap());
    for node in &mesh.nodes {
        assert_eq!(node.chain.tip().unwrap(), block.header);
        assert_eq!(balance(&node.chain, &nobody(9)), Some(GOLD));
    }
}

#[test]
fn a_block_ahead_of_the_clock_waits_for_it() {
    // Node 1 knows Node 0; Node 2 joins later.
    let mut mesh = Mesh::new("p2p-clock", 3, &[(1, 0)]);
    let mut build = Builder::new();
    let genesis = build.genesis();
    let b1 = build.child(&genesis, nobody(1), Vec::new());
    mesh.with(0, |node, net| node.mined(net, &b1).unwrap());
    mesh.now = b1.header.timestamp;
    mesh.tick();
    assert_eq!(mesh.tip(1), b1.header.id());

    // As a tip: a second past the limit.
    let ahead = build.stamped(&b1, nobody(1), mesh.now + MAX_AHEAD + 1);
    mesh.with(0, |node, net| node.mined(net, &ahead).unwrap());
    assert_eq!(mesh.tip(0), ahead.header.id());
    assert_eq!(mesh.tip(1), b1.header.id());
    // As the parent of a Block stamped at the real time.
    let child = build.stamped(&ahead, nobody(1), mesh.now + 1);
    mesh.with(0, |node, net| node.mined(net, &child).unwrap());
    assert_eq!(mesh.tip(1), b1.header.id());
    // During sync.
    mesh.with(2, |_, net| net.dial(address(0)));
    assert_eq!(mesh.tip(2), b1.header.id());
    // Nothing is held against Node 0.
    mesh.tick();
    assert!(mesh.connected(1, 0) && mesh.connected(2, 0));
    assert_eq!((mesh.tip(1), mesh.tip(2)), (b1.header.id(), b1.header.id()));

    // Taken once the clock catches up.
    mesh.now = ahead.header.timestamp - MAX_AHEAD;
    // Nodes 1 and 2 found each other too; each tick asks one peer, in turn.
    assert!(mesh.connected(1, 2));
    mesh.tick();
    mesh.tick();
    assert_eq!(
        (mesh.tip(1), mesh.tip(2)),
        (child.header.id(), child.header.id())
    );
}

#[test]
fn an_oversize_frame_bans_the_ip_address_for_a_day() {
    let file = File::new("p2p-oversize");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    let from = |port| SocketAddr::from(([10, 0, 0, 9], port));
    connect(&mut node, &mut net, 1, from(5000), now);
    let mut header = PARAMS.magic().to_vec();
    header.push(0);
    header.extend_from_slice(&(MAX_PAYLOAD as u32 + 1).to_be_bytes());
    header.extend_from_slice(&[0; 4]);
    // Refused on its header, before the payload comes.
    receive(&mut node, &mut net, 1, header, now);
    assert_eq!(net.dropped, [1]);

    connect(&mut node, &mut net, 2, from(5001), now);
    assert_eq!(net.dropped, [1, 2]);
    assert!(net.sent.iter().all(|(peer, _)| *peer == 1));

    node.tick(&mut net, now + BAN_SECONDS).unwrap();
    connect(&mut node, &mut net, 3, from(5002), now + BAN_SECONDS);
    assert_eq!(net.dropped, [1, 2]);
    assert!(matches!(net.sent.last(), Some((3, Message::Version(_)))));
}

#[test]
fn another_network_is_dropped_not_banned() {
    let file = File::new("p2p-magic");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    let from = SocketAddr::from(([10, 0, 0, 9], 5000));
    connect(&mut node, &mut net, 1, from, now);
    receive(
        &mut node,
        &mut net,
        1,
        Message::Verack.to_frame(TESTNET.magic()),
        now,
    );
    assert_eq!(net.dropped, [1]);
    connect(&mut node, &mut net, 2, from, now);
    assert_eq!(net.dropped, [1]);
}

#[test]
fn a_block_without_its_proof_of_work_or_a_message_out_of_turn_bans() {
    let file = File::new("p2p-work");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp + 60;
    let from = |last| SocketAddr::from(([10, 0, 0, last], 5000));
    greet(&mut node, &mut net, 1, from(1), now);
    assert!(net.sent.contains(&(1, Message::Verack)));
    let mut build = Builder::new();
    let mut block = build.child(&build.genesis(), nobody(1), Vec::new());
    block.header.nonce = 0;
    receive(&mut node, &mut net, 1, frame(&Message::Block(block)), now);
    assert_eq!(net.dropped, [1]);
    assert_eq!(node.chain.tip().unwrap(), PARAMS.genesis());
    connect(&mut node, &mut net, 2, from(1), now);
    assert_eq!(net.dropped, [1, 2]);

    // Anything but `version` first.
    connect(&mut node, &mut net, 3, from(2), now);
    receive(&mut node, &mut net, 3, frame(&Message::GetNodes), now);
    assert_eq!(net.dropped, [1, 2, 3]);
}

#[test]
fn a_peer_that_sends_no_block_asked_of_it_is_dropped_not_banned() {
    let file = File::new("p2p-stall");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    let from = SocketAddr::from(([10, 0, 0, 9], 5000));
    greet(&mut node, &mut net, 1, from, now);
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Inv(vec![[1; 32]])),
        now,
    );
    assert_eq!(net.sent.last(), Some(&(1, Message::GetData(vec![[1; 32]]))));
    node.tick(&mut net, now + STALL_SECONDS).unwrap();
    assert!(net.dropped.is_empty());
    node.tick(&mut net, now + STALL_SECONDS + 1).unwrap();
    assert_eq!(net.dropped, [1]);
    connect(&mut node, &mut net, 2, from, now + STALL_SECONDS + 1);
    assert_eq!(net.dropped, [1]);
}

#[test]
fn connections_past_the_limits_are_dropped() {
    let file = File::new("p2p-limits");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    for peer in 0..=MAX_INBOUND as u64 {
        connect(
            &mut node,
            &mut net,
            peer,
            SocketAddr::from(([10, 0, 1, peer as u8], 1)),
            now,
        );
    }
    assert_eq!(net.dropped, [MAX_INBOUND as u64]);
    for peer in 100..=100 + OUTBOUND as u64 {
        let event = Event::Connected {
            peer,
            address: SocketAddr::from(([10, 0, 2, peer as u8], 9444)),
            outbound: true,
        };
        node.handle(&mut net, event, now).unwrap();
    }
    assert_eq!(net.dropped, [MAX_INBOUND as u64, 100 + OUTBOUND as u64]);
}

#[test]
fn a_new_checkpoint_is_passed_on_once_and_a_forged_one_bans() {
    let file = File::new("p2p-checkpoint");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    let from = |last| SocketAddr::from(([10, 0, 0, last], 5000));
    greet(&mut node, &mut net, 1, from(1), now);
    greet(&mut node, &mut net, 2, from(2), now);
    let signer = SigningKey::from_seed(&DEV_CHECKPOINT_SEED);
    let checkpoint = Box::new(Checkpoint::sign(&PARAMS, &signer, 10, [9; 32], &[0; 32]).unwrap());
    let message = Message::Checkpoint(checkpoint.clone());
    net.sent.clear();
    receive(&mut node, &mut net, 1, frame(&message), now);
    assert_eq!(net.sent, [(2, message.clone())]);
    receive(&mut node, &mut net, 2, frame(&message), now);
    assert_eq!(net.sent, [(2, message)]);

    let mut forged = checkpoint;
    forged.height = 20;
    receive(
        &mut node,
        &mut net,
        2,
        frame(&Message::Checkpoint(forged)),
        now,
    );
    assert_eq!(net.dropped, [2]);
}

#[test]
fn a_sync_that_runs_out_asks_for_the_next_headers() {
    let file = File::new("p2p-next");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let mut build = Builder::new();
    let b1 = build.child(&build.genesis(), nobody(1), Vec::new());
    let now = b1.header.timestamp;
    greet(
        &mut node,
        &mut net,
        1,
        SocketAddr::from(([10, 0, 0, 1], 5000)),
        now,
    );
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Headers(vec![b1.header])),
        now,
    );
    assert_eq!(
        net.sent.last(),
        Some(&(1, Message::GetData(vec![b1.header.id()])))
    );
    // A batch of `MAX_HEADERS` ends like this one: the next headers come after the new tip.
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Block(b1.clone())),
        now,
    );
    let locator = vec![b1.header.id(), PARAMS.genesis().id()];
    assert_eq!(net.sent.last(), Some(&(1, Message::GetHeaders(locator))));
}

/// Handles the next event, if one comes soon, then ticks.
fn step(node: &mut TestNode, tcp: &mut Tcp, now: u64) {
    if let Some(event) = tcp.next(Duration::from_millis(20)) {
        node.handle(tcp, event, now).unwrap();
    }
    node.tick(tcp, now).unwrap();
}

#[test]
fn two_nodes_sync_over_tcp() {
    let mut build = Builder::new();
    let genesis = build.genesis();
    let blocks = build.branch(&genesis, nobody(1), 3);
    let now = blocks[2].header.timestamp;
    let files = [File::new("p2p-tcp-0"), File::new("p2p-tcp-1")];

    let mut tcp = Tcp::new(Some(SocketAddr::from(([127, 0, 0, 1], 0)))).unwrap();
    let listen = tcp.local_addr().unwrap();
    let mut seed = node(&files[0], listen.port(), &[]);
    submit_all(&seed.chain, &blocks);
    let done = Arc::new(AtomicBool::new(false));
    let serving = done.clone();
    let server = thread::spawn(move || {
        while !serving.load(Ordering::Relaxed) {
            step(&mut seed, &mut tcp, now);
        }
    });

    let mut tcp = Tcp::new(None).unwrap();
    let mut node = node(&files[1], 0, &[listen]);
    let start = Instant::now();
    while node.chain.tip().unwrap() != blocks[2].header {
        assert!(start.elapsed() < Duration::from_secs(20), "no sync");
        step(&mut node, &mut tcp, now);
    }
    done.store(true, Ordering::Relaxed);
    server.join().unwrap();
}
