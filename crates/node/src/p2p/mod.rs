//! Nodes find each other, swap Blocks, transactions and Checkpoints, and drop a Node that sends
//! what no honest Node would (docs/plans/phase-2c-the-chain.md, "P2P"). `Node` decides; a
//! `Network` only moves bytes, so the tests run many Nodes in memory and `Tcp` runs them for
//! real.

mod message;
mod tcp;

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, SocketAddr};

use linked_realms_core::Address;
use linked_realms_core::block::{Block, Header, MAX_NEW_ACCOUNTS};
use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::params::ChainParams;
use linked_realms_core::state::{Account, tree_key};
use linked_realms_core::tx::Tx;

pub use message::{
    IN_FLIGHT, MAX_HEADERS, MAX_IDS, MAX_NODES, MAX_PAYLOAD, MAX_SNAPSHOT_ACCOUNTS, Malformed,
    Message, Version,
};
pub use tcp::Tcp;

use crate::{Chain, Error, Mempool, Refused};

/// A connection, numbered by the `Network` that holds it.
pub type PeerId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A connection is open: `outbound` if this Node dialed it.
    Connected {
        peer: PeerId,
        address: SocketAddr,
        outbound: bool,
    },
    Received {
        peer: PeerId,
        bytes: Vec<u8>,
    },
    /// A connection closed that this Node did not drop itself.
    Disconnected {
        peer: PeerId,
    },
}

/// Moves bytes between Nodes. What it delivers comes back to `Node::handle` as `Event`s, a
/// connection's `Connected` before anything it receives.
pub trait Network {
    fn send(&mut self, peer: PeerId, frame: Vec<u8>);
    /// Drops the connection; no `Disconnected` comes for it.
    fn disconnect(&mut self, peer: PeerId);
    /// Opens a connection; `Connected` comes if it opens.
    fn dial(&mut self, address: SocketAddr);
}

/// A Block stamped more seconds ahead of this Node's clock is not taken yet, nor anything above
/// it; a later sync takes it once the clock catches up (docs/protocols/blocks.md).
pub const MAX_AHEAD: u64 = 300;
/// Connections this Node dials.
pub const OUTBOUND: usize = 8;
/// Connections this Node takes.
pub const MAX_INBOUND: usize = 64;
/// How long a banned IP address stays banned.
pub const BAN_SECONDS: u64 = 24 * 60 * 60;
/// A peer that sends none of the Blocks asked of it for this long is dropped.
pub const STALL_SECONDS: u64 = 120;
/// A peer that has not finished `version` and `verack` this long after it connected is dropped.
pub const HANDSHAKE_SECONDS: u64 = 60;
/// A peer that has sent no whole message for this long is sent a `ping`, and dropped if it
/// still sends none `IDLE_SECONDS` after its last.
pub const PING_SECONDS: u64 = 60;
pub const IDLE_SECONDS: u64 = 180;
/// How long before an address is dialed again.
const RETRY_SECONDS: u64 = 60;
/// Addresses of other Nodes kept, at most.
const MAX_KNOWN: usize = 10_000;

struct Peer {
    address: SocketAddr,
    outbound: bool,
    /// Bytes received and not yet a whole frame.
    buffer: Vec<u8>,
    /// Its `version` came.
    version: bool,
    /// Its `verack` came, so any message may follow.
    ready: bool,
    /// When it connected, and when its last whole message came.
    since: u64,
    heard: u64,
    /// A `ping` went to it since then.
    pinged: bool,
    /// It was asked for other Nodes' addresses and has not answered.
    nodes_asked: bool,
    /// Blocks to ask it for, lowest first.
    wanted: VecDeque<[u8; 32]>,
    /// Blocks asked of it and not yet come, and when it was last asked.
    asked: HashSet<[u8; 32]>,
    asked_at: u64,
}

