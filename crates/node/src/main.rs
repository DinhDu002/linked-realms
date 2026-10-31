//! `lr-node`: an LR Node, with its P2P and its public RPC (docs/protocols/node-p2p.md,
//! docs/protocols/node-rpc.md), checking Proof of Work with RandomX v2, and its Mine, which only
//! its owner starts: over the control listener, or with `lr-node mine` (ADR 0015). With
//! `lr-node sign` it is the Checkpoint signer (ADR 0012).

use std::error::Error;
use std::io;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use linked_realms_core::params::{ChainParams, DEV, TESTNET};
use linked_realms_core::{Address, SigningKey, entropy_from_words};
use linked_realms_node::control::{Control, Listen};
use linked_realms_node::mine::{self, Mine, Mode};
use linked_realms_node::p2p::{Node, Tcp};
use linked_realms_node::pow::{Keys, verifier};
use linked_realms_node::rpc::{self, Rpc};
use linked_realms_node::run::Running;
use linked_realms_node::signer;
use linked_realms_node::{Chain, KEEP_BELOW_CHECKPOINT, Mempool, Policy};
use tokio::runtime::Runtime;
use tokio::signal::unix::{Signal, SignalKind, signal};
use zeroize::Zeroizing;

const USAGE: &str = "\
usage: lr-node [mine --reward-address ADDR [--threads N] [--mode auto|fast|light]] [options]
       lr-node sign --checkpoint-words FILE [options]
  --network test|dev     the network (default: test)
  --data DIR             where the chain is kept (default: lr-data)
  --listen ADDR          take P2P connections on ADDR (default: dial out only)
  --seed HOST:PORT       a Node to dial first, at each address its name has at start;
                         repeatable
  --rpc ADDR|off         the public RPC (default: 127.0.0.1:9445)
  --rpc-proxy IP         a proxy in front of the RPC, whose X-Forwarded-For names its
                         clients; repeatable
  --archive              keep every Block (default: prune those far below the Checkpoint)
  --control unix:PATH    the control listener, on a Unix socket only this user may open
  --control ADDR         the control listener on TCP, which needs --control-secret
  --control-secret FILE  the secret, at least 32 bytes, each control request must carry
  mine                   mine for --reward-address from the start, on --threads threads
                         (default 1) in --mode (default auto)
  sign                   sign Checkpoints on this Node's best chain with the key behind the
                         24 words in --checkpoint-words, which must be the network's
MINE_MAX_THREADS, if set, lowers the most threads the Mine may run.";

struct Settings {
    params: ChainParams,
    data: PathBuf,
    listen: Option<SocketAddr>,
    seeds: Vec<SocketAddr>,
    rpc: Option<SocketAddr>,
    rpc_proxies: Vec<IpAddr>,
    archive: bool,
    control: Option<ControlAt>,
    mine: Option<(Address, usize, Mode)>,
    /// The Checkpoint signer's words file.
    sign: Option<PathBuf>,
}

enum ControlAt {
    Unix(PathBuf),
    Tcp(SocketAddr, PathBuf),
}

impl Settings {
    fn parse(args: impl Iterator<Item = String>) -> Result<Settings, String> {
        let mut args = args.peekable();
        let command = args.next_if(|arg| arg == "mine" || arg == "sign");
        let (mine, sign) = (
            command.as_deref() == Some("mine"),
            command.as_deref() == Some("sign"),
        );
        let mut settings = Settings {
            params: TESTNET,
            data: PathBuf::from("lr-data"),
            listen: None,
            seeds: Vec::new(),
            rpc: Some(rpc::Config::default().listen),
            rpc_proxies: Vec::new(),
            archive: false,
            control: None,
            mine: None,
            sign: None,
        };
        let (mut control, mut secret) = (None, None);
        let (mut reward_address, mut threads, mut mode) = (None, 1, Mode::Auto);
        let mut words = None;
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
                "--seed" => {
                    // ponytail: looked up once, at start; a seed whose address changes is found
                    // again on a restart.
                    let text = value()?;
                    let found: Vec<_> = text.to_socket_addrs().into_iter().flatten().collect();
                    if found.is_empty() {
                        return Err(format!("not a Node address: {text}"));
                    }
                    settings.seeds.extend(found);
                }
                "--rpc" => {
                    settings.rpc = match value()?.as_str() {
                        "off" => None,
                        text => Some(address(text.into())?),
                    }
                }
                "--rpc-proxy" => {
                    let text = value()?;
                    let ip: IpAddr = text
                        .parse()
                        .map_err(|_| format!("not an IP address: {text}"))?;
                    // As the RPC compares them: an IPv4-mapped address is the IPv4 one.
                    settings.rpc_proxies.push(ip.to_canonical());
                }
                "--archive" => settings.archive = true,
                "--checkpoint-words" if sign => words = Some(PathBuf::from(value()?)),
                "--control" => control = Some(value()?),
                "--control-secret" => secret = Some(PathBuf::from(value()?)),
                "--reward-address" if mine => {
                    let text = value()?;
                    let parsed = Address::from_str(&text);
                    reward_address =
                        Some(parsed.map_err(|_| format!("not an LR address: {text}"))?);
                }
                "--threads" if mine => {
                    let text = value()?;
                    threads = text
                        .parse()
                        .map_err(|_| format!("not a thread count: {text}"))?;
                }
                "--mode" if mine => {
                    mode = match value()?.as_str() {
                        "auto" => Mode::Auto,
                        "fast" => Mode::Fast,
                        "light" => Mode::Light,
                        other => return Err(format!("no mode {other}")),
                    }
                }
                other => return Err(format!("unknown option {other}")),
            }
        }
        settings.control = match (control, secret) {
            (None, None) => None,
            (None, Some(_)) => return Err("--control-secret is for a TCP --control".into()),
            (Some(at), secret) => match (at.strip_prefix("unix:"), secret) {
                (Some(path), None) => Some(ControlAt::Unix(path.into())),
                (Some(_), Some(_)) => {
                    return Err("a Unix socket needs no --control-secret".into());
                }
                (None, Some(secret)) => {
                    let at = at.parse().map_err(|_| format!("not an address: {at}"))?;
                    Some(ControlAt::Tcp(at, secret))
                }
                (None, None) => return Err("a TCP --control needs --control-secret".into()),
            },
        };
        if mine {
            let reward_address = reward_address.ok_or("mine needs --reward-address")?;
            settings.mine = Some((reward_address, threads, mode));
        }
        if sign {
            settings.sign = Some(words.ok_or("sign needs --checkpoint-words")?);
        }
        Ok(settings)
    }
}

