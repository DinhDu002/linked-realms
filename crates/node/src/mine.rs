//! The Mine: threads that hash Block templates of this Node with RandomX v2 and hand it the
//! Blocks they win (docs/plans/phase-2c-the-chain.md, "The Mine"). It is off whenever a Mine
//! starts, and only its owner turns it on (P5); nothing about it is kept on disk. What it reports
//! is what really runs.

use std::collections::VecDeque;
use std::num::NonZeroUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use linked_realms_core::Address;
use linked_realms_core::block::{Block, HEADER_LEN, key_height};
use linked_realms_core::u256::U256;
use linked_realms_randomx::{Dataset, Vm};
use tokio::sync::broadcast::error::TryRecvError;

use crate::pow::Keys;
use crate::run::Running;

/// Fast mode needs about 2 GiB for its dataset and some room besides.
pub const FAST_MEMORY: u64 = 5 * 1024 * 1024 * 1024 / 2;
/// A new template at least this often, for the transactions that came and the clock.
const REFRESH: Duration = Duration::from_secs(10);
/// The hash rate is measured over this window.
const WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Fast if `FAST_MEMORY` is available, else light.
    Auto,
    Fast,
    Light,
}

/// What each thread hashes over: a dataset (fast, about 2 GiB) or the cache (light, 256 MiB).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Memory {
    Fast,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Off,
    /// Building what the threads hash over, or waiting for the Node's first template.
    Starting,
    On,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub state: State,
    /// Threads hashing now.
    pub threads: usize,
    pub memory: Option<Memory>,
    /// Hashes a second over the last 10 seconds.
    pub hash_rate: f64,
    /// Blocks this Mine found that the Node took into its best chain.
    pub blocks_won: u64,
    pub reward_address: Option<Address>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Threads must be at least 1 and at most the Mine's cap.
    BadThreads,
}

/// The most threads a Mine may run here: one fewer than the cores, at least 1, and at most
/// `limit` if one is set (`MINE_MAX_THREADS`).
pub fn max_threads(limit: Option<usize>) -> usize {
    let cores = thread::available_parallelism().map_or(1, NonZeroUsize::get);
    let cap = cores.saturating_sub(1).max(1);
    limit.map_or(cap, |limit| limit.clamp(1, cap))
}

pub struct Mine<H> {
    running: Arc<Running<H>>,
    keys: Arc<Keys>,
    max_threads: usize,
    status: Arc<Mutex<Status>>,
    /// Ids of the Blocks this Mine found that the Node took into its best chain.
    won: Arc<Mutex<Vec<[u8; 32]>>>,
    at_work: Mutex<Option<(Arc<AtomicBool>, JoinHandle<()>)>>,
}

impl<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static> Mine<H> {
    /// A Mine for the Node `running`, off, running at most `max_threads` threads.
    pub fn new(running: Arc<Running<H>>, keys: Arc<Keys>, max_threads: usize) -> Self {
        Mine {
            running,
            keys,
            max_threads,
            status: Arc::new(Mutex::new(off(None))),
            won: Arc::default(),
            at_work: Mutex::new(None),
        }
    }

    /// Turns the Mine on with `threads` threads, paying `reward_address`; if it was on, it
    /// starts again with these.
    pub fn start(
        &self,
        reward_address: Address,
        threads: usize,
        mode: Mode,
    ) -> Result<Status, Refused> {
        if threads == 0 || threads > self.max_threads {
            return Err(Refused::BadThreads);
        }
        let mut at_work = self.at_work.lock().expect("not poisoned");
        stop(&mut at_work);
        let memory = memory_for(mode, available_memory());
        *self.status.lock().expect("not poisoned") = Status {
            state: State::Starting,
            reward_address: Some(reward_address),
            ..off(None)
        };
        let stopping = Arc::new(AtomicBool::new(false));
        let supervisor = Supervisor {
            running: self.running.clone(),
            keys: self.keys.clone(),
            status: self.status.clone(),
            won: self.won.clone(),
            stopping: stopping.clone(),
            reward_address,
            threads,
            memory,
        };
        let thread = thread::Builder::new()
            .name("lr-mine".into())
            .spawn(move || supervisor.work())
            .expect("a thread");
        *at_work = Some((stopping, thread));
        drop(at_work);
        Ok(self.status())
    }

