//! The public JSON-RPC of a Node (docs/protocols/node-rpc.md): HTTP and WebSocket on one
//! listener, with the `lr_` methods only. Browsers call it, so it answers any origin and limits
//! the calls of each client. Admin and Mine methods are never served here: they belong to the
//! control listener (docs/plans/phase-2c-the-chain.md, "The Mine").

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE,
};
use http::{HeaderValue, Method, StatusCode};
use jsonrpsee::server::middleware::rpc::{
    Batch, Notification, Request, RpcServiceBuilder, RpcServiceT,
};
use jsonrpsee::server::{
    BatchRequestConfig, HttpBody, HttpResponse, MethodResponse, Methods, PingConfig, RpcModule,
    Server, ServerConfig, ServerHandle, SubscriptionMessage, serve_with_graceful_shutdown,
    stop_channel,
};
use jsonrpsee::types::{ErrorObject, ErrorObjectOwned, Id};
use linked_realms_core::Address;
use linked_realms_core::block::{Block, Header};
use linked_realms_core::checkpoint::Checkpoint;
use linked_realms_core::params::ChainParams;
use linked_realms_core::state::Account;
use linked_realms_core::tx::{Kind, Tx};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::runtime::Runtime;
use tokio::sync::Semaphore;
use tokio::sync::broadcast::error::RecvError;
use tower::Service;

use crate::p2p::{MAX_HEADERS, Node, Tcp};
use crate::run::Running;
use crate::{Error, Placed, Refused};

/// Error codes past JSON-RPC's own, from EIP-1474 so clients of other chains read them.
pub const INVALID_INPUT: i32 = -32000;
pub const RESOURCE_UNAVAILABLE: i32 = -32002;
pub const TRANSACTION_REJECTED: i32 = -32003;
pub const LIMIT_EXCEEDED: i32 = -32005;
/// Transactions `lr_getAddressTxs` gives at once, at most.
pub const ADDRESS_TXS: usize = 20;
/// Bytes a request may have: a transaction or a Checkpoint in hex fits many times.
const MAX_REQUEST: u32 = 64 * 1024;
const SUBSCRIPTIONS_PER_CONNECTION: u32 = 16;
/// Clients whose calls are counted, at most; past it a new client is refused until one goes
/// idle.
const MAX_CLIENTS: usize = 10_000;

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// Calls a client may make each second, and at once after a quiet while.
    pub per_second: u32,
    pub burst: u32,
    /// HTTP requests and WebSocket connections served at once.
    pub max_connections: u32,
    /// The proxies in front of it, if any: a request from one counts for the client its
    /// `X-Forwarded-For` names, as hub-api counts its clients.
    pub proxies: Vec<IpAddr>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            listen: SocketAddr::from(([127, 0, 0, 1], 9445)),
            per_second: 10,
            burst: 50,
            max_connections: 128,
            proxies: Vec::new(),
        }
    }
}

/// The RPC listener at work; it stops when dropped.
pub struct Rpc {
    address: SocketAddr,
    stop: ServerHandle,
    // Dropped last: the tasks that serve the RPC run on it.
    _runtime: Runtime,
}

