//! The control listener of a Node (docs/plans/phase-2c-the-chain.md, "The Mine"): `node_info`
//! and the `mine_` methods, which only the Node's owner may call (P5). It listens on a Unix
//! socket only its user can open, or on TCP with a shared secret checked on every request, and
//! never on the public RPC's listener.

use std::fs::{self, Permissions};
use std::io;
use std::net::SocketAddr;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use http::header::AUTHORIZATION;
use http::{HeaderValue, StatusCode};
use jsonrpsee::server::{
    BatchRequestConfig, HttpBody, HttpResponse, Methods, PingConfig, RpcModule, Server,
    ServerConfig, ServerHandle, SubscriptionMessage, serve_with_graceful_shutdown, stop_channel,
};
use jsonrpsee::types::{ErrorObject, ErrorObjectOwned};
use linked_realms_core::Address;
use linked_realms_core::issuance::reward;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::runtime::Runtime;
use tower::Service;

use crate::mine::{self, Memory, Mine, Mode, Refused, State, Status};
use crate::run::Running;

/// The id of a Node's one Mine (one per Land in Linked Realms).
pub const MINE_ID: &str = "land";
/// A shared secret's bytes, at least.
pub const MIN_SECRET: usize = 32;
/// A subscriber hears of a change of the Mine's status at most this often.
const STATUS_EVERY: Duration = Duration::from_secs(2);
/// How often a subscription looks for a change, and so for a Block won.
const LOOK_EVERY: Duration = Duration::from_millis(250);

pub enum Listen {
    /// A Unix socket at this path, which only this user may open.
    Unix(PathBuf),
    /// TCP, each request carrying the secret.
    Tcp(SocketAddr, Vec<u8>),
}

/// The control listener at work; it stops when dropped.
pub struct Control {
    socket: Option<PathBuf>,
    address: Option<SocketAddr>,
    stop: ServerHandle,
    // Dropped last: the tasks that serve the control listener run on it.
    _runtime: Runtime,
}

impl Control {
    /// Serves the control methods of the Node `running` and its Mine `mine` on `listen`.
    pub fn start<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static>(
        running: Arc<Running<H>>,
        mine: Arc<Mine<H>>,
        listen: Listen,
    ) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("lr-control")
            .enable_all()
            .build()?;
        let methods: Methods = methods(Context { running, mine })
            .expect("method names are unique")
            .into();
        let builder = Server::builder()
            .set_config(
                ServerConfig::builder()
                    .max_connections(16)
                    .set_batch_request_config(BatchRequestConfig::Disabled)
                    .enable_ws_ping(PingConfig::new())
                    .build(),
            )
            .to_service_builder();
        let (listener, socket, address, secret) = {
            let _context = runtime.enter();
            match listen {
                Listen::Unix(path) => {
                    let listener = bind_unix(&path)?;
                    let listener = Listener::Unix(listener, fs::metadata(&path)?.uid());
                    (listener, Some(path), None, None)
                }
                Listen::Tcp(address, secret) => {
                    if secret.len() < MIN_SECRET {
                        return Err(io::Error::other(format!(
                            "a control secret has at least {MIN_SECRET} bytes"
                        )));
                    }
                    let listener = std::net::TcpListener::bind(address)?;
                    listener.set_nonblocking(true)?;
                    let address = listener.local_addr()?;
                    let listener = Listener::Tcp(tokio::net::TcpListener::from_std(listener)?);
                    let secret = format!("Bearer {}", hex::encode(&secret)).into_bytes();
                    (listener, None, Some(address), Some(Arc::new(secret)))
                }
            }
        };
        let (stopped, stop) = stop_channel();
        runtime.spawn(async move {
            loop {
                let (builder, methods, stopped2) =
                    (builder.clone(), methods.clone(), stopped.clone());
                let secret = secret.clone();
                let service = tower::service_fn(move |request: http::Request<_>| {
                    let mut service = builder.clone().build(methods.clone(), stopped2.clone());
                    let allowed = secret.as_ref().is_none_or(|secret| {
                        let sent = request.headers().get(AUTHORIZATION);
                        sent.is_some_and(|sent| same(sent.as_bytes(), secret))
                    });
                    async move {
                        if !allowed {
                            return Ok(unauthorized());
                        }
                        let response: HttpResponse = service.call(request).await?;
                        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(response)
                    }
                });
                let shutdown = stopped.clone().shutdown();
                let accepted = tokio::select! {
                    accepted = listener.accept(service, shutdown) => accepted,
                    _ = stopped.clone().shutdown() => return,
                };
                if let Err(error) = accepted {
                    eprintln!("lr-node control: accepting a connection failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        });
        Ok(Control {
            socket,
            address,
            stop,
            _runtime: runtime,
        })
    }

    /// The TCP address it listens on, if it does.
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.address
    }
}

impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.stop.stop();
        if let Some(path) = &self.socket {
            let _ = fs::remove_file(path);
        }
    }
}

enum Listener {
    /// With the user its socket file belongs to: this process's.
    Unix(tokio::net::UnixListener, u32),
    Tcp(tokio::net::TcpListener),
}

impl Listener {
    /// Takes the next connection and serves it with `service` until `shutdown`.
    async fn accept<S, B>(
        &self,
        service: S,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> io::Result<()>
    where
        S: tower::Service<
                http::Request<hyper::body::Incoming>,
                Response = http::Response<B>,
                Error = Box<dyn std::error::Error + Send + Sync>,
            > + Clone
            + Send
            + 'static,
        S::Future: Send,
        B: hyper::body::Body<Data = hyper::body::Bytes> + Send + 'static,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        match self {
            Listener::Unix(listener, owner) => {
                let (socket, _) = listener.accept().await?;
                // Another user can only have connected before `bind_unix` set the mode, if the
                // umask let them.
                let user = socket.peer_cred()?.uid();
                if user != *owner {
                    eprintln!("lr-node control: refused a connection from user {user}");
                    return Ok(());
                }
                tokio::spawn(serve_with_graceful_shutdown(socket, service, shutdown));
            }
            Listener::Tcp(listener) => {
                let (socket, _) = listener.accept().await?;
                tokio::spawn(serve_with_graceful_shutdown(socket, service, shutdown));
            }
        }
        Ok(())
    }
}