    /// Turns the Mine off, once its threads have stopped; a dataset being built is finished
    /// first, about 20 seconds at most.
    pub fn stop(&self) -> Status {
        stop(&mut self.at_work.lock().expect("not poisoned"));
        self.status()
    }

    pub fn status(&self) -> Status {
        let mut status = self.status.lock().expect("not poisoned").clone();
        status.blocks_won = self.won.lock().expect("not poisoned").len() as u64;
        status
    }

    /// Whether this Mine found the Block `id` and the Node took it into its best chain.
    pub fn won(&self, id: &[u8; 32]) -> bool {
        self.won.lock().expect("not poisoned").contains(id)
    }
}

impl<H> Drop for Mine<H> {
    fn drop(&mut self) {
        stop(&mut self.at_work.lock().expect("not poisoned"));
    }
}

fn stop(at_work: &mut Option<(Arc<AtomicBool>, JoinHandle<()>)>) {
    if let Some((stopping, thread)) = at_work.take() {
        stopping.store(true, SeqCst);
        thread.join().expect("the Mine's thread");
    }
}

/// What `mode` hashes over with `available` bytes of memory free.
fn memory_for(mode: Mode, available: Option<u64>) -> Memory {
    match mode {
        Mode::Fast => Memory::Fast,
        Mode::Light => Memory::Light,
        Mode::Auto if available.is_some_and(|room| room >= FAST_MEMORY) => Memory::Fast,
        Mode::Auto => Memory::Light,
    }
}

fn off(reward_address: Option<Address>) -> Status {
    Status {
        state: State::Off,
        threads: 0,
        memory: None,
        hash_rate: 0.0,
        blocks_won: 0,
        reward_address,
    }
}

/// The header the threads hash, its nonce changing, and the Target it must beat.
struct Work {
    generation: AtomicU64,
    job: Mutex<([u8; HEADER_LEN], U256)>,
}

/// Runs the threads of a Mine that is on: gets templates from the Node, builds what the threads
/// hash over for each key, and hands the Node what they find.
struct Supervisor<H> {
    running: Arc<Running<H>>,
    keys: Arc<Keys>,
    status: Arc<Mutex<Status>>,
    won: Arc<Mutex<Vec<[u8; 32]>>>,
    stopping: Arc<AtomicBool>,
    reward_address: Address,
    threads: usize,
    memory: Memory,
}

