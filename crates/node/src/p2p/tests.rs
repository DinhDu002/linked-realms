use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::issuance::BASE_UNITS_PER_GOLD as GOLD;
use linked_realms_core::keccak256;
use linked_realms_core::params::{DEV_CHECKPOINT_SEED, TESTNET};
use linked_realms_core::state::{Account, PublicKey};
use linked_realms_core::{ADDRESS_LEN, SCHEME_ML_DSA_44, SigningKey};

use super::*;
use crate::Policy;
use crate::chain::tests::{
    Builder, File, PARAMS, Test, balance, checkpoint, ledger, no_snapshot_left, nobody,
    snapshot_parts, submit_all,
};
use crate::mempool::tests::{key, pay};

pub(crate) type TestNode = Node<fn(&[u8], &[u8; 32]) -> [u8; 32]>;

pub(crate) fn node(file: &File, listen: u16, seeds: &[SocketAddr]) -> TestNode {
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
    files: Vec<File>,
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
            files,
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

    /// Makes Node `i` prune, keeping `keep` Blocks below its Checkpoint.
    fn pruning(&mut self, i: usize, keep: u64) {
        let seeds: Vec<SocketAddr> = self.nodes[i].known.keys().copied().collect();
        // Its database opens once: the Node goes first.
        drop(self.nodes.remove(i));
        let chain = self.files[i].open().pruning(keep);
        let pool = Mempool::new(PARAMS, Policy::default());
        self.nodes
            .insert(i, Node::new(chain, pool, &PARAMS, 9444, &seeds));
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
pub(crate) struct Recorder {
    pub(crate) sent: Vec<(PeerId, Message)>,
    dropped: Vec<PeerId>,
    dialed: Vec<SocketAddr>,
}

impl Network for Recorder {
    fn send(&mut self, peer: PeerId, mut frame: Vec<u8>) {
        let message = message::next_frame(&mut frame, PARAMS.magic()).unwrap();
        self.sent.push((peer, message.unwrap().unwrap()));
    }

    fn disconnect(&mut self, peer: PeerId) {
        self.dropped.push(peer);
    }

    fn dial(&mut self, address: SocketAddr) {
        self.dialed.push(address);
    }
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
pub(crate) fn greet<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]>(
    node: &mut Node<H>,
    net: &mut impl Network,
    peer: PeerId,
    from: SocketAddr,
    now: u64,
) {
    let connected = Event::Connected {
        peer,
        address: from,
        outbound: false,
    };
    node.handle(net, connected, now).unwrap();
    let version = Version {
        version: message::PROTOCOL_VERSION,
        genesis: node.genesis,
        height: 0,
        listen: 0,
        nonce: 7,
    };
    for message in [Message::Version(version), Message::Verack] {
        let bytes = message.to_frame(node.magic);
        node.handle(net, Event::Received { peer, bytes }, now)
            .unwrap();
    }
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
        Message::GetData(vec![[2; 32]; IN_FLIGHT]),
        Message::NotFound(Vec::new()),
        Message::GetHeaders(vec![[3; 32]; message::MAX_LOCATOR]),
        Message::Headers(vec![genesis.header, block.header]),
        Message::Block(block),
        Message::Tx(pay(&key(1), 0, nobody(2), GOLD, 10)),
        Message::Checkpoint(Box::new(checkpoint)),
        Message::GetCheckpoint,
        Message::GetNodes,
        Message::Nodes(vec![address(0), "[2001:db8::1]:9444".parse().unwrap()]),
        Message::GetStateSnapshot {
            height: 20,
            after: None,
        },
        Message::GetStateSnapshot {
            height: 20,
            after: Some([4; 32]),
        },
        Message::StateSnapshot {
            height: 20,
            accounts: vec![
                (
                    key(1).address(),
                    Account {
                        balance: 5,
                        nonce: 1,
                        key: Some(PublicKey {
                            scheme: linked_realms_core::SCHEME_ML_DSA_44,
                            bytes: key(1).public_key().to_vec(),
                        }),
                    },
                ),
                (nobody(2), Account::default()),
            ],
            more: true,
        },
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
    let ids = |n: usize| [(n as u16).to_be_bytes().as_slice(), &vec![0; 32 * n]].concat();
    assert_eq!(
        message::next_frame(&mut raw(4, &ids(MAX_IDS + 1)), magic),
        Err(Malformed::Payload)
    );
    // A `getdata` asks for no more Blocks than a Node has on the way from one peer.
    assert_eq!(
        message::next_frame(&mut raw(5, &ids(IN_FLIGHT + 1)), magic),
        Err(Malformed::Payload)
    );
    // Accounts with no key: an address, a balance, a nonce and a key length of 0.
    let account = [&nobody(1).to_bytes()[..], &[0; 18]].concat();
    let part = |more: u8, count: usize| {
        [
            &20u64.to_be_bytes()[..],
            &[more],
            &(count as u16).to_be_bytes(),
            &account.repeat(count),
        ]
        .concat()
    };
    let full = message::next_frame(&mut raw(16, &part(1, MAX_SNAPSHOT_ACCOUNTS)), magic);
    assert!(matches!(
        full,
        Ok(Some(Some(Message::StateSnapshot { more: true, .. })))
    ));
    assert_eq!(
        message::next_frame(&mut raw(16, &part(0, 0)), magic),
        Ok(Some(Some(Message::StateSnapshot {
            height: 20,
            accounts: Vec::new(),
            more: false
        })))
    );
    for bad in [part(2, 0), part(0, MAX_SNAPSHOT_ACCOUNTS + 1)] {
        assert_eq!(
            message::next_frame(&mut raw(16, &bad), magic),
            Err(Malformed::Payload)
        );
    }
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
    assert!(node.synced());
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Inv(vec![[1; 32]])),
        now,
    );
    assert_eq!(net.sent.last(), Some(&(1, Message::GetData(vec![[1; 32]]))));
    assert!(!node.synced(), "a Block asked for and not come");
    node.tick(&mut net, now + STALL_SECONDS).unwrap();
    assert!(net.dropped.is_empty());
    node.tick(&mut net, now + STALL_SECONDS + 1).unwrap();
    assert_eq!(net.dropped, [1]);
    assert!(node.synced());
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
fn a_checkpoint_that_moves_the_tip_announces_the_new_one() {
    let file = File::new("p2p-checkpoint-tip");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let mut build = Builder::new();
    let genesis = build.genesis();
    let main = build.branch(&genesis, nobody(1), 12);
    let other = build.branch(&genesis, nobody(2), 10);
    submit_all(&node.chain, &main);
    submit_all(&node.chain, &other);
    let now = main[11].header.timestamp;
    greet(
        &mut node,
        &mut net,
        1,
        SocketAddr::from(([10, 0, 0, 1], 5000)),
        now,
    );
    net.sent.clear();
    let tip = other[9].header.id();
    node.submit_checkpoint(&mut net, checkpoint(10, tip))
        .unwrap()
        .unwrap();
    assert_eq!(node.chain.tip().unwrap().id(), tip);
    assert!(
        net.sent.contains(&(1, Message::Inv(vec![tip]))),
        "{:?}",
        net.sent
    );
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
    // Asked once, however often it is announced.
    let sent = net.sent.len();
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Headers(vec![b1.header])),
        now,
    );
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Inv(vec![b1.header.id(); 2])),
        now,
    );
    assert_eq!(net.sent.len(), sent);
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