impl Rpc {
    /// Serves the RPC of the Node `running`, of the network `params`.
    pub fn start<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static>(
        running: Arc<Running<H>>,
        params: ChainParams,
        config: &Config,
    ) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("lr-rpc")
            .enable_all()
            .build()?;
        let methods: Methods = methods(Context { running, params })
            .expect("method names are unique")
            .into();
        let clients = Arc::new(Clients {
            per_second: config.per_second,
            burst: config.burst,
            left: Mutex::new(HashMap::new()),
        });
        let builder = Server::builder()
            .set_config(
                ServerConfig::builder()
                    .max_connections(config.max_connections)
                    .max_request_body_size(MAX_REQUEST)
                    .max_subscriptions_per_connection(SUBSCRIPTIONS_PER_CONNECTION)
                    .set_batch_request_config(BatchRequestConfig::Disabled)
                    // A WebSocket whose client is gone frees its place.
                    .enable_ws_ping(PingConfig::new())
                    .build(),
            )
            .set_rpc_middleware(RpcServiceBuilder::new().layer_fn(move |service| Limit {
                service,
                clients: clients.clone(),
            }))
            .to_service_builder();
        let listener = runtime.block_on(tokio::net::TcpListener::bind(config.listen))?;
        let address = listener.local_addr()?;
        let (stopped, stop) = stop_channel();
        // Open sockets, idle ones included, so clients cannot spend the file descriptors the
        // Node's other Nodes and its database need; past it, connections wait to be accepted.
        let sockets = Arc::new(Semaphore::new(2 * config.max_connections as usize));
        let proxies = Arc::new(config.proxies.clone());
        runtime.spawn(async move {
            loop {
                let permit = tokio::select! {
                    permit = sockets.clone().acquire_owned() => permit.expect("never closed"),
                    _ = stopped.clone().shutdown() => return,
                };
                let (socket, remote) = tokio::select! {
                    accepted = listener.accept() => match accepted {
                        Ok(accepted) => accepted,
                        // Out of file descriptors, say: told, and slowed so it does not spin.
                        Err(error) => {
                            eprintln!("lr-node rpc: accepting a connection failed: {error}");
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            continue;
                        }
                    },
                    _ = stopped.clone().shutdown() => return,
                };
                let (builder, methods, stopped2) =
                    (builder.clone(), methods.clone(), stopped.clone());
                let proxies = proxies.clone();
                // Held by the connection's service, so it goes when the connection does.
                let permit = Arc::new(permit);
                let service = tower::service_fn(move |mut request: http::Request<_>| {
                    let _ = &permit;
                    let mut service = builder.clone().build(methods.clone(), stopped2.clone());
                    let forwarded = request.headers().get_all("x-forwarded-for");
                    let forwarded: Vec<_> =
                        forwarded.iter().filter_map(|v| v.to_str().ok()).collect();
                    let client = client_of(remote.ip(), &forwarded.join(","), &proxies);
                    async move {
                        if request.method() == Method::OPTIONS {
                            return Ok(preflight());
                        }
                        request.extensions_mut().insert(Client(client));
                        let mut response: HttpResponse = service.call(request).await?;
                        let any = HeaderValue::from_static("*");
                        response
                            .headers_mut()
                            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, any);
                        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(response)
                    }
                });
                tokio::spawn(serve_with_graceful_shutdown(
                    socket,
                    service,
                    stopped.clone().shutdown(),
                ));
            }
        });
        Ok(Rpc {
            address,
            stop,
            _runtime: runtime,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.stop.stop();
    }
}

/// The answer to a browser's preflight: any origin may call, with a JSON body.
fn preflight() -> HttpResponse {
    let mut response = HttpResponse::new(HttpBody::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST, OPTIONS"),
    );
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    headers.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    response
}

/// The IP address a request came from.
#[derive(Debug, Clone, Copy)]
struct Client(IpAddr);

/// The client of a request from `peer`: `peer`, unless it is one of the `proxies`; then the
/// rightmost entry of `forwarded_for` that is not one, since only the entries a trusted proxy
/// wrote can be trusted and anything to their left is what the client sent. An entry that is not
/// an address leaves the proxy before it as the client.
// ponytail: proxies by address, not by network; take CIDRs if a proxy's address ever varies.
fn client_of(peer: IpAddr, forwarded_for: &str, proxies: &[IpAddr]) -> IpAddr {
    let mut client = peer;
    for entry in forwarded_for.rsplit(',').map(str::trim) {
        if !proxies.contains(&client.to_canonical()) {
            break;
        }
        match entry.parse::<IpAddr>() {
            Ok(ip) => client = ip,
            Err(_) => break,
        }
    }
    client
}

/// The calls each client has left: a bucket that fills by `per_second` up to `burst`. A client
/// is an IPv4 address, or an IPv6 /64, which one host often holds whole.
struct Clients {
    per_second: u32,
    burst: u32,
    left: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

impl Clients {
    /// Takes `calls` from `ip`'s bucket, if it holds them.
    fn take(&self, ip: IpAddr, calls: usize, now: Instant) -> bool {
        let ip = match ip.to_canonical() {
            IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & !(u128::MAX >> 64)).into()),
            v4 => v4,
        };
        let (rate, burst) = (f64::from(self.per_second), f64::from(self.burst));
        let fill = |(left, at): (f64, Instant)| (left + (now - at).as_secs_f64() * rate).min(burst);
        let mut clients = self.left.lock().expect("not poisoned");
        if !clients.contains_key(&ip) && clients.len() >= MAX_CLIENTS {
            // Those whose bucket filled again are as good as new.
            clients.retain(|_, bucket| fill(*bucket) < burst);
            if clients.len() >= MAX_CLIENTS {
                return false;
            }
        }
        let bucket = clients.entry(ip).or_insert((burst, now));
        let left = fill(*bucket);
        let allowed = left >= calls as f64;
        *bucket = (if allowed { left - calls as f64 } else { left }, now);
        allowed
    }
}

