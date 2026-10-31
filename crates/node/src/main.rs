//! `lr-node`: an LR Node, with its P2P and its public RPC (docs/protocols/node-p2p.md,
//! docs/protocols/node-rpc.md), checking Proof of Work with RandomX v2. Its Mine and the control
//! listener that starts it come with step 2C item 17.

use std::error::Error;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use linked_realms_core::params::{ChainParams, DEV, TESTNET};
use linked_realms_node::p2p::{Node, Tcp};
use linked_realms_node::pow::{Keys, verifier};
use linked_realms_node::rpc::{self, Rpc};
use linked_realms_node::run::Running;
use linked_realms_node::{Chain, KEEP_BELOW_CHECKPOINT, Mempool, Policy};
use tokio::runtime::Runtime;
use tokio::signal::unix::{Signal, SignalKind, signal};

const USAGE: &str = "\
usage: lr-node [options]
  --network test|dev   the network (default: test)
  --data DIR           where the chain is kept (default: lr-data)
  --listen ADDR        take P2P connections on ADDR (default: dial out only)
  --seed ADDR          a Node to dial first; repeatable
  --rpc ADDR|off       the public RPC (default: 127.0.0.1:9445)
  --archive            keep every Block (default: prune those far below the Checkpoint)";

struct Settings {
    params: ChainParams,
    data: PathBuf,
    listen: Option<SocketAddr>,
    seeds: Vec<SocketAddr>,
    rpc: Option<SocketAddr>,
    archive: bool,
}

impl Settings {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Settings, String> {
        let mut settings = Settings {
            params: TESTNET,
            data: PathBuf::from("lr-data"),
            listen: None,
            seeds: Vec::new(),
            rpc: Some(rpc::Config::default().listen),
            archive: false,
        };
        while let Some(arg) = args.next() {
            let mut value = || args.next().ok_or(format!("{arg} needs a value"));
            let address =
                |text: String| text.parse().map_err(|_| format!("not an address: {text}"));
            match arg.as_str() {
                "--network" => {
                    settings.params = match value()?.as_str() {
                        "test" => TESTNET,
                        "dev" => DEV,
                        other => return Err(format!("no network {other}")),
                    }
                }
                "--data" => settings.data = value()?.into(),
                "--listen" => settings.listen = Some(address(value()?)?),
                "--seed" => settings.seeds.push(address(value()?)?),
                "--rpc" => {
                    settings.rpc = match value()?.as_str() {
                        "off" => None,
                        text => Some(address(text.into())?),
                    }
                }
                "--archive" => settings.archive = true,
                other => return Err(format!("unknown option {other}")),
            }
        }
        Ok(settings)
    }
}

fn main() -> ExitCode {
    let settings = match Settings::parse(std::env::args().skip(1)) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("lr-node: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(settings) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lr-node: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(settings: Settings) -> Result<(), Box<dyn Error>> {
    // Taken first, so a signal sent once the lines below are printed is never missed.
    let signals = Signals::new()?;
    let params = settings.params;
    std::fs::create_dir_all(&settings.data)?;
    let keys = Arc::new(Keys::default());
    let mut chain = Chain::open(
        settings.data.join("chain.redb"),
        params.clone(),
        verifier(keys),
    )?;
    if !settings.archive {
        chain = chain.pruning(KEEP_BELOW_CHECKPOINT);
    }
    let tcp = Tcp::new(settings.listen)?;
    let listen = tcp.local_addr();
    let pool = Mempool::new(params.clone(), Policy::default());
    let port = listen.map_or(0, |address| address.port());
    let node = Node::new(chain, pool, &params, port, &settings.seeds);
    let running = Arc::new(Running::start(node, tcp));
    let rpc = match settings.rpc {
        Some(address) => {
            let config = rpc::Config {
                listen: address,
                ..rpc::Config::default()
            };
            Some(Rpc::start(running.clone(), params.clone(), &config)?)
        }
        None => None,
    };
    // What a supervisor reads to find the Node: one line each, then nothing on stdout.
    println!("network {}", params.network_id);
    if let Some(address) = listen {
        println!("p2p {address}");
    }
    if let Some(rpc) = &rpc {
        println!("rpc {}", rpc.local_addr());
    }
    signals.wait(&running)?;
    drop(rpc);
    running.stop()?;
    Ok(())
}

/// SIGINT and SIGTERM, held from when they are taken until `wait` reads them.
struct Signals {
    runtime: Runtime,
    interrupt: Signal,
    terminate: Signal,
}

impl Signals {
    fn new() -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let (interrupt, terminate) = {
            let _context = runtime.enter();
            (
                signal(SignalKind::interrupt())?,
                signal(SignalKind::terminate())?,
            )
        };
        Ok(Signals {
            runtime,
            interrupt,
            terminate,
        })
    }

    /// Waits for SIGINT or SIGTERM, or for the Node to stop by itself.
    fn wait<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static>(
        mut self,
        running: &Running<H>,
    ) -> io::Result<()> {
        self.runtime.block_on(async {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = self.interrupt.recv() => return Ok(()),
                    _ = self.terminate.recv() => return Ok(()),
                    _ = tick.tick() => if running.stopped() {
                        return Ok(());
                    },
                }
            }
        })
    }
}
