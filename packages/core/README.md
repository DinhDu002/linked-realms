# @linked-realms/core

The WebAssembly build of `crates/core`: ML-DSA-44 keys, signatures and addresses (`docs/protocols/identity.md`, ADR 0009). The Shell, `hub-api`, the relay and the reference Map server all use it, so there is one implementation (P9).

- `pnpm --filter @linked-realms/core build` runs `cargo build --features wasm --target wasm32-unknown-unknown --profile wasm`, then `wasm-bindgen --target web` into `pkg/` (not committed). Turbo runs it before any `typecheck` or `test` that needs it. It needs the Rust toolchain from `rust-toolchain.toml` and `wasm-bindgen-cli` 0.2.129 (`cargo install wasm-bindgen-cli --version 0.2.129 --locked`).
- In Node, importing the package loads the module synchronously. In browsers, await `ready` first.
- `sign` takes `rnd`, 32 fresh random bytes from the caller (`crypto.getRandomValues`), because `wasm32-unknown-unknown` has no random source. Call `free()` on a `Key` when done, or declare it with `using`, so its private key is wiped.
- Size on 2026-10-29: `linked_realms_core_bg.wasm` is 190 KB, 68 KB with gzip and 55 KB with Brotli.
