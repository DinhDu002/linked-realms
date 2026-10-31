//! RandomX v2, LR's Proof of Work (ADR 0006): a safe binding to the reference implementation,
//! vendored in `vendor/` at tag v2.0.1, commit `aaafe71322df6602c21a5c72937ac284724ae561`.
//!
//! Every VM computes v2 hashes: the V2 flag is set on each one and cannot be cleared, because a
//! VM without it silently computes v1 hashes, and `randomx_get_flags()` does not return it.
//!
//! Light mode hashes from the 256 MiB [`Cache`]; fast mode from the 2080 MiB [`Dataset`] built
//! from it, several times faster. Both give the same hashes.

use std::ffi::{c_int, c_ulong, c_void};
use std::fmt;
use std::num::NonZeroUsize;
use std::ptr::{self, NonNull};
use std::sync::Arc;

/// The hand-written part of `vendor/src/randomx.h` this crate uses.
mod ffi {
    use std::ffi::{c_int, c_ulong, c_void};

    // `randomx_flags`, a C enum: an `int`.
    pub const FLAG_HARD_AES: c_int = 2;
    pub const FLAG_FULL_MEM: c_int = 4;
    pub const FLAG_JIT: c_int = 8;
    pub const FLAG_SECURE: c_int = 16;
    pub const FLAG_ARGON2: c_int = 96;
    pub const FLAG_V2: c_int = 128;

    #[repr(C)]
    pub struct Cache {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct Dataset {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct Vm {
        _private: [u8; 0],
    }

    unsafe extern "C" {
        pub fn randomx_get_flags() -> c_int;
        pub fn randomx_alloc_cache(flags: c_int) -> *mut Cache;
        pub fn randomx_init_cache(cache: *mut Cache, key: *const c_void, key_size: usize);
        pub fn randomx_release_cache(cache: *mut Cache);
        pub fn randomx_alloc_dataset(flags: c_int) -> *mut Dataset;
        pub fn randomx_dataset_item_count() -> c_ulong;
        pub fn randomx_init_dataset(
            dataset: *mut Dataset,
            cache: *mut Cache,
            start_item: c_ulong,
            item_count: c_ulong,
        );
        pub fn randomx_release_dataset(dataset: *mut Dataset);
        pub fn randomx_create_vm(flags: c_int, cache: *mut Cache, dataset: *mut Dataset)
        -> *mut Vm;
        pub fn randomx_destroy_vm(vm: *mut Vm);
        pub fn randomx_calculate_hash(
            vm: *mut Vm,
            input: *const c_void,
            input_size: usize,
            output: *mut c_void,
        );
    }
}

/// Memory RandomX could not allocate. The caller may fall back, from fast mode to light mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Cache,
    Dataset,
    Vm,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Cache => "could not allocate the RandomX Cache (256 MiB)",
            Error::Dataset => "could not allocate the RandomX Dataset (2080 MiB)",
            Error::Vm => "could not create a RandomX VM",
        })
    }
}

impl std::error::Error for Error {}

/// What this CPU and build support, as `randomx_get_flags()` reports it.
fn supported() -> c_int {
    unsafe { ffi::randomx_get_flags() }
}

/// The Cache for one key: 256 MiB, filled from the key by Argon2. Read-only once built, so one
/// Cache serves any number of VMs on any threads.
pub struct Cache(NonNull<ffi::Cache>);

// Built in `new`, then only read: by VMs in light mode and by `Dataset::new`'s threads.
unsafe impl Send for Cache {}
unsafe impl Sync for Cache {}

impl Cache {
    pub fn new(key: &[u8]) -> Result<Cache, Error> {
        // JIT here only speeds up building a Dataset; without it the Cache is the same.
        let flags = supported() & (ffi::FLAG_JIT | ffi::FLAG_ARGON2);
        let cache = [flags, flags & !ffi::FLAG_JIT]
            .into_iter()
            .find_map(|flags| NonNull::new(unsafe { ffi::randomx_alloc_cache(flags) }))
            .map(Cache)
            .ok_or(Error::Cache)?;
        unsafe { ffi::randomx_init_cache(cache.0.as_ptr(), key.as_ptr().cast(), key.len()) };
        Ok(cache)
    }
}

impl Drop for Cache {
    fn drop(&mut self) {
        unsafe { ffi::randomx_release_cache(self.0.as_ptr()) }
    }
}

/// The Dataset for one key: 2080 MiB computed from its Cache. Read-only once built.
pub struct Dataset(NonNull<ffi::Dataset>);

// Written only in `new`, each thread on its own items; then only read, by VMs in fast mode.
unsafe impl Send for Dataset {}
unsafe impl Sync for Dataset {}