/// A state snapshot being taken from a peer, part by part.
struct Download {
    peer: PeerId,
    /// The Checkpoint's height.
    height: u64,
    /// When the last part was asked for.
    // ponytail: a peer that sends full parts just inside `STALL_SECONDS` holds the download
    // until its root fails, at most `MAX_NEW_ACCOUNTS` accounts a Block below the Checkpoint;
    // ask for a rate across parts if that shows.
    asked_at: u64,
    /// The accounts taken so far.
    taken: u64,
}

/// An address another Node takes connections on.
struct Known {
    /// When this Node last dialed it, or 0.
    tried: u64,
    /// A seed, or a Node it has finished `version` with, so it is kept.
    good: bool,
}

pub struct Node<H> {
    pub chain: Chain<H>,
    pub pool: Mempool,
    magic: [u8; 4],
    genesis: [u8; 32],
    /// The port this Node takes connections on, or 0.
    listen: u16,
    nonce: u64,
    now: u64,
    peers: HashMap<PeerId, Peer>,
    /// Banned IP addresses, until when.
    banned: HashMap<IpAddr, u64>,
    /// Addresses other Nodes take connections on.
    known: HashMap<SocketAddr, Known>,
    /// Addresses that turned out to be this Node.
    own: HashSet<SocketAddr>,
    /// Counts ticks, to ask each peer for headers in turn.
    ticks: usize,
    /// The state snapshot being taken, if any.
    snapshot: Option<Download>,
    /// The last header stored on the way to a state snapshot, until it is taken.
    headers_tip: Option<[u8; 32]>,
}

impl<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]> Node<H> {
    /// A Node of the network `params` that dials `seeds` first, and says it takes connections
    /// on `listen` (0 for none).
    pub fn new(
        chain: Chain<H>,
        pool: Mempool,
        params: &ChainParams,
        listen: u16,
        seeds: &[SocketAddr],
    ) -> Self {
        Node {
            chain,
            pool,
            magic: params.magic(),
            genesis: params.genesis().id(),
            listen,
            nonce: RandomState::new().build_hasher().finish(),
            now: 0,
            peers: HashMap::new(),
            banned: HashMap::new(),
            known: seeds
                .iter()
                .map(|seed| {
                    (
                        *seed,
                        Known {
                            tried: 0,
                            good: true,
                        },
                    )
                })
                .collect(),
            own: HashSet::new(),
            ticks: 0,
            snapshot: None,
            headers_tip: None,
        }
    }

    /// Takes one event from the network at the time `now`, in Unix seconds.
    pub fn handle(&mut self, net: &mut impl Network, event: Event, now: u64) -> Result<(), Error> {
        self.now = now;
        match event {
            Event::Connected {
                peer,
                address,
                outbound,
            } => {
                let same = self
                    .peers
                    .values()
                    .filter(|p| p.outbound == outbound)
                    .count();
                let max = if outbound { OUTBOUND } else { MAX_INBOUND };
                if self.banned.contains_key(&address.ip()) || same >= max {
                    net.disconnect(peer);
                    return Ok(());
                }
                let state = Peer {
                    address,
                    outbound,
                    buffer: Vec::new(),
                    version: false,
                    ready: false,
                    since: now,
                    heard: now,
                    pinged: false,
                    nodes_asked: false,
                    wanted: VecDeque::new(),
                    asked: HashSet::new(),
                    asked_at: 0,
                };
                self.peers.insert(peer, state);
                let version = Version {
                    version: message::PROTOCOL_VERSION,
                    genesis: self.genesis,
                    height: self.chain.tip()?.height,
                    listen: self.listen,
                    nonce: self.nonce,
                };
                self.send(net, peer, &Message::Version(version));
            }
            Event::Received { peer, bytes } => {
                let Some(state) = self.peers.get_mut(&peer) else {
                    return Ok(());
                };
                state.buffer.extend_from_slice(&bytes);
                // Until the buffer holds no whole frame, or the peer is gone.
                while let Some(state) = self.peers.get_mut(&peer) {
                    let frame = message::next_frame(&mut state.buffer, self.magic);
                    if let Ok(Some(_)) = frame {
                        (state.heard, state.pinged) = (now, false);
                    }
                    match frame {
                        Ok(None) => break,
                        Ok(Some(None)) => {}
                        Ok(Some(Some(message))) => self.on_message(net, peer, message)?,
                        // Another network's Node: dropped, not banned.
                        Err(Malformed::Magic) => self.drop_peer(net, peer),
                        Err(_) => self.ban(net, peer),
                    }
                }
            }
            Event::Disconnected { peer } => self.forget(peer),
        }
        Ok(())
    }