/// Refuses a call when its client has no calls left.
#[derive(Clone)]
struct Limit<S> {
    service: S,
    clients: Arc<Clients>,
}

impl<S> Limit<S> {
    fn allows(&self, extensions: &http::Extensions, calls: usize) -> bool {
        let Client(ip) = *extensions.get::<Client>().expect("set on each request");
        self.clients.take(ip, calls, Instant::now())
    }
}

fn too_many() -> ErrorObjectOwned {
    ErrorObject::owned(
        LIMIT_EXCEEDED,
        "too many calls: try again later",
        None::<()>,
    )
}

impl<S> RpcServiceT for Limit<S>
where
    S: RpcServiceT<
            MethodResponse = MethodResponse,
            BatchResponse = MethodResponse,
            NotificationResponse = MethodResponse,
        > + Send
        + Sync
        + Clone
        + 'static,
{
    type MethodResponse = MethodResponse;
    type BatchResponse = MethodResponse;
    type NotificationResponse = MethodResponse;

    fn call<'a>(&self, request: Request<'a>) -> impl Future<Output = MethodResponse> + Send + 'a {
        let allowed = self.allows(request.extensions(), 1);
        let service = self.service.clone();
        async move {
            match allowed {
                true => service.call(request).await,
                false => MethodResponse::error(request.id, too_many()),
            }
        }
    }

    // Batches are turned off (`BatchRequestConfig::Disabled`); one would count every call.
    fn batch<'a>(&self, mut batch: Batch<'a>) -> impl Future<Output = MethodResponse> + Send + 'a {
        let calls = batch.len();
        let allowed = self.allows(batch.extensions(), calls);
        let service = self.service.clone();
        async move {
            match allowed {
                true => service.batch(batch).await,
                false => MethodResponse::error(Id::Null, too_many()),
            }
        }
    }

    fn notification<'a>(
        &self,
        notification: Notification<'a>,
    ) -> impl Future<Output = MethodResponse> + Send + 'a {
        let allowed = self.allows(notification.extensions(), 1);
        let service = self.service.clone();
        async move {
            match allowed {
                true => service.notification(notification).await,
                false => MethodResponse::notification(),
            }
        }
    }
}

struct Context<H> {
    running: Arc<Running<H>>,
    params: ChainParams,
}

impl<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static> Context<H> {
    /// Runs `look` on the Node's thread.
    async fn ask<T: Send + 'static>(
        &self,
        look: impl FnOnce(&mut Node<H>, &mut Tcp) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, ErrorObjectOwned> {
        match self.running.call(look).await {
            Some(Ok(seen)) => Ok(seen),
            Some(Err(error)) => Err(internal(error)),
            None => Err(internal(STOPPED)),
        }
    }
}

const STOPPED: &str = "the Node stopped";

fn internal(error: impl ToString) -> ErrorObjectOwned {
    ErrorObject::owned(-32603, error.to_string(), None::<()>)
}

fn invalid(what: &str) -> ErrorObjectOwned {
    ErrorObject::owned(-32602, format!("invalid {what}"), None::<()>)
}

fn address(text: &str) -> Result<Address, ErrorObjectOwned> {
    Address::from_str(text).map_err(|_| invalid("address"))
}

fn bytes32(text: &str) -> Result<[u8; 32], ErrorObjectOwned> {
    let mut bytes = [0; 32];
    hex::decode_to_slice(text, &mut bytes).map_err(|_| invalid("id"))?;
    Ok(bytes)
}

/// A Block of the best chain by its height, or any stored Block by its id.
#[derive(Deserialize)]
#[serde(untagged)]
enum BlockRef {
    Height(u64),
    Id(String),
}