impl Dataset {
    /// Builds the Dataset on `threads` threads, each calling `on_thread` first (to lower its
    /// priority, say). The Cache is not needed afterwards.
    pub fn new(
        cache: &Cache,
        threads: NonZeroUsize,
        on_thread: impl Fn() + Sync,
    ) -> Result<Dataset, Error> {
        let dataset = NonNull::new(unsafe { ffi::randomx_alloc_dataset(0) })
            .map(Dataset)
            .ok_or(Error::Dataset)?;
        let items = unsafe { ffi::randomx_dataset_item_count() };
        let threads = c_ulong::try_from(threads.get()).unwrap_or(c_ulong::MAX);
        // randomx.h allows several calls on items that do not overlap.
        std::thread::scope(|scope| {
            for (start, count) in runs(items, threads) {
                let (dataset, on_thread) = (&dataset, &on_thread);
                scope.spawn(move || {
                    on_thread();
                    unsafe {
                        ffi::randomx_init_dataset(
                            dataset.0.as_ptr(),
                            cache.0.as_ptr(),
                            start,
                            count,
                        )
                    }
                });
            }
        });
        Ok(dataset)
    }
}

/// `items` split into at most `threads` runs, `(start, count)`, that cover them all once. A
/// missed item would go unseen by the vectors: a hash reads about 16,000 of 34 million.
fn runs(items: c_ulong, threads: c_ulong) -> impl Iterator<Item = (c_ulong, c_ulong)> {
    let share = items.div_ceil(threads).max(1);
    (0..items)
        .step_by(share as usize)
        .map(move |start| (start, share.min(items - start)))
}

impl Drop for Dataset {
    fn drop(&mut self) {
        unsafe { ffi::randomx_release_dataset(self.0.as_ptr()) }
    }
}

/// Where a VM reads from, kept alive as long as the VM.
#[derive(Clone)]
enum Memory {
    Light(Arc<Cache>),
    Fast(Arc<Dataset>),
}

/// A RandomX VM: one per thread. It is `Send` but not `Sync`, as each hash changes its state.
pub struct Vm {
    vm: NonNull<ffi::Vm>,
    flags: c_int,
    _memory: Memory,
}

unsafe impl Send for Vm {}

impl Vm {
    /// A VM in light mode. With `jit`, it compiles each program when it can, and interprets it
    /// otherwise; [`Vm::jit`] says which.
    pub fn light(cache: Arc<Cache>, jit: bool) -> Result<Vm, Error> {
        Vm::new(Memory::Light(cache), jit)
    }

    /// A VM in fast mode, as [`Vm::light`] otherwise.
    pub fn fast(dataset: Arc<Dataset>, jit: bool) -> Result<Vm, Error> {
        Vm::new(Memory::Fast(dataset), jit)
    }

    fn new(memory: Memory, jit: bool) -> Result<Vm, Error> {
        let supported = supported();
        let interpreted = supported & ffi::FLAG_HARD_AES;
        if jit && supported & ffi::FLAG_JIT != 0 {
            // SECURE comes with JIT where the platform requires it (macOS on ARM).
            let compiled = interpreted | (supported & (ffi::FLAG_JIT | ffi::FLAG_SECURE));
            if let Ok(vm) = Vm::with_flags(memory.clone(), compiled) {
                return Ok(vm);
            }
        }
        Vm::with_flags(memory, interpreted)
    }

    /// The one place a VM is created, so V2 is always set.
    fn with_flags(memory: Memory, flags: c_int) -> Result<Vm, Error> {
        let (cache, dataset, mode) = match &memory {
            Memory::Light(cache) => (cache.0.as_ptr(), ptr::null_mut(), 0),
            Memory::Fast(dataset) => (ptr::null_mut(), dataset.0.as_ptr(), ffi::FLAG_FULL_MEM),
        };
        let flags = flags | mode | ffi::FLAG_V2;
        let vm = NonNull::new(unsafe { ffi::randomx_create_vm(flags, cache, dataset) })
            .ok_or(Error::Vm)?;
        Ok(Vm {
            vm,
            flags,
            _memory: memory,
        })
    }

    /// Whether this VM compiles its programs (JIT) rather than interpreting them.
    pub fn jit(&self) -> bool {
        self.flags & ffi::FLAG_JIT != 0
    }

    /// The RandomX v2 hash of `input`.
    pub fn hash(&mut self, input: &[u8]) -> [u8; 32] {
        let mut hash = [0; 32];
        unsafe {
            ffi::randomx_calculate_hash(
                self.vm.as_ptr(),
                input.as_ptr().cast::<c_void>(),
                input.len(),
                hash.as_mut_ptr().cast(),
            )
        };
        hash
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        unsafe { ffi::randomx_destroy_vm(self.vm.as_ptr()) }
    }
}

#[cfg(test)]
mod tests;