    /// What this Node does on its own at the time `now`: lifts bans that ended, drops peers
    /// that stall or go silent and pings quiet ones, dials more Nodes, and asks one idle peer
    /// for headers, which also takes a Block once the clock catches up with it and asks again
    /// for a body this Node dropped.
    pub fn tick(&mut self, net: &mut impl Network, now: u64) -> Result<(), Error> {
        self.now = now;
        self.banned.retain(|_, until| *until > now);
        let late: Vec<PeerId> = self
            .peers
            .iter()
            .filter(|(id, p)| {
                let stalled = !p.asked.is_empty() && p.asked_at.saturating_add(STALL_SECONDS) < now;
                let stalled = stalled
                    || self.snapshot.as_ref().is_some_and(|d| {
                        d.peer == **id && d.asked_at.saturating_add(STALL_SECONDS) < now
                    });
                let silent = match p.ready {
                    true => p.heard.saturating_add(IDLE_SECONDS) < now,
                    false => p.since.saturating_add(HANDSHAKE_SECONDS) < now,
                };
                stalled || silent
            })
            .map(|(id, _)| *id)
            .collect();
        late.into_iter().for_each(|peer| self.drop_peer(net, peer));
        let quiet: Vec<PeerId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.ready && !p.pinged && p.heard.saturating_add(PING_SECONDS) <= now)
            .map(|(id, _)| *id)
            .collect();
        for peer in quiet {
            self.peers.get_mut(&peer).expect("a peer").pinged = true;
            self.send(net, peer, &Message::Ping(now));
        }

        // An address dialed once that never finished `version` goes, so addresses that lead
        // nowhere cannot crowd out the rest.
        self.known
            .retain(|_, k| k.good || k.tried == 0 || k.tried.saturating_add(RETRY_SECONDS) > now);
        let outbound = self.peers.values().filter(|p| p.outbound).count();
        let connected: HashSet<IpAddr> = self.peers.values().map(|p| p.address.ip()).collect();
        let mut dial: Vec<(u64, SocketAddr)> = self
            .known
            .iter()
            .filter(|(address, k)| {
                k.tried.saturating_add(RETRY_SECONDS) <= now
                    && !connected.contains(&address.ip())
                    && !self.banned.contains_key(&address.ip())
                    && !self.own.contains(*address)
            })
            .map(|(address, k)| (k.tried, *address))
            .collect();
        // The least recently dialed first, so each address gets its turn.
        dial.sort();
        for (_, address) in dial.into_iter().take(OUTBOUND.saturating_sub(outbound)) {
            self.known.get_mut(&address).expect("a known address").tried = now;
            net.dial(address);
        }