/// Where a transaction is in the best chain; the one before which `lr_getAddressTxs` starts.
#[derive(Deserialize)]
struct Place {
    height: u64,
    place: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointIn {
    height: u64,
    block_id: String,
    signature: String,
}

fn methods<H: Fn(&[u8], &[u8; 32]) -> [u8; 32] + Send + 'static>(
    context: Context<H>,
) -> Result<RpcModule<Context<H>>, jsonrpsee::core::RegisterMethodError> {
    let mut module = RpcModule::new(context);
    module.register_async_method("lr_getInfo", |_, ctx, _| async move {
        let params = ctx.params.clone();
        ctx.ask(move |node, _| {
            let tip = node.chain.tip()?;
            let checkpoint = node.chain.latest_checkpoint()?;
            Ok(json!({
                "networkId": params.network_id,
                "genesis": hex::encode(params.genesis().id()),
                "height": tip.height,
                "tip": hex::encode(tip.id()),
                "time": tip.timestamp,
                "latestCheckpoint": checkpoint.map(|c| json!({
                    "height": c.height,
                    "blockId": hex::encode(c.block_id),
                })),
                "pruned": node.chain.pruned()?,
                "archive": node.chain.keep().is_none(),
                "connections": node.connections(),
            }))
        })
        .await
    })?;
    module.register_async_method("lr_getHeader", |params, ctx, _| async move {
        let block: BlockRef = params.one()?;
        let id = match &block {
            BlockRef::Id(id) => Some(bytes32(id)?),
            BlockRef::Height(_) => None,
        };
        ctx.ask(move |node, _| {
            let header = match (block, id) {
                (BlockRef::Height(height), _) => node.chain.headers_from(height, 1)?.pop(),
                (_, Some(id)) => node.chain.header(&id)?,
                _ => None,
            };
            Ok(header.as_ref().map(header_json))
        })
        .await
    })?;
    module.register_async_method("lr_getHeaders", |params, ctx, _| async move {
        let (from, count): (u64, u64) = params.parse()?;
        let count = count.min(MAX_HEADERS as u64);
        ctx.ask(move |node, _| {
            let headers = node.chain.headers_from(from, count)?;
            Ok(headers.iter().map(header_json).collect::<Vec<_>>())
        })
        .await
    })?;
    module.register_async_method("lr_getBlock", |params, ctx, _| async move {
        let block: BlockRef = params.one()?;
        let id = match &block {
            BlockRef::Id(id) => Some(bytes32(id)?),
            BlockRef::Height(_) => None,
        };
        let chain_params = ctx.params.clone();
        let found = ctx
            .ask(move |node, _| {
                let header = match (block, id) {
                    (BlockRef::Height(height), _) => node.chain.headers_from(height, 1)?.pop(),
                    (_, Some(id)) => node.chain.header(&id)?,
                    _ => None,
                };
                match header {
                    Some(header) => Ok(Some(node.chain.block(&header.id())?.ok_or(header))),
                    None => Ok(None),
                }
            })
            .await?;
        match found {
            None => Ok(Value::Null),
            Some(Ok(block)) => Ok(block_json(&chain_params, &block)),
            Some(Err(_)) => Err(ErrorObject::owned(
                RESOURCE_UNAVAILABLE,
                "the Block's body is not held here: pruned, or not taken yet",
                None::<()>,
            )),
        }
    })?;
    module.register_async_method("lr_getAccount", |params, ctx, _| async move {
        let mut seq = params.sequence();
        let text: String = seq.next()?;
        let with_mempool: Option<bool> = seq.optional_next()?;
        let address = address(&text)?;
        ctx.ask(move |node, _| {
            let mut account = None;
            if with_mempool == Some(true) {
                node.pool.follow(&node.chain)?;
                account = node.pool.pending(&address).cloned();
            }
            if account.is_none() {
                account = node.chain.account(&address)?;
            }
            Ok(account.as_ref().map(account_json))
        })
        .await
    })?;
    module.register_async_method("lr_getTransaction", |params, ctx, _| async move {
        let id = bytes32(&params.one::<String>()?)?;
        let chain_params = ctx.params.clone();
        ctx.ask(move |node, _| {
            node.pool.follow(&node.chain)?;
            if let Some(tx) = node.pool.get(&id) {
                return Ok(json!({ "tx": tx_json(&chain_params, tx), "block": null }));
            }
            Ok(match node.chain.transaction(&id)? {
                Some(placed) => placed_json(&chain_params, &placed),
                None => Value::Null,
            })
        })
        .await
    })?;
    module.register_async_method("lr_getAddressTxs", |params, ctx, _| async move {
        let mut seq = params.sequence();
        let text: String = seq.next()?;
        let before: Option<Place> = seq.optional_next()?;
        let address = address(&text)?;
        let before = before.map(|place| (place.height, place.place));
        let chain_params = ctx.params.clone();
        ctx.ask(move |node, _| {
            let txs = node.chain.address_txs(&address, before, ADDRESS_TXS)?;
            Ok(txs
                .iter()
                .map(|placed| placed_json(&chain_params, placed))
                .collect::<Vec<_>>())
        })
        .await
    })?;
    module.register_async_method("lr_getMempoolInfo", |_, ctx, _| async move {
        ctx.ask(|node, _| {
            let (count, bytes) = node.pool.held();
            let policy = node.pool.policy();
            Ok(json!({
                "count": count,
                "bytes": bytes,
                "maxBytes": policy.max_bytes,
                "minFeeRate": policy.min_fee_rate.to_string(),
                "dust": policy.dust.to_string(),
            }))
        })
        .await
    })?;
    module.register_async_method("lr_estimateFee", |_, ctx, _| async move {
        ctx.ask(|node, _| {
            node.pool.follow(&node.chain)?;
            Ok(node.pool.fee_rate().to_string())
        })
        .await
    })?;
    module.register_async_method("lr_getCheckpoint", |_, ctx, _| async move {
        ctx.ask(|node, _| {
            Ok(node.chain.latest_checkpoint()?.map(|c| {
                json!({
                    "height": c.height,
                    "blockId": hex::encode(c.block_id),
                    "signature": hex::encode(c.signature),
                })
            }))
        })
        .await
    })?;
    module.register_async_method("lr_sendTransaction", |params, ctx, _| async move {
        let bytes = hex::decode(params.one::<String>()?).map_err(|_| invalid("hex"))?;
        let tx = Tx::from_bytes(&bytes).map_err(|_| invalid("transaction"))?;
        let id = hex::encode(tx.id(&ctx.params));
        match ctx.ask(move |node, tcp| node.send_tx(tcp, tx)).await? {
            Ok(()) | Err(Refused::Known) => Ok(id),
            Err(refused) => Err(rejected(refused)),
        }
    })?;
    module.register_async_method("lr_submitCheckpoint", |params, ctx, _| async move {
        let given: CheckpointIn = params.one()?;
        let block_id = bytes32(&given.block_id)?;
        let signature = hex::decode(&given.signature)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| invalid("signature"))?;
        let checkpoint = Checkpoint {
            height: given.height,
            block_id,
            signature,
        };
        match ctx
            .ask(move |node, tcp| node.submit_checkpoint(tcp, checkpoint))
            .await?
        {
            Ok(()) => Ok(true),
            Err(rule) => Err(ErrorObject::owned(
                INVALID_INPUT,
                rule.to_string(),
                None::<()>,
            )),
        }
    })?;
    module.register_subscription(
        "lr_subscribeBlocks",
        "lr_block",
        "lr_unsubscribeBlocks",
        |_, pending, ctx, _| async move {
            let Some(mut joined) = ctx.running.joined() else {
                pending.reject(internal(STOPPED)).await;
                return Ok(());
            };
            let sink = pending.accept().await?;
            loop {
                let joined = tokio::select! {
                    joined = joined.recv() => joined.map_err(fell_behind)?,
                    _ = sink.closed() => return Ok(()),
                };
                sink.send(message(&header_json(&joined.header))?).await?;
            }
        },
    )?;
    module.register_subscription(
        "lr_subscribeAddress",
        "lr_addressTx",
        "lr_unsubscribeAddress",
        |params, pending, ctx, _| async move {
            let watched = match params.one::<String>().map(|text| address(&text)) {
                Ok(Ok(watched)) => watched,
                Ok(Err(error)) | Err(error) => {
                    pending.reject(error).await;
                    return Ok(());
                }
            };
            let Some(mut joined) = ctx.running.joined() else {
                pending.reject(internal(STOPPED)).await;
                return Ok(());
            };
            let sink = pending.accept().await?;
            let chain_params = ctx.params.clone();
            loop {
                let joined = tokio::select! {
                    joined = joined.recv() => joined.map_err(fell_behind)?,
                    _ = sink.closed() => return Ok(()),
                };
                // Without its body (a state snapshot's Blocks) there is nothing to tell.
                let Some(block) = &joined.block else {
                    continue;
                };
                let (id, height) = (joined.header.id(), joined.header.height);
                for (place, tx) in (0..).zip(&block.txs) {
                    let to = match &tx.kind {
                        Kind::Transfer { to, .. } => Some(*to),
                        Kind::Rotation { .. } => None,
                    };
                    if tx.sender == watched || to == Some(watched) {
                        let placed = Placed {
                            tx: tx.clone(),
                            block: id,
                            height,
                            place,
                        };
                        sink.send(message(&placed_json(&chain_params, &placed))?)
                            .await?;
                    }
                }
            }
        },
    )?;
    Ok(module)
}