/// Binds a Unix socket at `path` that only this user may open. Refused in a directory others
/// may write to, where they could put their own socket in its place; a socket left by a Node
/// that stopped is replaced, and a live one or any other file is left alone.
fn bind_unix(path: &Path) -> io::Result<tokio::net::UnixListener> {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let mode = fs::metadata(directory)?.permissions().mode();
    if mode & 0o022 != 0 && mode & 0o1000 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("others may write to {}", directory.display()),
        ));
    }
    if let Ok(file) = fs::symlink_metadata(path) {
        if !file.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} is not a socket", path.display()),
            ));
        }
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("a Node listens on {} already", path.display()),
            ));
        }
        fs::remove_file(path)?;
    }
    let listener = std::os::unix::net::UnixListener::bind(path)?;
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    tokio::net::UnixListener::from_std(listener)
}

/// Whether `a` and `b` are the same bytes, in a time that does not depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |differ, (x, y)| differ | (x ^ y)) == 0
}

fn unauthorized() -> HttpResponse {
    let mut response = HttpResponse::new(HttpBody::from("unauthorized"));
    *response.status_mut() = StatusCode::UNAUTHORIZED;
    let headers = response.headers_mut();
    headers.insert("www-authenticate", HeaderValue::from_static("Bearer"));
    response
}

struct Context<H> {
    running: Arc<Running<H>>,
    mine: Arc<Mine<H>>,
}

/// The error codes of the control methods: the reason is the message.
fn error(code: i32, reason: &str) -> ErrorObjectOwned {
    ErrorObject::owned(code, reason, None::<()>)
}