#[test]
fn a_silent_peer_is_pinged_then_dropped() {
    let file = File::new("p2p-silent");
    let mut node = node(&file, 0, &[]);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    let from = |last| SocketAddr::from(([10, 0, 0, last], 5000));
    // Never sends `version`.
    connect(&mut node, &mut net, 1, from(1), now);
    // Ready, then silent; and ready, then answers the `ping`.
    greet(&mut node, &mut net, 2, from(2), now);
    greet(&mut node, &mut net, 3, from(3), now);
    // Quiet for `PING_SECONDS`: pinged.
    node.tick(&mut net, now + PING_SECONDS).unwrap();
    assert!(net.dropped.is_empty());
    node.tick(&mut net, now + HANDSHAKE_SECONDS + 1).unwrap();
    assert_eq!(net.dropped, [1]);
    // One `ping` each, until they answer.
    for peer in [2, 3] {
        let pings = net
            .sent
            .iter()
            .filter(|(to, m)| *to == peer && matches!(m, Message::Ping(_)));
        assert_eq!(pings.count(), 1);
    }
    let pong = frame(&Message::Pong(now + PING_SECONDS));
    receive(&mut node, &mut net, 3, pong, now + PING_SECONDS + 2);
    node.tick(&mut net, now + IDLE_SECONDS).unwrap();
    assert_eq!(net.dropped, [1]);
    node.tick(&mut net, now + IDLE_SECONDS + 1).unwrap();
    assert_eq!(net.dropped, [1, 2]);
}