fn message(value: &Value) -> Result<SubscriptionMessage, serde_json::Error> {
    Ok(serde_json::value::to_raw_value(value)?.into())
}

fn fell_behind(error: RecvError) -> String {
    match error {
        RecvError::Lagged(_) => "fell behind: read what was missed, then subscribe again".into(),
        RecvError::Closed => STOPPED.into(),
    }
}

fn rejected(refused: Refused) -> ErrorObjectOwned {
    let (reason, message) = match refused {
        Refused::Rule(rule) => ("rule", rule.to_string()),
        Refused::Known => ("known", "already held".into()),
        Refused::FeeTooLow => ("fee-too-low", "the fee is below the minimum rate".into()),
        Refused::Dust => (
            "dust",
            "it creates an Account with less than the dust amount".into(),
        ),
        Refused::NonceGap => ("nonce-gap", "an earlier nonce is missing".into()),
        Refused::TooMany => ("too-many", "the sender has as many held as allowed".into()),
        Refused::ReplacementTooCheap => (
            "replacement-too-cheap",
            "a replacement must pay a fee rate higher by the margin".into(),
        ),
        Refused::Full => (
            "mempool-full",
            "the mempool is full at this fee rate".into(),
        ),
    };
    ErrorObject::owned(
        TRANSACTION_REJECTED,
        message,
        Some(json!({ "reason": reason })),
    )
}

