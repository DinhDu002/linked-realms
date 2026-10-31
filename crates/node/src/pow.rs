//! RandomX v2 for a Node (ADR 0012): the Proof-of-Work hash its chain checks every header with,
//! and the caches it shares with its Mine.

use std::sync::{Arc, Mutex};

use linked_realms_randomx::{Cache, Vm};

/// RandomX caches by key, the last two, so the Blocks on both sides of a key change check without
/// building a cache again. The Node's checks and the Mine's light mode share them (256 MiB each).
#[derive(Default)]
pub struct Keys(Mutex<Vec<([u8; 32], Arc<Cache>)>>);

impl Keys {
    /// The cache for `key`, built if it is not held (a second or so).
    pub fn cache(&self, key: &[u8; 32]) -> Arc<Cache> {
        let mut held = self.0.lock().expect("not poisoned");
        if let Some(place) = held.iter().position(|(k, _)| k == key) {
            let entry = held.remove(place);
            held.push(entry);
        } else {
            let cache = Cache::new(key).expect("memory for a RandomX cache");
            held.push((*key, Arc::new(cache)));
            if held.len() > 2 {
                held.remove(0);
            }
        }
        held.last().expect("just held").1.clone()
    }
}

/// The Proof-of-Work hash for `Chain::open`: RandomX v2 in light mode, on the key's cache.
// ponytail: the next key's cache is built when its first Block comes, a second's wait every
// 2,048 Blocks; build it during the 64 Blocks before if that wait ever shows.
pub fn verifier(keys: Arc<Keys>) -> impl Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static {
    let vm: Mutex<Option<([u8; 32], Vm)>> = Mutex::new(None);
    move |bytes, key| {
        let mut vm = vm.lock().expect("not poisoned");
        if vm.as_ref().is_none_or(|(k, _)| k != key) {
            let light = Vm::light(keys.cache(key), true).expect("memory for a RandomX VM");
            *vm = Some((*key, light));
        }
        vm.as_mut().expect("just made").1.hash(bytes)
    }
}
