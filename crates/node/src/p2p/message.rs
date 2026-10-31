//! What Nodes send each other, and how it is framed: `magic (4) ‖ command (1) ‖ length (u32) ‖
//! checksum (4) ‖ payload`, the checksum being the start of `keccak256(payload)`. Every integer
//! is big-endian, as in `crates/core`.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use linked_realms_core::block::{Block, HEADER_LEN, Header};
use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::codec::Reader;
use linked_realms_core::state::{Account, PublicKey};
use linked_realms_core::tx::Tx;
use linked_realms_core::{ADDRESS_LEN, Address, PUBLIC_KEY_LEN, keccak256};

/// The largest payload: a Block of 1,000,000 bytes fits with room to spare.
pub const MAX_PAYLOAD: usize = 2 * 1024 * 1024;
pub const FRAME_HEADER_LEN: usize = 13;
pub const PROTOCOL_VERSION: u32 = 1;
/// Headers in one `headers` message, at most.
pub const MAX_HEADERS: usize = 2_000;
/// Ids in one `inv`, at most.
pub const MAX_IDS: usize = 500;
/// Blocks one `getdata` asks for, and ids in a `notfound`, at most: a Node has no more than this
/// on the way from one peer, so a peer that asks for more is not following the protocol.
pub const IN_FLIGHT: usize = 16;
/// Ids in a locator, at most.
pub const MAX_LOCATOR: usize = 64;
/// Addresses in one `nodes`, at most.
pub const MAX_NODES: usize = 1_000;
/// Accounts in one `statesnapshot`, at most: 1,000 with an ML-DSA-44 key take about 1.4 MB.
pub const MAX_SNAPSHOT_ACCOUNTS: usize = 1_000;
const _: () = assert!(
    11 + MAX_SNAPSHOT_ACCOUNTS * (ADDRESS_LEN + 8 + 8 + 2 + 1 + PUBLIC_KEY_LEN) <= MAX_PAYLOAD
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub version: u32,
    pub genesis: [u8; 32],
    pub height: u64,
    /// The port this Node takes connections on, or 0.
    pub listen: u16,
    /// Random, so a Node that dials itself sees its own.
    pub nonce: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Version(Version),
    Verack,
    Ping(u64),
    Pong(u64),
    /// Block ids the sender has.
    Inv(Vec<[u8; 32]>),
    GetData(Vec<[u8; 32]>),
    NotFound(Vec<[u8; 32]>),
    /// A locator (`Chain::locator`).
    GetHeaders(Vec<[u8; 32]>),
    Headers(Vec<Header>),
    Block(Block),
    Tx(Tx),
    Checkpoint(Box<Checkpoint>),
    GetCheckpoint,
    GetNodes,
    Nodes(Vec<SocketAddr>),
    /// The state at the Checkpoint at `height`, from the account after the key `after`.
    GetStateSnapshot {
        height: u64,
        after: Option<[u8; 32]>,
    },
    /// Accounts of the state at the Checkpoint at `height`, in the tree's key order, and whether
    /// more follow. None and no more: the sender does not serve it.
    StateSnapshot {
        height: u64,
        accounts: Vec<(Address, Account)>,
        more: bool,
    },
}

/// Why bytes are not a message. The connection that sent them is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Malformed {
    Magic,
    TooLarge,
    Checksum,
    /// A known command whose payload does not read.
    Payload,
}

impl Message {
    fn command(&self) -> u8 {
        match self {
            Message::Version(_) => 0,
            Message::Verack => 1,
            Message::Ping(_) => 2,
            Message::Pong(_) => 3,
            Message::Inv(_) => 4,
            Message::GetData(_) => 5,
            Message::NotFound(_) => 6,
            Message::GetHeaders(_) => 7,
            Message::Headers(_) => 8,
            Message::Block(_) => 9,
            Message::Tx(_) => 10,
            Message::Checkpoint(_) => 11,
            Message::GetCheckpoint => 12,
            Message::GetNodes => 13,
            Message::Nodes(_) => 14,
            Message::GetStateSnapshot { .. } => 15,
            Message::StateSnapshot { .. } => 16,
        }
    }