fn header_json(header: &Header) -> Value {
    json!({
        "id": hex::encode(header.id()),
        "height": header.height,
        "prevId": hex::encode(header.prev_id),
        "timestamp": header.timestamp,
        "target": hex::encode(header.target.to_be_bytes()),
        "txRoot": hex::encode(header.tx_root),
        "stateRoot": hex::encode(header.state_root),
        "rewardAddress": header.reward_address.to_string(),
        "nonce": header.nonce.to_string(),
    })
}

fn block_json(params: &ChainParams, block: &Block) -> Value {
    json!({
        "header": header_json(&block.header),
        "txs": block.txs.iter().map(|tx| tx_json(params, tx)).collect::<Vec<_>>(),
    })
}

fn tx_json(params: &ChainParams, tx: &Tx) -> Value {
    let mut json = json!({
        "id": hex::encode(tx.id(params)),
        "sender": tx.sender.to_string(),
        "nonce": tx.nonce,
        "fee": tx.fee.to_string(),
        "size": tx.to_bytes().len(),
    });
    match &tx.kind {
        Kind::Transfer { to, amount, memo } => {
            json["kind"] = "transfer".into();
            json["to"] = to.to_string().into();
            json["amount"] = amount.to_string().into();
            json["memo"] = hex::encode(memo).into();
        }
        Kind::Rotation { new_key } => {
            json["kind"] = "rotation".into();
            json["newKeyScheme"] = new_key.scheme.into();
            json["newKey"] = hex::encode(&new_key.bytes).into();
        }
    }
    json
}

fn placed_json(params: &ChainParams, placed: &Placed) -> Value {
    json!({
        "tx": tx_json(params, &placed.tx),
        "block": { "id": hex::encode(placed.block), "height": placed.height, "place": placed.place },
    })
}

fn account_json(account: &Account) -> Value {
    json!({
        "balance": account.balance.to_string(),
        "nonce": account.nonce,
        "hasKey": account.key.is_some(),
    })
}

#[cfg(test)]
mod tests;