impl<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static> Supervisor<H> {
    fn work(self) {
        // Each key's memory is built here, and yields like the hashing.
        lower_priority();
        let work = Arc::new(Work {
            generation: AtomicU64::new(0),
            job: Mutex::new(([0; HEADER_LEN], U256::ones(0))),
        });
        let hashes = Arc::new(AtomicU64::new(0));
        let (found, finds) = mpsc::channel();
        let mut crew = Crew::default();
        let mut key = None;
        let mut memory = self.memory;
        let mut rate = Rate::default();
        let reward_address = self.reward_address;
        while !self.stopping.load(SeqCst) {
            let Some(mut joined) = self.running.joined() else {
                break;
            };
            let template = self.running.call_blocking(move |node, _| {
                let block = node.pool.template(&node.chain, reward_address, now())?;
                let at = key_height(block.header.height);
                let key = node.chain.headers_from(at, 1)?.pop().expect("a Block").id();
                Ok::<_, crate::Error>((block, key))
            });
            let (mut block, new_key) = match template {
                None => break,
                Some(Ok(template)) => template,
                Some(Err(error)) => {
                    eprintln!("lr-node mine: no template: {error}");
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            // A new key: the threads on the old one stop before the new work is set, and new
            // ones start on it after.
            let vms = match key == Some(new_key) {
                true => None,
                false => {
                    self.set(|status| {
                        (status.state, status.threads, status.hash_rate) = (State::Starting, 0, 0.0)
                    });
                    crew.retire();
                    rate = Rate::default();
                    match self.vms(&new_key, &mut memory) {
                        Some(vms) => Some(vms),
                        None => break,
                    }
                }
            };
            *work.job.lock().expect("not poisoned") =
                (block.header.to_bytes(), block.header.target);
            let generation = work.generation.fetch_add(1, SeqCst) + 1;
            if let Some(vms) = vms {
                for (index, vm) in vms.into_iter().enumerate() {
                    let worker = Worker {
                        vm,
                        work: work.clone(),
                        hashes: hashes.clone(),
                        found: found.clone(),
                        retired: crew.retired.clone(),
                        stopping: self.stopping.clone(),
                        first: index as u64,
                        step: self.threads as u64,
                    };
                    let thread = thread::Builder::new()
                        .name(format!("lr-mine-{index}"))
                        .spawn(move || worker.work())
                        .expect("a thread");
                    crew.threads.push(thread);
                }
                key = Some(new_key);
            }
            let threads = crew.threads.len();
            self.set(|status| {
                (status.state, status.threads, status.memory) = (State::On, threads, Some(memory))
            });
            // Until a Block is found, the best chain moves, or the template is old.
            let since = Instant::now();
            while !self.stopping.load(SeqCst) && since.elapsed() < REFRESH {
                let hash_rate = rate.sample(Instant::now(), hashes.load(SeqCst));
                self.set(|status| status.hash_rate = hash_rate);
                match finds.recv_timeout(Duration::from_millis(100)) {
                    Ok((from, nonce)) if from == generation => {
                        block.header.nonce = nonce;
                        self.hand_over(block);
                        break;
                    }
                    // Found for a template since replaced.
                    Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => unreachable!("`found` is held here"),
                }
                if !matches!(joined.try_recv(), Err(TryRecvError::Empty)) {
                    break;
                }
            }
        }
        crew.retire();
        self.set(|status| *status = off(status.reward_address));
    }

    /// One VM for each thread over `key`'s memory; light if a dataset cannot be had.
    fn vms(&self, key: &[u8; 32], memory: &mut Memory) -> Option<Vec<Vm>> {
        let cache = self.keys.cache(key);
        let threads = NonZeroUsize::new(self.threads).expect("at least 1");
        let dataset = match *memory {
            // ponytail: the dataset is built when the key changes, about 20 seconds without
            // hashing every 2,048 Blocks; build it during the 64 Blocks before if that matters.
            Memory::Fast => match Dataset::new(&cache, threads, lower_priority) {
                Ok(dataset) => Some(Arc::new(dataset)),
                Err(error) => {
                    eprintln!("lr-node mine: no fast mode, light instead: {error}");
                    *memory = Memory::Light;
                    None
                }
            },
            Memory::Light => None,
        };
        let vms = (0..self.threads).map(|_| match &dataset {
            Some(dataset) => Vm::fast(dataset.clone(), true),
            None => Vm::light(cache.clone(), true),
        });
        match vms.collect::<Result<Vec<_>, _>>() {
            Ok(vms) => Some(vms),
            Err(error) => {
                eprintln!("lr-node mine: no RandomX VM: {error}");
                None
            }
        }
    }

    /// Gives the Node a Block this Mine found, and counts it if the Node took it as its tip.
    fn hand_over(&self, block: Block) {
        let id = block.header.id();
        let taken = self.running.call_blocking(move |node, tcp| {
            node.mined(tcp, &block)?;
            Ok::<_, crate::Error>(node.chain.tip()?.id() == id)
        });
        match taken {
            Some(Ok(true)) => self.won.lock().expect("not poisoned").push(id),
            Some(Ok(false)) | None => {}
            Some(Err(error)) => eprintln!("lr-node mine: the Node refused a found Block: {error}"),
        }
    }

    fn set(&self, change: impl FnOnce(&mut Status)) {
        change(&mut self.status.lock().expect("not poisoned"));
    }
}

/// The threads hashing over one key's memory.
#[derive(Default)]
struct Crew {
    retired: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Crew {
    /// Stops the threads and waits for them; the next ones are a new crew.
    fn retire(&mut self) {
        self.retired.store(true, SeqCst);
        for thread in self.threads.drain(..) {
            thread.join().expect("a Mine thread");
        }
        self.retired = Arc::default();
    }
}

struct Worker {
    vm: Vm,
    work: Arc<Work>,
    hashes: Arc<AtomicU64>,
    found: Sender<(u64, u64)>,
    retired: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    /// The thread's first nonce, and the step to its next: threads never hash the same nonce.
    first: u64,
    step: u64,
}

impl Worker {
    fn work(mut self) {
        lower_priority();
        let done = || self.retired.load(SeqCst) || self.stopping.load(SeqCst);
        while !done() {
            // The generation first: a job read after it is at least as new.
            let generation = self.work.generation.load(SeqCst);
            let (mut header, target) = *self.work.job.lock().expect("not poisoned");
            let mut nonce = self.first;
            // A look costs nothing beside a hash, so the thread looks before each one.
            while self.work.generation.load(SeqCst) == generation && !done() {
                header[HEADER_LEN - 8..].copy_from_slice(&nonce.to_be_bytes());
                if U256::from_be_bytes(self.vm.hash(&header)) < target {
                    let _ = self.found.send((generation, nonce));
                }
                nonce = nonce.wrapping_add(self.step);
                self.hashes.fetch_add(1, SeqCst);
            }
        }
    }
}

/// Hashes counted at moments over the last `WINDOW`.
#[derive(Default)]
struct Rate(VecDeque<(Instant, u64)>);

impl Rate {
    fn sample(&mut self, now: Instant, hashes: u64) -> f64 {
        self.0.push_back((now, hashes));
        while self.0.len() > 2 && now - self.0[1].0 >= WINDOW {
            self.0.pop_front();
        }
        let (since, before) = self.0[0];
        let seconds = (now - since).as_secs_f64();
        match seconds > 0.0 {
            true => (hashes - before) as f64 / seconds,
            false => 0.0,
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// Makes the calling thread yield to the Land and everything else on the machine.
fn lower_priority() {
    // SAFETY: plain system calls on the calling thread, with no pointers.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 19);
    }
    #[cfg(target_os = "macos")]
    unsafe {
        libc::setpriority(libc::PRIO_DARWIN_THREAD, 0, libc::PRIO_DARWIN_BG);
    }
}

/// Memory this process can still take, in bytes: on Linux the lower of what the system has
/// available and what its cgroup leaves (Docker shows the host's memory in `/proc/meminfo`);
/// on macOS the share of the memory the system says is available. `None` elsewhere.
pub fn available_memory() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let read = |path: &str| std::fs::read_to_string(path).ok();
        let system = read("/proc/meminfo").and_then(|text| mem_available(&text))?;
        let cgroup = [
            ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
            (
                "/sys/fs/cgroup/memory/memory.limit_in_bytes",
                "/sys/fs/cgroup/memory/memory.usage_in_bytes",
            ),
        ]
        .into_iter()
        .find_map(|(max, current)| cgroup_room(&read(max)?, &read(current)?));
        Some(cgroup.map_or(system, |room| room.min(system)))
    }
    #[cfg(target_os = "macos")]
    {
        let total: u64 = sysctl(c"hw.memsize")?;
        let level: u32 = sysctl(c"kern.memorystatus_level")?;
        Some(total / 100 * u64::from(level))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    None
}

#[cfg(target_os = "macos")]
fn sysctl<T: Default>(name: &std::ffi::CStr) -> Option<T> {
    let mut value = T::default();
    let mut len = size_of::<T>();
    // SAFETY: `value` is `len` bytes, and the kernel writes at most `len`.
    let failed = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&raw mut value).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (failed == 0 && len == size_of::<T>()).then_some(value)
}

/// `MemAvailable` of `/proc/meminfo`, in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mem_available(meminfo: &str) -> Option<u64> {
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// What a cgroup's limit leaves above its usage, in bytes; `None` without a limit.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn cgroup_room(max: &str, current: &str) -> Option<u64> {
    let max: u64 = max.trim().parse().ok()?;
    let current: u64 = current.trim().parse().ok()?;
    Some(max.saturating_sub(current))
}

#[cfg(test)]
mod tests;
