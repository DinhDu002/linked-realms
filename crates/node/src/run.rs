//! A Node at work: one thread owns the Node and its network and does one thing at a time, an
//! event from another Node, a tick each second, or a call from the RPC, so the Node itself needs
//! no lock.

use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use linked_realms_core::block::{Block, Header};
use tokio::sync::{broadcast, oneshot};

use crate::Error;
use crate::p2p::{Node, Tcp, Waker};

/// The most headers announced for one change of the best chain: its last ones. A subscriber
/// that sees a gap reads what it missed (docs/protocols/node-rpc.md).
pub const JOINED: usize = 256;

/// A Block that joined the best chain, with its body if the Node holds it (not a state
/// snapshot's), read once for every subscriber.
#[derive(Debug)]
pub struct Joined {
    pub header: Header,
    pub block: Option<Block>,
}

/// Something to do on the Node's thread; `None` stops it.
type Call<H> = Option<Box<dyn FnOnce(&mut Node<H>, &mut Tcp) + Send>>;

pub struct Running<H> {
    calls: Sender<Call<H>>,
    waker: Waker,
    // Weak, so the channel closes when the Node's thread ends and subscribers hear of it.
    joined: broadcast::WeakSender<Arc<Joined>>,
    thread: Mutex<Option<JoinHandle<Result<(), Error>>>>,
}

impl<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static> Running<H> {
    /// Starts `node` on a thread of its own, on `tcp`.
    pub fn start(node: Node<H>, tcp: Tcp) -> Self {
        let (calls, inbox) = mpsc::channel();
        let (joined, _) = broadcast::channel(JOINED);
        let waker = tcp.waker();
        let weak = joined.downgrade();
        let thread = thread::Builder::new()
            .name("lr-node".into())
            .spawn(move || work(node, tcp, inbox, joined))
            .expect("a thread");
        Running {
            calls,
            waker,
            joined: weak,
            thread: Mutex::new(Some(thread)),
        }
    }

    /// Runs `call` on the Node's thread and gives back what it returns, or `None` if the Node
    /// stopped.
    pub async fn call<T: Send + 'static>(
        &self,
        call: impl FnOnce(&mut Node<H>, &mut Tcp) -> T + Send + 'static,
    ) -> Option<T> {
        self.send(call)?.await.ok()
    }

    /// As `call`, from a thread that is not async (the Mine's).
    pub fn call_blocking<T: Send + 'static>(
        &self,
        call: impl FnOnce(&mut Node<H>, &mut Tcp) -> T + Send + 'static,
    ) -> Option<T> {
        self.send(call)?.blocking_recv().ok()
    }

    fn send<T: Send + 'static>(
        &self,
        call: impl FnOnce(&mut Node<H>, &mut Tcp) -> T + Send + 'static,
    ) -> Option<oneshot::Receiver<T>> {
        let (reply, answer) = oneshot::channel();
        let call = Box::new(move |node: &mut Node<H>, tcp: &mut Tcp| {
            let _ = reply.send(call(node, tcp));
        });
        self.calls.send(Some(call)).ok()?;
        self.waker.wake();
        Some(answer)
    }

    /// Whether the Node's thread ended, asked to or not; `stop` says why.
    pub fn stopped(&self) -> bool {
        let thread = self.thread.lock().expect("not poisoned");
        thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// The Blocks that join the best chain from now on, lowest first; `None` if the Node
    /// stopped.
    pub fn joined(&self) -> Option<broadcast::Receiver<Arc<Joined>>> {
        self.joined.upgrade().map(|joined| joined.subscribe())
    }

    /// Stops the Node once it is done with what it is doing, and says why it stopped: `Ok` if it
    /// was asked to.
    pub fn stop(&self) -> Result<(), Error> {
        let _ = self.calls.send(None);
        self.waker.wake();
        let thread = self.thread.lock().expect("not poisoned").take();
        thread.map_or(Ok(()), |thread| thread.join().expect("the Node's thread"))
    }
}

fn work<H: Fn(&[u8], &[u8; 32]) -> [u8; 32]>(
    mut node: Node<H>,
    mut tcp: Tcp,
    inbox: Receiver<Call<H>>,
    joined: broadcast::Sender<Arc<Joined>>,
) -> Result<(), Error> {
    let mut tip = node.chain.tip()?.id();
    let mut ticked = 0;
    loop {
        if let Some(event) = tcp.next(Duration::from_secs(1)) {
            node.handle(&mut tcp, event, now())?;
        }
        // ponytail: every call waiting runs before the next event; a flood of calls would hold
        // up other Nodes' messages, and the RPC's rate limit is what bounds it.
        loop {
            match inbox.try_recv() {
                Ok(Some(call)) => call(&mut node, &mut tcp),
                Ok(None) | Err(TryRecvError::Disconnected) => return Ok(()),
                Err(TryRecvError::Empty) => break,
            }
        }
        let now = now();
        if now != ticked {
            node.tick(&mut tcp, now)?;
            ticked = now;
        }
        let new = node.chain.tip()?.id();
        if new != tip {
            if joined.receiver_count() > 0 {
                for header in node.chain.joined_since(&tip, JOINED as u64)? {
                    let block = node.chain.block(&header.id())?;
                    let _ = joined.send(Arc::new(Joined { header, block }));
                }
            }
            tip = new;
        }
    }
}

/// Unix seconds.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}
