//! The official v2 vectors in every mode, and the vendored tree's checksum.

use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;

/// `test_a` to `test_e` of `vendor/src/tests/tests.cpp` at tag v2.0.1: key, input, the v2 hash
/// and the v1 hash. Keys and text inputs are hashed without their terminating zero byte.
const VECTORS: [(&str, &str, &str, &str); 5] = [
    (
        "test key 000",
        "This is a test",
        "22ec6b861b3eb23686b2efbad69513c967ecfce80983df66c9c5b4fbfb4cdb6f",
        "639183aae1bf4c9a35884cb46b09cad9175f04efd7684e7262a0ac1c2f0b4e3f",
    ),
    (
        "test key 000",
        "Lorem ipsum dolor sit amet",
        "9e2c772c12fd48f93c14c97fdc89d556264d9100597023f44d9163e279012ecf",
        "300a0adb47603dedb42228ccb2b211104f4da45af709cd7547cd049e9489c969",
    ),
    (
        "test key 000",
        "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua",
        "4d6b063a1a603751d525f18a171336a4002f2f06df6c17e4b25fe17e17796e42",
        "c36d4ed4191e617309867ed66a443be4075014e2b061bcdaf9ce7b721d2b77a8",
    ),
    (
        "test key 001",
        "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua",
        "97024134686ce27d362ea8d86d8ef16483ac272abdabd46ef13359400777fe5e",
        "e9ff4503201c0c2cca26d285c93ae883f9b1d30c9eb240b820756f2d5a7905fc",
    ),
    (
        "test key 001",
        // calcHexHash: this input is hex, hashed as its 76 bytes.
        "0b0b98bea7e805e0010a2126d287a2a0cc833d312cb786385a7c2f9de69d25537f584a9bc9977b00000000666fd8753bf61a8631f12984e3fd44f4014eca629276817b56f32e9b68bd82f416",
        "c8e92c5f7c1946fecf06bc382b92e3111da38ee3e6a5ad90704e1a9d8aaf6e76",
        "c56414121acda1713c2f2a819d8ae38aed7c80c35c2a769298d34f03833cd5f1",
    ),
];

const KEYS: [&str; 2] = ["test key 000", "test key 001"];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn input(vector: usize) -> Vec<u8> {
    let text = VECTORS[vector].1;
    if vector < 4 {
        return text.as_bytes().to_vec();
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// Checks every vector of `key` on `vm`.
fn check(vm: &mut Vm, key: &str, mode: &str) {
    for (i, (_, _, v2, v1)) in VECTORS.iter().enumerate() {
        if VECTORS[i].0 != key {
            continue;
        }
        let hash = hex(&vm.hash(&input(i)));
        assert_ne!(&hash, v1, "{mode}, vector {i}: a v1 hash");
        assert_eq!(&hash, v2, "{mode}, vector {i}");
    }
}

/// Every set of flags this machine supports: the interpreter and, where RandomX has one, the
/// JIT, each with software AES and, where the CPU has it, hardware AES.
fn flag_sets() -> Vec<(c_int, String)> {
    let supported = supported();
    let mut sets = vec![(0, "interpreter".to_string())];
    if supported & ffi::FLAG_JIT != 0 {
        sets.push((supported & (ffi::FLAG_JIT | ffi::FLAG_SECURE), "JIT".into()));
    }
    if supported & ffi::FLAG_HARD_AES != 0 {
        let hard: Vec<_> = (sets.iter())
            .map(|(flags, name)| (flags | ffi::FLAG_HARD_AES, format!("{name}, hardware AES")))
            .collect();
        sets.extend(hard);
    }
    sets
}

#[test]
fn x86_64_and_arm64_have_the_jit_and_hardware_aes() {
    let has = supported();
    if cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
        assert_ne!(has & ffi::FLAG_JIT, 0);
        assert_ne!(has & ffi::FLAG_HARD_AES, 0);
    }
}

#[test]
fn light_mode_gives_the_official_v2_hashes() {
    for key in KEYS {
        let cache = Arc::new(Cache::new(key.as_bytes()).unwrap());
        for (flags, name) in flag_sets() {
            let mut vm = Vm::with_flags(Memory::Light(cache.clone()), flags).unwrap();
            check(&mut vm, key, &format!("light, {name}"));
        }
    }
}

#[test]
fn fast_mode_gives_the_official_v2_hashes() {
    let threads = std::thread::available_parallelism().unwrap();
    for key in KEYS {
        let dataset = {
            let cache = Cache::new(key.as_bytes()).unwrap();
            Arc::new(Dataset::new(&cache, threads).unwrap())
        };
        for (flags, name) in flag_sets() {
            let mut vm = Vm::with_flags(Memory::Fast(dataset.clone()), flags).unwrap();
            check(&mut vm, key, &format!("fast, {name}"));
        }
    }
}

#[test]
fn dataset_runs_cover_every_item_once() {
    let items = unsafe { ffi::randomx_dataset_item_count() };
    for (items, threads) in [(items, 1), (items, 7), (items, 16), (10, 3), (3, 8), (0, 4)] {
        let runs: Vec<_> = runs(items, threads).collect();
        assert!(
            runs.len() as c_ulong <= threads,
            "{items} items, {threads} threads"
        );
        let mut next = 0;
        for (start, count) in runs {
            assert_eq!(start, next, "{items} items, {threads} threads");
            assert!(count > 0);
            next += count;
        }
        assert_eq!(next, items, "{items} items, {threads} threads");
    }
}

#[test]
fn a_vm_compiles_only_when_asked_and_able() {
    let cache = Arc::new(Cache::new(KEYS[0].as_bytes()).unwrap());
    let mut interpreted = Vm::light(cache.clone(), false).unwrap();
    assert!(!interpreted.jit());
    check(&mut interpreted, KEYS[0], "Vm::light without JIT");
    let mut compiled = Vm::light(cache, true).unwrap();
    assert_eq!(compiled.jit(), supported() & ffi::FLAG_JIT != 0);
    check(&mut compiled, KEYS[0], "Vm::light with JIT");
}

#[test]
fn threads_share_one_cache() {
    let cache = Arc::new(Cache::new(KEYS[0].as_bytes()).unwrap());
    std::thread::scope(|scope| {
        for jit in [false, true, false, true] {
            let cache = cache.clone();
            scope.spawn(move || {
                let mut vm = Vm::light(cache, jit).unwrap();
                for _ in 0..3 {
                    check(&mut vm, KEYS[0], "a thread");
                }
            });
        }
    });
}

/// `vendor/` is RandomX at tag v2.0.1, file for file. The same value comes from
/// `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256`, run in
/// `vendor/` or in the release's source.
#[test]
fn the_vendored_tree_is_unchanged() {
    fn walk(dir: &Path, relative: &str, files: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = format!("{relative}/{}", entry.file_name().to_str().unwrap());
            if entry.file_type().unwrap().is_dir() {
                walk(&entry.path(), &path, files);
            } else {
                files.push(path);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor");
    let mut files = Vec::new();
    walk(&root, ".", &mut files);
    files.sort();
    let listing: String = (files.iter())
        .map(|path| {
            let digest = Sha256::digest(std::fs::read(root.join(&path[2..])).unwrap());
            format!("{}  {path}\n", hex(&digest))
        })
        .collect();
    assert_eq!(
        hex(&Sha256::digest(listing)),
        "c1e66fb2a030454c97df05753a6df9c62dbbd21ed31111041d006fdcecc87f1b"
    );
}