#[test]
fn the_address_book_takes_usable_addresses_once_and_gives_each_a_turn() {
    let file = File::new("p2p-addresses");
    let seeds: Vec<SocketAddr> = (1..=9)
        .map(|last| SocketAddr::from(([10, 0, 1, last], 9444)))
        .collect();
    let mut node = node(&file, 0, &seeds);
    let mut net = Recorder::default();
    let now = PARAMS.genesis().timestamp;
    greet(
        &mut node,
        &mut net,
        1,
        SocketAddr::from(([10, 0, 0, 1], 5000)),
        now,
    );
    let usable = SocketAddr::from(([10, 0, 2, 1], 9444));
    let offered = vec![
        usable,
        SocketAddr::from(([10, 0, 2, 2], 0)),
        SocketAddr::from(([0, 0, 0, 0], 9444)),
        SocketAddr::from(([127, 0, 0, 1], 9444)),
        SocketAddr::from(([224, 0, 0, 1], 9444)),
    ];
    receive(&mut node, &mut net, 1, frame(&Message::Nodes(offered)), now);
    // Only in answer to `getnodes`.
    let later = vec![SocketAddr::from(([10, 0, 2, 3], 9444))];
    receive(&mut node, &mut net, 1, frame(&Message::Nodes(later)), now);
    let mut known: Vec<SocketAddr> = node.known.keys().copied().collect();
    known.sort();
    assert_eq!(known, [&seeds[..], &[usable]].concat());

    // 8 at a time, the least recently dialed first.
    node.tick(&mut net, now).unwrap();
    assert_eq!(net.dialed, seeds[..8]);
    node.tick(&mut net, now + RETRY_SECONDS).unwrap();
    assert_eq!(net.dialed[8..10], [seeds[8], usable]);
    // A learned address that never finished `version` goes; seeds stay.
    node.tick(&mut net, now + 2 * RETRY_SECONDS).unwrap();
    assert!(!node.known.contains_key(&usable));
    assert_eq!(node.known.len(), seeds.len());
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

#[test]
fn a_new_node_starts_from_a_checkpoint_and_a_state_snapshot() {
    let mut mesh = Mesh::new("p2p-snapshot", 2, &[(1, 0)]);
    // Neither keeps a Block below the Checkpoint: Node 1 can only start from a snapshot.
    mesh.pruning(0, 0);
    mesh.pruning(1, 0);
    let mut build = Builder::new();
    let miner = key(1);
    let blocks = ledger(&mut build, &miner);
    mesh.with(0, |node, net| {
        blocks.iter().for_each(|b| node.mined(net, b).unwrap());
        let c = checkpoint(20, blocks[19].header.id());
        node.chain.add_checkpoint(&c).unwrap();
    });
    let below = blocks[10].header.id();
    assert_eq!(mesh.nodes[0].chain.block(&below).unwrap(), None);
    // Node 1 mined a branch of its own, which its mempool followed.
    let own = build.branch(&build.genesis(), nobody(8), 2);
    mesh.with(1, |node, net| {
        own.iter().for_each(|b| node.mined(net, b).unwrap())
    });
    mesh.now = blocks[24].header.timestamp;
    mesh.tick();
    assert_eq!(mesh.tip(1), blocks[24].header.id());
    assert_eq!(mesh.nodes[1].chain.block(&below).unwrap(), None);
    for address in [miner.address(), nobody(5), nobody(6), nobody(8)] {
        let account = |i: usize| mesh.nodes[i].chain.account(&address).unwrap();
        assert_eq!(account(1), account(0));
    }
}

#[test]
fn a_bad_state_snapshot_bans_its_sender_and_changes_nothing() {
    let (from, to) = (
        File::new("p2p-bad-snapshot-from"),
        File::new("p2p-bad-snapshot-to"),
    );
    let a: Test = from.open();
    let mut build = Builder::new();
    let blocks = ledger(&mut build, &key(1));
    submit_all(&a, &blocks);
    let c = checkpoint(20, blocks[19].header.id());
    a.add_checkpoint(&c).unwrap();
    let good = snapshot_parts(&a, 20, 10).concat();
    let pool = Mempool::new(PARAMS, Policy::default());
    let mut node: TestNode = Node::new(to.open().pruning(0), pool, &PARAMS, 0, &[]);
    let now = blocks[24].header.timestamp;
    let headers: Vec<_> = blocks.iter().map(|b| b.header).collect();
    // Each peer sends the Checkpoint, then the headers, so it is asked for the snapshot.
    let start = |node: &mut TestNode, net: &mut Recorder, peer: PeerId| {
        greet(node, net, peer, address(peer as usize), now);
        let checkpoint = Message::Checkpoint(Box::new(c.clone()));
        receive(node, net, peer, frame(&checkpoint), now);
        receive(
            node,
            net,
            peer,
            frame(&Message::Headers(headers.clone())),
            now,
        );
    };
    let asked = |net: &Recorder, peer: PeerId| -> Vec<Option<[u8; 32]>> {
        net.sent
            .iter()
            .filter_map(|(to, m)| match m {
                Message::GetStateSnapshot { height: 20, after } if *to == peer => Some(*after),
                _ => None,
            })
            .collect()
    };
    let part = |accounts: Vec<(linked_realms_core::Address, Account)>, more: bool| {
        frame(&Message::StateSnapshot {
            height: 20,
            accounts,
            more,
        })
    };
    let mut net = Recorder::default();
    let banned =
        |node: &TestNode, peer: PeerId| node.banned.contains_key(&address(peer as usize).ip());

    // A whole whose root is not the Checkpoint's bans.
    start(&mut node, &mut net, 1);
    assert_eq!(asked(&net, 1), [None]);
    let mut wrong = good.clone();
    wrong[0].1.balance += 1;
    receive(&mut node, &mut net, 1, part(wrong, false), now);
    assert!(banned(&node, 1));
    assert_eq!(node.chain.tip().unwrap(), PARAMS.genesis());

    // A full part out of the tree's key order bans.
    let two = made_up(2 * MAX_SNAPSHOT_ACCOUNTS);
    let (full, after) = (
        two[..MAX_SNAPSHOT_ACCOUNTS].to_vec(),
        two[MAX_SNAPSHOT_ACCOUNTS..].to_vec(),
    );
    start(&mut node, &mut net, 2);
    let mut swapped = full.clone();
    swapped.swap(0, 1);
    receive(&mut node, &mut net, 2, part(swapped, true), now);
    assert!(banned(&node, 2));
    // One in order brings the ask for the next, after its last key; more accounts than 20
    // Blocks could create then ban.
    start(&mut node, &mut net, 3);
    receive(&mut node, &mut net, 3, part(full.clone(), true), now);
    let next = tree_key(&full[MAX_SNAPSHOT_ACCOUNTS - 1].0);
    assert_eq!(asked(&net, 3), [None, Some(next)]);
    assert!(!banned(&node, 3));
    receive(&mut node, &mut net, 3, part(after, true), now);
    assert!(banned(&node, 3));
    assert!(no_snapshot_left(&node.chain));
    // So does a part that says more follow but is not full.
    start(&mut node, &mut net, 4);
    receive(&mut node, &mut net, 4, part(good[..1].to_vec(), true), now);
    assert!(banned(&node, 4));
    assert_eq!(net.dropped, [1, 2, 3, 4]);

    // A peer that does not serve it is not banned, and a part no longer asked for is skipped.
    start(&mut node, &mut net, 5);
    receive(&mut node, &mut net, 5, part(Vec::new(), false), now);
    receive(&mut node, &mut net, 5, part(good.clone(), false), now);
    assert!(!banned(&node, 5));
    assert_eq!(node.chain.tip().unwrap(), PARAMS.genesis());
    // Headers a rule refuses ban too.
    greet(&mut node, &mut net, 8, address(8), now);
    let mut forged = headers.clone();
    forged[0].nonce = 0;
    receive(
        &mut node,
        &mut net,
        8,
        frame(&Message::Headers(forged)),
        now,
    );
    assert!(banned(&node, 8));

    // One at a time: another peer is not asked, and what it sends is skipped, as is a part at
    // another height.
    start(&mut node, &mut net, 6);
    start(&mut node, &mut net, 7);
    assert!(asked(&net, 7).is_empty());
    receive(&mut node, &mut net, 7, part(good.clone(), false), now);
    let elsewhere = Message::StateSnapshot {
        height: 10,
        accounts: good.clone(),
        more: false,
    };
    receive(&mut node, &mut net, 6, frame(&elsewhere), now);
    assert_eq!(node.chain.tip().unwrap(), PARAMS.genesis());
    receive(&mut node, &mut net, 6, part(good, false), now);
    assert_eq!(node.chain.tip().unwrap(), blocks[19].header);
    assert_eq!(net.dropped, [1, 2, 3, 4, 8]);
    // Its peers hear of the new tip, then it asks for the Blocks after it.
    let tip = vec![blocks[19].header.id()];
    let told = |m: &(PeerId, Message)| matches!(m, (7, Message::Inv(ids)) if *ids == tip);
    assert!(net.sent.iter().any(told));
    let last = net.sent.last().unwrap();
    assert!(matches!(last, (6, Message::GetHeaders(l)) if l[0] == blocks[19].header.id()));
}

/// `n` accounts no chain holds, in the tree's key order.
fn made_up(n: usize) -> Vec<(Address, Account)> {
    let mut accounts: Vec<_> = (0..n as u64)
        .map(|i| {
            let mut bytes = [9; ADDRESS_LEN];
            bytes[..2].copy_from_slice(&[0, SCHEME_ML_DSA_44]);
            bytes[2..10].copy_from_slice(&i.to_be_bytes());
            (Address::from_bytes(&bytes).unwrap(), Account::default())
        })
        .collect();
    accounts.sort_by_key(|(address, _)| tree_key(address));
    accounts
}

#[test]
fn a_node_within_what_it_keeps_below_the_checkpoint_syncs_every_block() {
    // Node 1 keeps 20 Blocks and is 20 below the Checkpoint; Node 2 is an archive.
    let mut mesh = Mesh::new("p2p-no-snapshot", 3, &[(1, 0), (2, 0)]);
    mesh.pruning(1, 20);
    let mut build = Builder::new();
    let blocks = ledger(&mut build, &key(1));
    mesh.with(0, |node, net| {
        blocks.iter().for_each(|b| node.mined(net, b).unwrap());
        let c = checkpoint(20, blocks[19].header.id());
        node.chain.add_checkpoint(&c).unwrap();
    });
    mesh.now = blocks[24].header.timestamp;
    mesh.tick();
    for i in [1, 2] {
        assert_eq!(mesh.tip(i), blocks[24].header.id());
        let first = mesh.nodes[i].chain.block(&blocks[0].header.id()).unwrap();
        assert!(first.is_some());
    }
}

#[test]
fn headers_on_the_way_to_a_checkpoint_come_a_batch_at_a_time() {
    let file = File::new("p2p-header-batches");
    let mut build = Builder::new();
    // The Checkpoint is 10 Blocks after the first batch of headers.
    let height = MAX_HEADERS as u64 + 10;
    let blocks = build.branch(&build.genesis(), nobody(1), height as usize);
    let c = checkpoint(height, blocks.last().unwrap().header.id());
    let pool = Mempool::new(PARAMS, Policy::default());
    let mut node: TestNode = Node::new(file.open().pruning(0), pool, &PARAMS, 0, &[]);
    let now = blocks.last().unwrap().header.timestamp;
    let mut net = Recorder::default();
    greet(&mut node, &mut net, 1, address(1), now);
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Checkpoint(Box::new(c))),
        now,
    );
    let headers: Vec<_> = blocks.iter().map(|b| b.header).collect();
    let (first, rest) = headers.split_at(MAX_HEADERS);
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Headers(first.to_vec())),
        now,
    );
    let last = net.sent.last().unwrap();
    assert!(matches!(last, (1, Message::GetHeaders(l)) if l[0] == first[MAX_HEADERS - 1].id()));
    assert!(!node.synced(), "headers on the way to a state snapshot");
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Headers(rest.to_vec())),
        now,
    );
    let ask = Message::GetStateSnapshot {
        height,
        after: None,
    };
    assert_eq!(net.sent.last().unwrap(), &(1, ask));
    assert!(!node.synced(), "a state snapshot on the way");
}