/// The most threads the Mine may run here, lowered by `MINE_MAX_THREADS`.
fn thread_cap() -> Result<usize, String> {
    match std::env::var("MINE_MAX_THREADS") {
        Err(_) => Ok(mine::max_threads(None)),
        Ok(text) => match text.parse() {
            Ok(limit) if limit > 0 => Ok(mine::max_threads(Some(limit))),
            _ => Err(format!("MINE_MAX_THREADS is not a thread count: {text}")),
        },
    }
}

fn main() -> ExitCode {
    let settings = Settings::parse(std::env::args().skip(1)).and_then(|settings| {
        let cap = thread_cap()?;
        match settings.mine {
            Some((_, threads, _)) if threads == 0 || threads > cap => {
                Err(format!("--threads is 1 to {cap} here"))
            }
            _ => Ok((settings, cap)),
        }
    });
    let (settings, cap) = match settings {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("lr-node: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(settings, cap) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lr-node: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(settings: Settings, cap: usize) -> Result<(), Box<dyn Error>> {
    // Taken first, so a signal sent once the lines below are printed is never missed.
    let signals = Signals::new()?;
    let params = settings.params;
    let signer = match &settings.sign {
        Some(words) => Some(Arc::new(checkpoint_signer(words, &params)?)),
        None => None,
    };
    std::fs::create_dir_all(&settings.data)?;
    let keys = Arc::new(Keys::default());
    let mut chain = Chain::open(
        settings.data.join("chain.redb"),
        params.clone(),
        verifier(keys.clone()),
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
                proxies: settings.rpc_proxies,
                ..rpc::Config::default()
            };
            Some(Rpc::start(running.clone(), params.clone(), &config)?)
        }
        None => None,
    };
    let mine = Arc::new(Mine::new(running.clone(), keys, cap));
    let control = match settings.control {
        None => None,
        Some(ControlAt::Unix(path)) => {
            let listen = Listen::Unix(path.clone());
            Some((
                Control::start(running.clone(), mine.clone(), listen)?,
                path.display().to_string(),
            ))
        }
        Some(ControlAt::Tcp(address, secret)) => {
            let listen = Listen::Tcp(address, std::fs::read(secret)?);
            let control = Control::start(running.clone(), mine.clone(), listen)?;
            let address = control.local_addr().expect("a TCP listener").to_string();
            Some((control, address))
        }
    };
    // What a supervisor reads to find the Node: one line each; then only a line for each Block
    // its Mine wins.
    println!("network {}", params.network_id);
    if let Some(address) = listen {
        println!("p2p {address}");
    }
    if let Some(rpc) = &rpc {
        println!("rpc {}", rpc.local_addr());
    }
    if let Some((_, at)) = &control {
        println!("control {at}");
    }
    if let Some((reward_address, threads, mode)) = settings.mine {
        mine.start(reward_address, threads, mode)
            .expect("threads checked");
        println!("mine {reward_address} threads {threads}");
    }
    let mut told = 0;
    signals.wait(&running, async || {
        for id in mine.won_from(told) {
            told += 1;
            println!("won {}", hex::encode(id));
        }
        if let Some(key) = &signer {
            let (key, params) = (key.clone(), params.clone());
            let signed = running
                .call(move |node, net| signer::sign_due(node, net, &params, &key))
                .await;
            match signed {
                Some(Ok(Some(checkpoint))) => {
                    let id = hex::encode(checkpoint.block_id);
                    println!("checkpoint {} {id}", checkpoint.height);
                }
                Some(Err(error)) => eprintln!("lr-node sign: {error}"),
                Some(Ok(None)) | None => {}
            }
        }
    })?;
    drop(control);
    mine.stop();
    drop(rpc);
    running.stop()?;
    Ok(())
}

/// The Checkpoint signer's key, from the 24 words in the file at `words`: refused unless it is
/// the network's.
fn checkpoint_signer(words: &PathBuf, params: &ChainParams) -> Result<SigningKey, Box<dyn Error>> {
    let text = Zeroizing::new(std::fs::read_to_string(words)?);
    let entropy =
        entropy_from_words(text.trim()).map_err(|_| "the words file holds no 24 words")?;
    let key = SigningKey::from_seed(&entropy);
    if key.public_key() != &params.checkpoint_signer_key {
        return Err("these words are not the network's Checkpoint signer key".into());
    }
    Ok(key)
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

    /// Waits for SIGINT or SIGTERM, or for the Node to stop by itself, calling `each_second`
    /// meanwhile.
    fn wait<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static>(
        mut self,
        running: &Running<H>,
        mut each_second: impl AsyncFnMut(),
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
                each_second().await;
            }
        })
    }
}