        let mut ready: Vec<PeerId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.ready)
            .map(|(id, _)| *id)
            .collect();
        if !ready.is_empty() {
            ready.sort_unstable();
            let peer = ready[self.ticks % ready.len()];
            self.ticks += 1;
            let state = &self.peers[&peer];
            if state.asked.is_empty() && state.wanted.is_empty() {
                let locator = self.locator()?;
                self.send(net, peer, &Message::GetHeaders(locator));
            }
        }
        Ok(())
    }

    /// Takes a Block this Node's Mine found, and tells the other Nodes if it is the new tip.
    pub fn mined(&mut self, net: &mut impl Network, block: &Block) -> Result<(), Error> {
        let tip = self.chain.tip()?.id();
        self.chain.submit_block(block)?;
        self.after_blocks(net, tip)
    }

    /// Takes a transaction sent to this Node, and passes it on if the mempool took it.
    pub fn send_tx(
        &mut self,
        net: &mut impl Network,
        tx: Tx,
    ) -> Result<Result<(), Refused>, Error> {
        self.take_tx(net, tx, None)
    }

    fn on_message(
        &mut self,
        net: &mut impl Network,
        peer: PeerId,
        message: Message,
    ) -> Result<(), Error> {
        let state = &self.peers[&peer];
        let in_order = match message {
            Message::Version(_) => !state.version,
            Message::Verack => state.version && !state.ready,
            _ => state.ready,
        };
        if !in_order {
            self.ban(net, peer);
            return Ok(());
        }
        match message {
            Message::Version(version) => {
                let state = self.peers.get_mut(&peer).expect("a peer");
                if version.genesis != self.genesis || version.nonce == self.nonce {
                    if version.nonce == self.nonce && state.outbound {
                        self.own.insert(state.address);
                    }
                    self.drop_peer(net, peer);
                    return Ok(());
                }
                state.version = true;
                let (address, outbound) = (state.address, state.outbound);
                if outbound && let Some(known) = self.known.get_mut(&address) {
                    known.good = true;
                }
                if version.listen != 0 {
                    let listen = SocketAddr::new(address.ip(), version.listen);
                    self.learn(listen, address.ip());
                }
                self.send(net, peer, &Message::Verack);
            }
            Message::Verack => {
                let state = self.peers.get_mut(&peer).expect("a peer");
                (state.ready, state.nodes_asked) = (true, true);
                // The Checkpoint first: it decides whether the headers start a state snapshot.
                self.send(net, peer, &Message::GetCheckpoint);
                let locator = self.locator()?;
                self.send(net, peer, &Message::GetHeaders(locator));
                self.send(net, peer, &Message::GetNodes);
            }
            Message::Ping(nonce) => self.send(net, peer, &Message::Pong(nonce)),
            Message::Pong(_) => {}
            Message::Inv(ids) => {
                let state = self.peers.get_mut(&peer).expect("a peer");
                let room = MAX_HEADERS.saturating_sub(state.wanted.len());
                state.wanted.extend(ids.into_iter().take(room));
                self.ask(net, peer)?;
            }
            Message::GetData(ids) => {
                let mut missing = Vec::new();
                for id in ids {
                    match self.chain.block(&id)? {
                        Some(block) => self.send(net, peer, &Message::Block(block)),
                        None => missing.push(id),
                    }
                }
                if !missing.is_empty() {
                    self.send(net, peer, &Message::NotFound(missing));
                }
            }
            Message::NotFound(ids) => {
                let state = self.peers.get_mut(&peer).expect("a peer");
                for id in &ids {
                    state.asked.remove(id);
                }
                self.ask(net, peer)?;
            }
            Message::GetHeaders(locator) => {
                let headers = self.chain.headers_after(&locator, MAX_HEADERS as u64)?;
                self.send(net, peer, &Message::Headers(headers));
            }
            Message::Headers(headers) => {
                // Nothing at or above a header too far ahead of the clock.
                let headers: Vec<Header> = headers
                    .into_iter()
                    .take_while(|h| h.timestamp <= self.now.saturating_add(MAX_AHEAD))
                    .collect();
                if let Some(checkpoint) = self.far_behind()? {
                    return self.headers_to_checkpoint(net, peer, &headers, &checkpoint);
                }
                let ids: Vec<[u8; 32]> = headers.iter().map(|h| h.id()).collect();
                let wanted = self.chain.missing(&ids)?;
                if !wanted.is_empty() {
                    self.peers.get_mut(&peer).expect("a peer").wanted = wanted.into();
                    self.ask(net, peer)?;
                } else if ids.len() == MAX_HEADERS {
                    // All held, though not on this Node's best chain: the next ones.
                    let mut locator = vec![ids[MAX_HEADERS - 1]];
                    locator.extend(self.chain.locator()?);
                    locator.truncate(message::MAX_LOCATOR);
                    self.send(net, peer, &Message::GetHeaders(locator));
                }
            }
            Message::Block(block) => {
                let state = self.peers.get_mut(&peer).expect("a peer");
                let syncing = state.asked.remove(&block.header.id());
                let mut more = false;
                if block.header.timestamp <= self.now.saturating_add(MAX_AHEAD) {
                    let tip = self.chain.tip()?.id();
                    match self.chain.submit_block(&block) {
                        Ok(()) => self.after_blocks(net, tip)?,
                        Err(Error::UnknownParent) => more = true,
                        Err(Error::Rule(_) | Error::RefusedBranch) => {
                            self.after_blocks(net, tip)?;
                            self.ban(net, peer);
                            return Ok(());
                        }
                        Err(error) => return Err(error),
                    }
                }
                self.ask(net, peer)?;
                let state = &self.peers[&peer];
                // A sync that ran out asks where to go on from the new tip.
                if more || (syncing && state.asked.is_empty() && state.wanted.is_empty()) {
                    let locator = self.locator()?;
                    self.send(net, peer, &Message::GetHeaders(locator));
                }
            }
            // A refused transaction is no fault: mempools differ.
            Message::Tx(tx) => {
                let _ = self.take_tx(net, tx, Some(peer))?;
            }
            Message::Checkpoint(checkpoint) => {
                let latest = self.chain.latest_checkpoint()?.map(|c| c.height);
                let tip = self.chain.tip()?.id();
                match self.chain.add_checkpoint(&checkpoint) {
                    Ok(()) => {
                        if latest.is_none_or(|height| checkpoint.height > height) {
                            self.broadcast(net, &Message::Checkpoint(checkpoint), Some(peer));
                        }
                        self.after_blocks(net, tip)?;
                    }
                    Err(Error::Rule(_)) => self.ban(net, peer),
                    Err(error) => return Err(error),
                }
            }
            Message::GetCheckpoint => {
                if let Some(checkpoint) = self.chain.latest_checkpoint()? {
                    self.send(net, peer, &Message::Checkpoint(Box::new(checkpoint)));
                }
            }
            Message::GetNodes => {
                // Those this Node has finished `version` with first.
                let mut known: Vec<(bool, SocketAddr)> =
                    self.known.iter().map(|(a, k)| (!k.good, *a)).collect();
                known.sort();
                let addresses = known.into_iter().take(MAX_NODES).map(|(_, a)| a).collect();
                self.send(net, peer, &Message::Nodes(addresses));
            }
            // Taken once, in answer to `getnodes`: a peer adds at most `MAX_NODES` addresses.
            Message::Nodes(addresses) => {
                let state = self.peers.get_mut(&peer).expect("a peer");
                if std::mem::take(&mut state.nodes_asked) {
                    let from = state.address.ip();
                    addresses.into_iter().for_each(|a| self.learn(a, from));
                }
            }
            Message::GetStateSnapshot { height, after } => {
                let (accounts, more) = self
                    .chain
                    .snapshot(height, after, MAX_SNAPSHOT_ACCOUNTS)?
                    .unwrap_or_default();
                let part = Message::StateSnapshot {
                    height,
                    accounts,
                    more,
                };
                self.send(net, peer, &part);
            }
            Message::StateSnapshot {
                height,
                accounts,
                more,
            } => self.take_snapshot(net, peer, height, &accounts, more)?,
        }
        Ok(())
    }

    /// The Node's locator, after the last header it stored on the way to a state snapshot.
    fn locator(&self) -> Result<Vec<[u8; 32]>, Error> {
        let mut locator = self.chain.locator()?;
        if let Some(id) = self.headers_tip {
            locator.insert(0, id);
            locator.truncate(message::MAX_LOCATOR);
        }
        Ok(locator)
    }

    /// The highest Checkpoint taken, if this Node prunes and its tip is more Blocks below it than
    /// it keeps: no other Node may still have them, so it starts from a state snapshot there.
    fn far_behind(&self) -> Result<Option<Checkpoint>, Error> {
        let (Some(keep), Some(checkpoint)) = (self.chain.keep(), self.chain.latest_checkpoint()?)
        else {
            return Ok(None);
        };
        let tip = self.chain.tip()?.height;
        Ok((tip.saturating_add(keep) < checkpoint.height).then_some(checkpoint))
    }

    /// Stores the headers of a sync without their Blocks, then asks `peer` for the state
    /// snapshot at `checkpoint` once its header is in.
    fn headers_to_checkpoint(
        &mut self,
        net: &mut impl Network,
        peer: PeerId,
        headers: &[Header],
        checkpoint: &Checkpoint,
    ) -> Result<(), Error> {
        match self.chain.submit_headers(headers) {
            Ok(()) => {}
            Err(Error::Rule(_) | Error::RefusedBranch) => {
                self.ban(net, peer);
                return Ok(());
            }
            // Not from where this Node asked: nothing to go on with.
            Err(Error::UnknownParent) => return Ok(()),
            Err(error) => return Err(error),
        }
        if let Some(last) = headers.last() {
            self.headers_tip = Some(last.id());
        }
        if self.chain.has_header(&checkpoint.block_id)? {
            if self.snapshot.is_none() {
                self.chain.begin_snapshot()?;
                self.snapshot = Some(Download {
                    peer,
                    height: checkpoint.height,
                    asked_at: self.now,
                    taken: 0,
                });
                let ask = Message::GetStateSnapshot {
                    height: checkpoint.height,
                    after: None,
                };
                self.send(net, peer, &ask);
            }
        } else if headers.len() == MAX_HEADERS {
            let locator = self.locator()?;
            self.send(net, peer, &Message::GetHeaders(locator));
        }
        Ok(())
    }

    /// Takes a part of the state snapshot this Node asked `peer` for, then asks for the next or
    /// checks the whole. A part out of the tree's key order, one that says more follow but is
    /// not full, accounts beyond what the Blocks below the Checkpoint could create, or a whole
    /// whose root is not the Checkpoint's bans `peer`, and nothing of it stays.
    fn take_snapshot(
        &mut self,
        net: &mut impl Network,
        peer: PeerId,
        height: u64,
        accounts: &[(Address, Account)],
        more: bool,
    ) -> Result<(), Error> {
        let Some(download) = self
            .snapshot
            .as_mut()
            .filter(|d| (d.peer, d.height) == (peer, height))
        else {
            // A part this Node did not ask for, or no longer wants.
            return Ok(());
        };
        // No honest Node sends either: it fills every part but the last, and no state at
        // `height` holds more accounts than its Blocks could create.
        download.taken = download.taken.saturating_add(accounts.len() as u64);
        let most = (MAX_NEW_ACCOUNTS as u64).saturating_mul(height);
        if (more && accounts.len() < MAX_SNAPSHOT_ACCOUNTS) || download.taken > most {
            self.chain.begin_snapshot()?;
            self.ban(net, peer);
            return Ok(());
        }
        let Some((last, _)) = accounts.last() else {
            // It does not serve that snapshot: another peer is asked at a later sync.
            self.snapshot = None;
            return Ok(());
        };
        if more {
            download.asked_at = self.now;
            let ask = Message::GetStateSnapshot {
                height,
                after: Some(tree_key(last)),
            };
            match self.chain.add_snapshot(accounts) {
                Ok(()) => self.send(net, peer, &ask),
                Err(Error::Rule(_)) => self.ban(net, peer),
                Err(error) => return Err(error),
            }
            return Ok(());
        }
        self.snapshot = None;
        let tip = self.chain.tip()?.id();
        let finished = self
            .chain
            .add_snapshot(accounts)
            .and_then(|()| self.chain.finish_snapshot(height));
        match finished {
            Ok(()) => {
                self.headers_tip = None;
                self.after_blocks(net, tip)?;
                let locator = self.locator()?;
                self.send(net, peer, &Message::GetHeaders(locator));
            }
            Err(Error::Rule(_)) => self.ban(net, peer),
            Err(error) => return Err(error),
        }
        Ok(())
    }

    /// Asks `peer` for the wanted Blocks this Node still lacks, so that at most `IN_FLIGHT`
    /// are on the way.
    // ponytail: every peer that announces a Block is asked for it; share one request among
    // peers if the duplicate bodies show.
    fn ask(&mut self, net: &mut impl Network, peer: PeerId) -> Result<(), Error> {
        loop {
            let Some(state) = self.peers.get_mut(&peer) else {
                return Ok(());
            };
            let room = IN_FLIGHT
                .saturating_sub(state.asked.len())
                .min(state.wanted.len());
            if room == 0 {
                return Ok(());
            }
            let next: Vec<[u8; 32]> = state.wanted.drain(..room).collect();
            let missing = self.chain.missing(&next)?;
            let state = self.peers.get_mut(&peer).expect("a peer");
            // Each once, and none already on the way.
            let ids: Vec<[u8; 32]> = missing
                .into_iter()
                .filter(|id| state.asked.insert(*id))
                .collect();
            if !ids.is_empty() {
                state.asked_at = self.now;
                self.send(net, peer, &Message::GetData(ids));
            }
        }
    }

    fn take_tx(
        &mut self,
        net: &mut impl Network,
        tx: Tx,
        from: Option<PeerId>,
    ) -> Result<Result<(), Refused>, Error> {
        self.pool.follow(&self.chain)?;
        let (_, state) = self.chain.state()?;
        let taken = self.pool.add(&state, tx.clone());
        if taken.is_ok() {
            self.broadcast(net, &Message::Tx(tx), from);
        }
        Ok(taken)
    }

    /// After Blocks or a Checkpoint came: the mempool follows, and the other Nodes hear of a new
    /// tip.
    fn after_blocks(&mut self, net: &mut impl Network, old_tip: [u8; 32]) -> Result<(), Error> {
        let tip = self.chain.tip()?.id();
        if tip != old_tip {
            self.pool.follow(&self.chain)?;
            self.broadcast(net, &Message::Inv(vec![tip]), None);
        }
        Ok(())
    }

    /// Keeps `address`, heard from the Node at `from`, to dial later.
    fn learn(&mut self, address: SocketAddr, from: IpAddr) {
        let ip = address.ip();
        // Not an address a Node takes connections on, or one that would point this Node at
        // services on its own host.
        let unusable = address.port() == 0
            || ip.is_unspecified()
            || ip.is_multicast()
            || (ip.is_loopback() && !from.is_loopback());
        if !unusable && self.known.len() < MAX_KNOWN && !self.own.contains(&address) {
            let known = Known {
                tried: 0,
                good: false,
            };
            self.known.entry(address).or_insert(known);
        }
    }

    /// Bans the peer's IP address for `BAN_SECONDS` and drops it. Each fault found so far is
    /// one no honest Node makes, so one is enough; a score comes with the first that is not.
    fn ban(&mut self, net: &mut impl Network, peer: PeerId) {
        if let Some(state) = self.peers.get(&peer) {
            let until = self.now.saturating_add(BAN_SECONDS);
            self.banned.insert(state.address.ip(), until);
            self.drop_peer(net, peer);
        }
    }

    fn drop_peer(&mut self, net: &mut impl Network, peer: PeerId) {
        self.forget(peer);
        net.disconnect(peer);
    }

    /// Forgets a peer that is gone, and the state snapshot it was sending.
    fn forget(&mut self, peer: PeerId) {
        self.peers.remove(&peer);
        if self.snapshot.as_ref().is_some_and(|d| d.peer == peer) {
            self.snapshot = None;
        }
    }

    fn send(&self, net: &mut impl Network, peer: PeerId, message: &Message) {
        net.send(peer, message.to_frame(self.magic));
    }

    /// Sends `message` to every ready peer but `except`.
    fn broadcast(&self, net: &mut impl Network, message: &Message, except: Option<PeerId>) {
        let frame = message.to_frame(self.magic);
        for (peer, state) in &self.peers {
            if state.ready && Some(*peer) != except {
                net.send(*peer, frame.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests;