    fn payload(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        match self {
            Message::Version(v) => {
                bytes.extend_from_slice(&v.version.to_be_bytes());
                bytes.extend_from_slice(&v.genesis);
                bytes.extend_from_slice(&v.height.to_be_bytes());
                bytes.extend_from_slice(&v.listen.to_be_bytes());
                bytes.extend_from_slice(&v.nonce.to_be_bytes());
            }
            Message::Verack | Message::GetCheckpoint | Message::GetNodes => {}
            Message::Ping(nonce) | Message::Pong(nonce) => {
                bytes.extend_from_slice(&nonce.to_be_bytes())
            }
            Message::Inv(ids)
            | Message::GetData(ids)
            | Message::NotFound(ids)
            | Message::GetHeaders(ids) => {
                bytes.extend_from_slice(&(ids.len() as u16).to_be_bytes());
                ids.iter().for_each(|id| bytes.extend_from_slice(id));
            }
            Message::Headers(headers) => {
                bytes.extend_from_slice(&(headers.len() as u16).to_be_bytes());
                headers
                    .iter()
                    .for_each(|h| bytes.extend_from_slice(&h.to_bytes()));
            }
            Message::Block(block) => bytes = block.to_bytes(),
            Message::Tx(tx) => bytes = tx.to_bytes(),
            Message::Checkpoint(c) => {
                bytes.extend_from_slice(&c.height.to_be_bytes());
                bytes.extend_from_slice(&c.block_id);
                bytes.extend_from_slice(&c.signature);
            }
            Message::Nodes(addresses) => {
                bytes.extend_from_slice(&(addresses.len() as u16).to_be_bytes());
                for address in addresses {
                    let ip = match address.ip() {
                        IpAddr::V4(ip) => ip.to_ipv6_mapped(),
                        IpAddr::V6(ip) => ip,
                    };
                    bytes.extend_from_slice(&ip.octets());
                    bytes.extend_from_slice(&address.port().to_be_bytes());
                }
            }
            Message::GetStateSnapshot { height, after } => {
                bytes.extend_from_slice(&height.to_be_bytes());
                if let Some(key) = after {
                    bytes.extend_from_slice(key);
                }
            }
            // Each account: `address ‖ balance ‖ nonce ‖ key length (u16, 0 for none) ‖ scheme ‖
            // key`.
            Message::StateSnapshot {
                height,
                accounts,
                more,
            } => {
                bytes.extend_from_slice(&height.to_be_bytes());
                bytes.push(u8::from(*more));
                bytes.extend_from_slice(&(accounts.len() as u16).to_be_bytes());
                for (address, account) in accounts {
                    bytes.extend_from_slice(&address.to_bytes());
                    bytes.extend_from_slice(&account.balance.to_be_bytes());
                    bytes.extend_from_slice(&account.nonce.to_be_bytes());
                    let key = account
                        .key
                        .as_ref()
                        .map_or(Vec::new(), |key| [&[key.scheme][..], &key.bytes].concat());
                    bytes.extend_from_slice(&(key.len() as u16).to_be_bytes());
                    bytes.extend_from_slice(&key);
                }
            }
        }
        bytes
    }

