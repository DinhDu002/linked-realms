use linked_realms_core::block::Header;
use linked_realms_core::params::DEV;

use super::*;
use crate::chain::tests::File;
use crate::mempool::tests::key;
use crate::p2p::{Node, Tcp};
use crate::pow::verifier;
use crate::{Chain, Mempool, Policy};

type Verifier = Box<dyn Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send>;

/// A dev-network Node at work on `file`, checking Proof of Work with RandomX as a real one does.
fn dev_node(file: &File, keys: &Arc<Keys>) -> Arc<Running<Verifier>> {
    let verifier: Verifier = Box::new(verifier(keys.clone()));
    let chain = Chain::open(file.path(), DEV, verifier).unwrap();
    let node = Node::new(chain, Mempool::new(DEV, Policy::default()), &DEV, 0, &[]);
    Arc::new(Running::start(node, Tcp::new(None).unwrap()))
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(300);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_dev_network_node_and_its_mine_win_blocks_and_count_only_their_own() {
    let file = File::new("mine-dev");
    let keys = Arc::new(Keys::default());
    let running = dev_node(&file, &keys);
    let threads = 2.min(max_threads(None));
    let mine = Mine::new(running.clone(), keys.clone(), threads);
    assert_eq!(mine.status(), off(None));
    let reward = key(1).address();

    let started = mine.start(reward, threads, Mode::Light).unwrap();
    assert_eq!(started.state, State::Starting);
    assert_eq!(started.reward_address, Some(reward));
    wait_for("2 Blocks won", || mine.status().blocks_won >= 2);
    let status = mine.status();
    assert_eq!(status.state, State::On);
    assert_eq!(
        (status.threads, status.memory),
        (threads, Some(Memory::Light))
    );
    assert!(status.hash_rate > 0.0, "{status:?}");
    let stopped = mine.stop();
    assert_eq!(
        stopped,
        Status {
            blocks_won: stopped.blocks_won,
            ..off(Some(reward))
        }
    );

    // Every Block counted is on the best chain and pays the reward address.
    let won = mine.won.lock().unwrap().clone();
    let on_chain = running
        .call_blocking(move |node, _| {
            won.iter()
                .map(|id| {
                    let header = node.chain.header(id).unwrap().unwrap();
                    let best = node.chain.headers_from(header.height, 1).unwrap();
                    (best == [header], header.reward_address)
                })
                .collect::<Vec<_>>()
        })
        .unwrap();
    assert!(
        on_chain.iter().all(|seen| *seen == (true, reward)),
        "{on_chain:?}"
    );

    // A Block paying the same address that this Mine did not find is not counted.
    let template = running
        .call_blocking(move |node, _| {
            let block = node.pool.template(&node.chain, reward, now()).unwrap();
            let at = key_height(block.header.height);
            let key = node.chain.headers_from(at, 1).unwrap()[0].id();
            (block, key)
        })
        .unwrap();
    let (mut block, key) = template;
    let mut vm = Vm::light(keys.cache(&key), true).unwrap();
    while U256::from_be_bytes(vm.hash(&block.header.to_bytes())) >= block.header.target {
        block.header.nonce += 1;
    }
    let id = block.header.id();
    let tip = running
        .call_blocking(move |node, _| {
            node.chain.submit_block(&block).unwrap();
            node.chain.tip().unwrap().id()
        })
        .unwrap();
    assert_eq!(tip, id);
    assert!(!mine.won(&id));
    assert_eq!(mine.status().blocks_won, stopped.blocks_won);
    drop(mine);
    running.stop().unwrap();
}

#[test]
fn a_mine_is_off_whenever_it_starts_and_its_threads_are_capped() {
    let file = File::new("mine-off");
    let keys = Arc::new(Keys::default());
    let running = dev_node(&file, &keys);
    let cap = max_threads(None);
    let cores = thread::available_parallelism().unwrap().get();
    assert_eq!(cap, (cores - 1).max(1), "one fewer than the cores");
    assert_eq!(max_threads(Some(1)), 1);
    assert_eq!(max_threads(Some(0)), 1);
    assert_eq!(max_threads(Some(usize::MAX)), cap);
    let mine = Mine::new(running.clone(), keys.clone(), 1);
    let reward = key(1).address();
    assert_eq!(mine.start(reward, 0, Mode::Light), Err(Refused::BadThreads));
    assert_eq!(mine.start(reward, 2, Mode::Light), Err(Refused::BadThreads));
    assert_eq!(mine.status(), off(None));

    mine.start(reward, 1, Mode::Light).unwrap();
    wait_for("on", || mine.status().state == State::On);
    // Started again with other settings, it runs with those.
    let other = key(2).address();
    mine.start(other, 1, Mode::Light).unwrap();
    wait_for("on again", || mine.status().state == State::On);
    assert_eq!(mine.status().reward_address, Some(other));

    // The Node and its Mine start again, and the Mine is off.
    drop(mine);
    running.stop().unwrap();
    drop(running);
    let running = dev_node(&file, &keys);
    let mine = Mine::new(running.clone(), keys, 1);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(mine.status(), off(None));
    drop(mine);
    running.stop().unwrap();
}

#[test]
fn a_mine_moves_to_the_next_key_when_it_comes() {
    // From this height a Block's RandomX key is Block 2048's, not the genesis's.
    const SWITCH: u64 = 2112;
    let file = File::new("mine-key");
    let keys = Arc::new(Keys::default());
    // Below the Mine's first Block the Node takes any nonce, so the test lays those Blocks down
    // fast; from it, RandomX with the key the chain picks.
    let real = verifier(keys.clone());
    let verifier: Verifier = Box::new(move |bytes, key| match Header::from_bytes(bytes) {
        Ok(header) if header.height < SWITCH - 1 => [0; 32],
        _ => real(bytes, key),
    });
    let chain = Chain::open(file.path(), DEV, verifier).unwrap();
    let reward = key(1).address();
    for _ in 1..SWITCH - 1 {
        let block = chain.template(reward, Vec::new(), 0).unwrap();
        chain.submit_block(&block).unwrap();
    }
    let node = Node::new(chain, Mempool::new(DEV, Policy::default()), &DEV, 0, &[]);
    let running = Arc::new(Running::start(node, Tcp::new(None).unwrap()));
    let threads = 2.min(max_threads(None));
    let mine = Mine::new(running.clone(), keys, threads);

    // Block 2111 on the genesis's key, then 2112 and 2113 on the next one.
    mine.start(reward, threads, Mode::Light).unwrap();
    // Counted once the Node took them, so after the tip moved.
    wait_for("3 Blocks won", || mine.status().blocks_won >= 3);
    let tip = running.call_blocking(|node, _| node.chain.tip().unwrap().height);
    assert!(tip >= Some(SWITCH + 1), "{tip:?}");
    let status = mine.status();
    assert_eq!(
        (status.state, status.threads),
        (State::On, threads),
        "the old threads retired"
    );
    drop(mine);
    running.stop().unwrap();
}

#[test]
fn auto_mode_is_fast_with_room_for_the_dataset() {
    assert_eq!(memory_for(Mode::Auto, Some(FAST_MEMORY)), Memory::Fast);
    assert_eq!(memory_for(Mode::Auto, Some(FAST_MEMORY - 1)), Memory::Light);
    assert_eq!(memory_for(Mode::Auto, None), Memory::Light);
    assert_eq!(memory_for(Mode::Fast, Some(0)), Memory::Fast);
    assert_eq!(memory_for(Mode::Light, Some(u64::MAX)), Memory::Light);
}

#[test]
fn a_mine_stops_when_its_node_does() {
    let file = File::new("mine-node-stops");
    let keys = Arc::new(Keys::default());
    let running = dev_node(&file, &keys);
    let mine = Mine::new(running.clone(), keys, 1);
    mine.start(key(1).address(), 1, Mode::Light).unwrap();
    wait_for("on", || mine.status().state == State::On);
    running.stop().unwrap();
    wait_for("off", || mine.status().state == State::Off);
    assert_eq!(mine.status().threads, 0);
}

#[test]
fn mining_threads_run_at_low_priority() {
    let priority = thread::spawn(|| {
        lower_priority();
        // SAFETY: plain system calls on the calling thread, with no pointers.
        #[cfg(target_os = "linux")]
        let priority = unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as _) };
        #[cfg(target_os = "macos")]
        let priority = unsafe { libc::getpriority(libc::PRIO_DARWIN_THREAD, 0) };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let priority = 0;
        priority
    })
    .join()
    .unwrap();
    #[cfg(target_os = "linux")]
    assert_eq!(priority, 19);
    #[cfg(target_os = "macos")]
    assert_eq!(priority, 1);
    let _ = priority;
}

#[test]
fn the_hash_rate_is_over_the_last_ten_seconds() {
    let mut rate = Rate::default();
    let start = Instant::now();
    let at = |seconds: u64| start + Duration::from_secs(seconds);
    assert_eq!(rate.sample(at(0), 0), 0.0);
    assert_eq!(rate.sample(at(1), 100), 100.0);
    assert_eq!(rate.sample(at(10), 1_000), 100.0);
    // A burst after a quiet minute shows only over its window.
    assert_eq!(rate.sample(at(70), 1_000), 0.0);
    assert_eq!(rate.sample(at(80), 3_000), 200.0);
}

#[test]
fn the_memory_available_reads_the_system_and_the_cgroup() {
    let meminfo = "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8192000 kB\n";
    assert_eq!(mem_available(meminfo), Some(8_192_000 * 1024));
    assert_eq!(mem_available("MemTotal: 1 kB\n"), None);
    assert_eq!(cgroup_room("max\n", "1000\n"), None);
    assert_eq!(cgroup_room("4096\n", "1000\n"), Some(3096));
    assert_eq!(cgroup_room("1000\n", "4096\n"), Some(0));
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    assert!(available_memory().is_some_and(|room| room > 0));
}
