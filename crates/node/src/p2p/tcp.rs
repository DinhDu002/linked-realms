//! The `Network` over TCP, on threads: each connection has one that reads and one that writes,
//! so a slow Node holds up only its own connection.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread;
use std::time::Duration;

use super::{Event, Network, PeerId};

/// Bytes waiting to be written to one connection, at most; past it the connection is dropped.
const MAX_QUEUED: usize = 32 * 1024 * 1024;
/// Chunks read and not yet handled, at most, for all connections: a reader waits past it.
const MAX_READ_CHUNKS: usize = 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

enum Incoming {
    Stream(TcpStream, bool),
    Bytes(PeerId, Vec<u8>),
    Closed(PeerId),
}

struct Writer {
    frames: Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    stream: TcpStream,
}

pub struct Tcp {
    incoming: Receiver<Incoming>,
    sender: SyncSender<Incoming>,
    writers: HashMap<PeerId, Writer>,
    next_peer: PeerId,
    local: Option<SocketAddr>,
}

impl Tcp {
    /// A network that takes connections on `listen` if given, and only dials otherwise.
    pub fn new(listen: Option<SocketAddr>) -> io::Result<Self> {
        let (sender, incoming) = mpsc::sync_channel(MAX_READ_CHUNKS);
        let mut local = None;
        if let Some(address) = listen {
            let listener = TcpListener::bind(address)?;
            local = Some(listener.local_addr()?);
            let sender = sender.clone();
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    if sender.send(Incoming::Stream(stream, false)).is_err() {
                        return;
                    }
                }
            });
        }
        Ok(Tcp {
            incoming,
            sender,
            writers: HashMap::new(),
            next_peer: 0,
            local,
        })
    }

    /// The address it takes connections on.
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.local
    }

    /// The next event, or `None` if none came within `wait`.
    pub fn next(&mut self, wait: Duration) -> Option<Event> {
        loop {
            match self.incoming.recv_timeout(wait).ok()? {
                Incoming::Stream(stream, outbound) => {
                    let peer = self.next_peer;
                    self.next_peer += 1;
                    if let Ok(address) = self.open(peer, stream) {
                        return Some(Event::Connected {
                            peer,
                            address,
                            outbound,
                        });
                    }
                }
                // Late bytes of a connection the Node dropped are not for it.
                Incoming::Bytes(peer, bytes) if self.writers.contains_key(&peer) => {
                    return Some(Event::Received { peer, bytes });
                }
                Incoming::Bytes(..) => {}
                Incoming::Closed(peer) => {
                    if self.writers.remove(&peer).is_some() {
                        return Some(Event::Disconnected { peer });
                    }
                }
            }
        }
    }

    fn open(&mut self, peer: PeerId, stream: TcpStream) -> io::Result<SocketAddr> {
        let address = stream.peer_addr()?;
        stream.set_nodelay(true)?;
        let mut reader = stream.try_clone()?;
        let mut writer = stream.try_clone()?;
        let sender = self.sender.clone();
        thread::spawn(move || {
            let mut chunk = vec![0; 64 * 1024];
            while let Ok(n @ 1..) = reader.read(&mut chunk) {
                if sender
                    .send(Incoming::Bytes(peer, chunk[..n].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            let _ = sender.send(Incoming::Closed(peer));
        });
        let (frames, waiting) = mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(AtomicUsize::new(0));
        let written = queued.clone();
        thread::spawn(move || {
            for frame in waiting {
                if writer.write_all(&frame).is_err() {
                    break;
                }
                written.fetch_sub(frame.len(), Ordering::Relaxed);
            }
            let _ = writer.shutdown(Shutdown::Both);
        });
        let writer = Writer {
            frames,
            queued,
            stream,
        };
        self.writers.insert(peer, writer);
        Ok(address)
    }
}

impl Network for Tcp {
    fn send(&mut self, peer: PeerId, frame: Vec<u8>) {
        let Some(writer) = self.writers.get(&peer) else {
            return;
        };
        let queued = writer.queued.fetch_add(frame.len(), Ordering::Relaxed) + frame.len();
        // A Node that does not read is dropped; `Disconnected` follows from its reader.
        if queued > MAX_QUEUED || writer.frames.send(frame).is_err() {
            let _ = writer.stream.shutdown(Shutdown::Both);
        }
    }

    fn disconnect(&mut self, peer: PeerId) {
        if let Some(writer) = self.writers.remove(&peer) {
            let _ = writer.stream.shutdown(Shutdown::Both);
        }
    }

    fn dial(&mut self, address: SocketAddr) {
        let sender = self.sender.clone();
        thread::spawn(move || {
            if let Ok(stream) = TcpStream::connect_timeout(&address, DIAL_TIMEOUT) {
                let _ = sender.send(Incoming::Stream(stream, true));
            }
        });
    }
}