fn node_unavailable() -> ErrorObjectOwned {
    error(-32002, "node-unavailable")
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    id: String,
    reward_address: String,
    threads: usize,
    mode: ModeIn,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ModeIn {
    Auto,
    Fast,
    Light,
}

fn mine_id(id: &str) -> Result<(), ErrorObjectOwned> {
    match id == MINE_ID {
        true => Ok(()),
        false => Err(error(-32602, "unknown-mine")),
    }
}

fn status_json(status: &Status) -> Value {
    json!({
        "id": MINE_ID,
        "state": match status.state {
            State::Off => "off",
            State::Starting => "starting",
            State::On => "on",
        },
        "threads": status.threads,
        "mode": status.memory.map(|memory| match memory {
            Memory::Fast => "fast",
            Memory::Light => "light",
        }),
        "hashRate": status.hash_rate,
        "blocksWon": status.blocks_won,
        "rewardAddress": status.reward_address.map(|address| address.to_string()),
    })
}

fn notification(
    method: &str,
    sink: &jsonrpsee::SubscriptionSink,
    value: &Value,
) -> Result<SubscriptionMessage, serde_json::Error> {
    SubscriptionMessage::new(method, sink.subscription_id(), value)
}

fn methods<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static>(
    context: Context<H>,
) -> Result<RpcModule<Context<H>>, jsonrpsee::core::RegisterMethodError> {
    let mut module = RpcModule::new(context);
    module.register_async_method("node_info", |_, ctx, _| async move {
        let max_threads = ctx.mine.max_threads();
        let seen = ctx.running.call(|node, _| {
            let tip = node.chain.tip()?;
            Ok::<_, crate::Error>((tip, node.connections(), node.synced()))
        });
        let Some(Ok((tip, connections, synced))) = seen.await else {
            return Err(node_unavailable());
        };
        Ok::<_, ErrorObjectOwned>(json!({
            "height": tip.height,
            "tip": hex::encode(tip.id()),
            "connections": connections,
            "synced": synced,
            "maxThreads": max_threads,
            "memoryAvailableMiB": mine::available_memory().map(|bytes| bytes / (1024 * 1024)),
        }))
    })?;
    module.register_method("mine_status", |params, ctx, _| {
        mine_id(&params.parse::<Id>()?.id)?;
        Ok::<_, ErrorObjectOwned>(status_json(&ctx.mine.status()))
    })?;
    module.register_async_method("mine_start", |params, ctx, _| async move {
        let start: Start = params.parse()?;
        mine_id(&start.id)?;
        let reward_address =
            Address::from_str(&start.reward_address).map_err(|_| error(-32602, "bad-address"))?;
        if !(ctx.running.call(|node, _| node.synced()).await).unwrap_or(false) {
            return Err(node_unavailable());
        }
        let mode = match start.mode {
            ModeIn::Auto => Mode::Auto,
            ModeIn::Fast => Mode::Fast,
            ModeIn::Light => Mode::Light,
        };
        // Starting stops the Mine first, which waits for its threads.
        let mine = ctx.mine.clone();
        let started =
            tokio::task::spawn_blocking(move || mine.start(reward_address, start.threads, mode));
        match started.await.expect("the Mine's start") {
            Ok(status) => Ok(status_json(&status)),
            Err(Refused::BadThreads) => Err(error(-32602, "bad-threads")),
        }
    })?;
    module.register_async_method("mine_stop", |params, ctx, _| async move {
        mine_id(&params.parse::<Id>()?.id)?;
        let mine = ctx.mine.clone();
        let stopped = tokio::task::spawn_blocking(move || mine.stop());
        Ok::<_, ErrorObjectOwned>(status_json(&stopped.await.expect("the Mine's stop")))
    })?;
    module.register_subscription(
        "mine_subscribe",
        "mine_status",
        "mine_unsubscribe",
        |params, pending, ctx, _| async move {
            if let Err(error) = params.parse::<Id>().and_then(|id| mine_id(&id.id)) {
                pending.reject(error).await;
                return Ok(());
            }
            let sink = pending.accept().await?;
            let mut status = ctx.mine.status();
            sink.send(notification("mine_status", &sink, &status_json(&status))?)
                .await?;
            let (mut told, mut won) = (Instant::now(), ctx.mine.won_from(0).len());
            let mut look = tokio::time::interval(LOOK_EVERY);
            loop {
                tokio::select! {
                    _ = look.tick() => {}
                    _ = sink.closed() => return Ok(()),
                }
                for id in ctx.mine.won_from(won) {
                    won += 1;
                    let found = ctx.running.call(move |node, _| {
                        let header = node.chain.header(&id)?.expect("a Block won is stored");
                        let fees: u64 = (node.chain.block(&id)?)
                            .map_or(0, |block| block.txs.iter().map(|tx| tx.fee).sum());
                        Ok::<_, crate::Error>(json!({
                            "id": MINE_ID,
                            "height": header.height,
                            "hash": hex::encode(id),
                            "reward": (reward(header.height) + fees).to_string(),
                            "rewardAddress": header.reward_address.to_string(),
                            "time": header.timestamp,
                        }))
                    });
                    let Some(Ok(found)) = found.await else {
                        continue;
                    };
                    sink.send(notification("mine_blockFound", &sink, &found)?)
                        .await?;
                }
                let now = ctx.mine.status();
                if now != status && told.elapsed() >= STATUS_EVERY {
                    sink.send(notification("mine_status", &sink, &status_json(&now))?)
                        .await?;
                    (status, told) = (now, Instant::now());
                }
            }
        },
    )?;
    Ok(module)
}

#[cfg(test)]
mod tests;
