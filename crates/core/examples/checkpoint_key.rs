//! Makes a Checkpoint signer's key, which the project owner holds (ADR 0015, ADR 0012):
//!
//! `cargo run -q -p linked-realms-core --example checkpoint_key -- <words file> <key file>`
//!
//! The key's 24 words go to `<words file>`, readable by its owner only and never overwritten; only
//! the public key, in hex, goes to `<key file>`. The key is ML-DSA-44 from the seed `xi` that is
//! the 32 bytes behind the words, so the words alone restore it. The key file is written here, not
//! through a shell redirect: `crates/core` reads the files in `keys/` when compiling, and a
//! redirect would empty one before this example is built.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;

use linked_realms_core::{ENTROPY_LEN, SigningKey, words_from_entropy};
use zeroize::Zeroizing;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, words_path, key_path] = &args[..] else {
        panic!("usage: checkpoint_key <words file> <key file>");
    };
    let mut entropy = Zeroizing::new([0; ENTROPY_LEN]);
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut *entropy))
        .expect("reading /dev/urandom");
    let words = Zeroizing::new(words_from_entropy(&entropy));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(words_path)
        .expect("creating the words file (it must not exist yet)");
    writeln!(file, "{}", *words)
        .and_then(|()| file.sync_all())
        .expect("writing the words file");
    let key = SigningKey::from_seed(&entropy);
    std::fs::write(key_path, format!("{}\n", hex::encode(key.public_key())))
        .expect("writing the key file");
    println!(
        "Words written to {words_path}, public key to {key_path}. Address of the key: {}",
        key.address()
    );
}