    /// The message as a frame for the network `magic`.
    pub fn to_frame(&self, magic: [u8; 4]) -> Vec<u8> {
        let payload = self.payload();
        let mut frame = magic.to_vec();
        frame.push(self.command());
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&keccak256(&[&payload])[..4]);
        frame.extend_from_slice(&payload);
        frame
    }

    /// Reads a payload. `None` for a command this Node does not know: a later version may add
    /// commands, and they are skipped.
    fn read(command: u8, payload: &[u8]) -> Result<Option<Message>, Malformed> {
        let mut r = Reader::new(payload);
        let ids =
            |r: &mut Reader, max: usize| -> Result<Vec<[u8; 32]>, linked_realms_core::Error> {
                let count = usize::from(r.u16()?);
                if count > max {
                    return Err(linked_realms_core::Error::Truncated);
                }
                (0..count).map(|_| r.array()).collect()
            };
        let message = (|| {
            Ok(Some(match command {
                0 => Message::Version(Version {
                    version: r.u32()?,
                    genesis: r.array()?,
                    height: r.u64()?,
                    listen: r.u16()?,
                    nonce: r.u64()?,
                }),
                1 => Message::Verack,
                2 => Message::Ping(r.u64()?),
                3 => Message::Pong(r.u64()?),
                4 => Message::Inv(ids(&mut r, MAX_IDS)?),
                5 => Message::GetData(ids(&mut r, IN_FLIGHT)?),
                6 => Message::NotFound(ids(&mut r, IN_FLIGHT)?),
                7 => Message::GetHeaders(ids(&mut r, MAX_LOCATOR)?),
                8 => {
                    let count = usize::from(r.u16()?);
                    if count > MAX_HEADERS {
                        return Err(linked_realms_core::Error::Truncated);
                    }
                    let headers = (0..count)
                        .map(|_| Header::from_bytes(r.bytes(HEADER_LEN)?))
                        .collect::<Result<_, _>>()?;
                    Message::Headers(headers)
                }
                9 => return Block::from_bytes(payload).map(|b| Some(Message::Block(b))),
                10 => return Tx::from_bytes(payload).map(|tx| Some(Message::Tx(tx))),
                11 => Message::Checkpoint(Box::new(Checkpoint {
                    height: r.u64()?,
                    block_id: r.array()?,
                    signature: r.array()?,
                })),
                12 => Message::GetCheckpoint,
                13 => Message::GetNodes,
                14 => {
                    let count = usize::from(r.u16()?);
                    if count > MAX_NODES {
                        return Err(linked_realms_core::Error::Truncated);
                    }
                    let mut addresses = Vec::with_capacity(count);
                    for _ in 0..count {
                        let ip = Ipv6Addr::from(r.array::<16>()?);
                        let ip = ip.to_ipv4_mapped().map_or(IpAddr::V6(ip), IpAddr::V4);
                        addresses.push(SocketAddr::new(ip, r.u16()?));
                    }
                    Message::Nodes(addresses)
                }
                15 => Message::GetStateSnapshot {
                    height: r.u64()?,
                    after: match payload.len() {
                        8 => None,
                        _ => Some(r.array()?),
                    },
                },
                16 => {
                    let (height, more) = (r.u64()?, r.u8()?);
                    let count = usize::from(r.u16()?);
                    if more > 1 || count > MAX_SNAPSHOT_ACCOUNTS {
                        return Err(linked_realms_core::Error::Truncated);
                    }
                    let mut accounts = Vec::with_capacity(count);
                    for _ in 0..count {
                        let address = r.address()?;
                        let (balance, nonce) = (r.u64()?, r.u64()?);
                        let len = usize::from(r.u16()?);
                        let key = r
                            .bytes(len)?
                            .split_first()
                            .map(|(&scheme, bytes)| PublicKey {
                                scheme,
                                bytes: bytes.to_vec(),
                            });
                        let account = Account {
                            balance,
                            nonce,
                            key,
                        };
                        accounts.push((address, account));
                    }
                    Message::StateSnapshot {
                        height,
                        accounts,
                        more: more == 1,
                    }
                }
                _ => return Ok(None),
            }))
        })();
        let message = message.map_err(|_| Malformed::Payload)?;
        if message.is_some() && !matches!(command, 9 | 10) {
            r.finish().map_err(|_| Malformed::Payload)?;
        }
        Ok(message)
    }
}

/// Takes the first whole frame off `buffer`: `Ok(None)` until all of it has come. A frame
/// header that claims more than `MAX_PAYLOAD` is refused at once, before its payload comes.
/// An unknown command gives `Ok(Some(None))`.
pub fn next_frame(
    buffer: &mut Vec<u8>,
    magic: [u8; 4],
) -> Result<Option<Option<Message>>, Malformed> {
    if buffer.len() < FRAME_HEADER_LEN {
        return Ok(None);
    }
    if buffer[..4] != magic {
        return Err(Malformed::Magic);
    }
    let len = u32::from_be_bytes(buffer[5..9].try_into().expect("4 bytes")) as usize;
    if len > MAX_PAYLOAD {
        return Err(Malformed::TooLarge);
    }
    if buffer.len() < FRAME_HEADER_LEN + len {
        return Ok(None);
    }
    let frame: Vec<u8> = buffer.drain(..FRAME_HEADER_LEN + len).collect();
    let payload = &frame[FRAME_HEADER_LEN..];
    if keccak256(&[payload])[..4] != frame[9..13] {
        return Err(Malformed::Checksum);
    }
    Message::read(frame[4], payload).map(Some)
}
