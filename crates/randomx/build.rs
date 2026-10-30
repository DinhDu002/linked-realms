//! Builds the vendored RandomX (`vendor/`) as a static library with CMake: only the `randomx`
//! target, in Release, with the portable `ARCH=default` and never `native`, so a binary runs on
//! any CPU of its architecture.

fn main() {
    let out = cmake::Config::new("vendor")
        .define("ARCH", "default")
        .profile("Release")
        .build_target("randomx")
        .build();
    println!("cargo:rerun-if-changed=vendor");
    println!(
        "cargo:rustc-link-search=native={}",
        out.join("build").display()
    );
    println!("cargo:rustc-link-lib=static=randomx");
    // RandomX is C++: link its runtime too.
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let runtime = if os == "macos" { "c++" } else { "stdc++" };
    println!("cargo:rustc-link-lib={runtime}");
    // On musl Rust links no libgcc, which has the `__clear_cache` GCC calls for the ARM JIT.
    if std::env::var("CARGO_CFG_TARGET_ENV").unwrap() == "musl" {
        println!("cargo:rustc-link-lib=gcc");
    }
}
