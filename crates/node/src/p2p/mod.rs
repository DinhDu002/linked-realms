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

use linked_realms_core::block::Block;
use linked_realms_core::params::ChainParams;
use linked_realms_core::tx::Tx;

pub use message::{MAX_HEADERS, MAX_IDS, MAX_NODES, MAX_PAYLOAD, Malformed, Message, Version};
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
/// Blocks asked of one peer and not yet come, at most.
pub const IN_FLIGHT: usize = 16;
/// A peer that sends none of the Blocks asked of it for this long is dropped.
pub const STALL_SECONDS: u64 = 120;
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
    /// Blocks to ask it for, lowest first.
    wanted: VecDeque<[u8; 32]>,
    /// Blocks asked of it and not yet come, and when it was last asked.
    asked: usize,
    asked_at: u64,
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
    /// Addresses other Nodes take connections on, with when this Node last dialed each.
    known: HashMap<SocketAddr, u64>,
    /// Addresses that turned out to be this Node.
    own: HashSet<SocketAddr>,
    /// Counts ticks, to ask each peer for headers in turn.
    ticks: usize,
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
            known: seeds.iter().map(|seed| (*seed, 0)).collect(),
            own: HashSet::new(),
            ticks: 0,
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
                    wanted: VecDeque::new(),
                    asked: 0,
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
                    match message::next_frame(&mut state.buffer, self.magic) {
                        Ok(None) => break,
                        Ok(Some(None)) => {}
                        Ok(Some(Some(message))) => self.on_message(net, peer, message)?,
                        // Another network's Node: dropped, not banned.
                        Err(Malformed::Magic) => self.drop_peer(net, peer),
                        Err(_) => self.ban(net, peer),
                    }
                }
            }
            Event::Disconnected { peer } => {
                self.peers.remove(&peer);
            }
        }
        Ok(())
    }

    /// What this Node does on its own at the time `now`: lifts bans that ended, drops peers
    /// that stall, dials more Nodes, and asks one idle peer for headers, which also takes a
    /// Block once the clock catches up with it and asks again for a body this Node dropped.
    pub fn tick(&mut self, net: &mut impl Network, now: u64) -> Result<(), Error> {
        self.now = now;
        self.banned.retain(|_, until| *until > now);
        let stalled: Vec<PeerId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.asked > 0 && p.asked_at.saturating_add(STALL_SECONDS) < now)
            .map(|(id, _)| *id)
            .collect();
        stalled
            .into_iter()
            .for_each(|peer| self.drop_peer(net, peer));

        let outbound = self.peers.values().filter(|p| p.outbound).count();
        let connected: HashSet<IpAddr> = self.peers.values().map(|p| p.address.ip()).collect();
        let mut dial: Vec<SocketAddr> = self
            .known
            .iter()
            .filter(|(address, tried)| {
                tried.saturating_add(RETRY_SECONDS) <= now
                    && !connected.contains(&address.ip())
                    && !self.banned.contains_key(&address.ip())
                    && !self.own.contains(*address)
            })
            .map(|(address, _)| *address)
            .collect();
        dial.sort();
        for address in dial.into_iter().take(OUTBOUND.saturating_sub(outbound)) {
            self.known.insert(address, now);
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
            if state.asked == 0 && state.wanted.is_empty() {
                let locator = self.chain.locator()?;
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
                if version.listen != 0 {
                    let address = SocketAddr::new(state.address.ip(), version.listen);
                    self.learn(address);
                }
                self.send(net, peer, &Message::Verack);
            }
            Message::Verack => {
                self.peers.get_mut(&peer).expect("a peer").ready = true;
                let locator = self.chain.locator()?;
                self.send(net, peer, &Message::GetHeaders(locator));
                self.send(net, peer, &Message::GetCheckpoint);
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
                state.asked = state.asked.saturating_sub(ids.len());
                self.ask(net, peer)?;
            }
            Message::GetHeaders(locator) => {
                let headers = self.chain.headers_after(&locator, MAX_HEADERS as u64)?;
                self.send(net, peer, &Message::Headers(headers));
            }
            Message::Headers(headers) => {
                // Nothing at or above a header too far ahead of the clock.
                let ids: Vec<[u8; 32]> = headers
                    .iter()
                    .take_while(|h| h.timestamp <= self.now.saturating_add(MAX_AHEAD))
                    .map(|h| h.id())
                    .collect();
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
                let syncing = state.asked > 0;
                state.asked = state.asked.saturating_sub(1);
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
                if more || (syncing && state.asked == 0 && state.wanted.is_empty()) {
                    let locator = self.chain.locator()?;
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
                let mut addresses: Vec<SocketAddr> = self.known.keys().copied().collect();
                addresses.sort();
                addresses.truncate(MAX_NODES);
                self.send(net, peer, &Message::Nodes(addresses));
            }
            Message::Nodes(addresses) => addresses.into_iter().for_each(|a| self.learn(a)),
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
                .saturating_sub(state.asked)
                .min(state.wanted.len());
            if room == 0 {
                return Ok(());
            }
            let next: Vec<[u8; 32]> = state.wanted.drain(..room).collect();
            let ids = self.chain.missing(&next)?;
            if !ids.is_empty() {
                let state = self.peers.get_mut(&peer).expect("a peer");
                state.asked += ids.len();
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

    fn learn(&mut self, address: SocketAddr) {
        if self.known.len() < MAX_KNOWN && !self.own.contains(&address) {
            self.known.entry(address).or_insert(0);
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
        self.peers.remove(&peer);
        net.disconnect(peer);
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