#[test]
fn a_peer_that_sends_no_part_of_a_state_snapshot_is_dropped() {
    let file = File::new("p2p-slow-snapshot");
    let mut build = Builder::new();
    let blocks = ledger(&mut build, &key(1));
    let c = checkpoint(20, blocks[19].header.id());
    let pool = Mempool::new(PARAMS, Policy::default());
    let mut node: TestNode = Node::new(file.open().pruning(0), pool, &PARAMS, 0, &[]);
    let now = blocks[24].header.timestamp;
    let mut net = Recorder::default();
    greet(&mut node, &mut net, 1, address(1), now);
    // The Checkpoint first: it decides what the headers are for.
    let asks: Vec<bool> = net
        .sent
        .iter()
        .filter_map(|(_, m)| match m {
            Message::GetCheckpoint => Some(true),
            Message::GetHeaders(_) => Some(false),
            _ => None,
        })
        .collect();
    assert_eq!(asks, [true, false]);
    receive(
        &mut node,
        &mut net,
        1,
        frame(&Message::Checkpoint(Box::new(c))),
        now,
    );
    let headers = Message::Headers(blocks.iter().map(|b| b.header).collect());
    receive(&mut node, &mut net, 1, frame(&headers), now);
    // It answers pings, so only the snapshot it owes can drop it.
    let pong = frame(&Message::Pong(0));
    for later in [STALL_SECONDS / 2, STALL_SECONDS] {
        receive(&mut node, &mut net, 1, pong.clone(), now + later);
        node.tick(&mut net, now + later).unwrap();
    }
    assert!(net.dropped.is_empty());
    receive(&mut node, &mut net, 1, pong, now + STALL_SECONDS + 1);
    node.tick(&mut net, now + STALL_SECONDS + 1).unwrap();
    assert_eq!(net.dropped, [1]);
    assert!(node.snapshot.is_none());
    assert!(!node.banned.contains_key(&address(1).ip()));
    // The next peer is asked for headers after those already stored.
    greet(&mut node, &mut net, 2, address(2), now + STALL_SECONDS + 1);
    let locator = net.sent.iter().find_map(|(to, m)| match m {
        Message::GetHeaders(l) if *to == 2 => Some(l[0]),
        _ => None,
    });
    assert_eq!(locator, Some(blocks[24].header.id()));
    // A part that comes in time gives the next as long again.
    let later = now + STALL_SECONDS + 1;
    receive(&mut node, &mut net, 2, frame(&headers), later);
    let part = Message::StateSnapshot {
        height: 20,
        accounts: made_up(MAX_SNAPSHOT_ACCOUNTS),
        more: true,
    };
    let half = later + STALL_SECONDS / 2;
    receive(&mut node, &mut net, 2, frame(&part), half);
    let pong = frame(&Message::Pong(0));
    receive(&mut node, &mut net, 2, pong.clone(), half + STALL_SECONDS);
    node.tick(&mut net, half + STALL_SECONDS).unwrap();
    assert_eq!(net.dropped, [1]);
    receive(&mut node, &mut net, 2, pong, half + STALL_SECONDS + 1);
    node.tick(&mut net, half + STALL_SECONDS + 1).unwrap();
    assert_eq!(net.dropped, [1, 2]);
}
