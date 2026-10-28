# Decision brief: relay and hub-api for linked-realms at scale

**Basis.** I used only claims with verdict "supported" or "partially", with the verifier corrections applied.
- `[id]` is a claim id. The Source index at the end gives the URL and a verbatim quote for each cited id. Prefixes are abbreviated: `n-` = nat-traversal, `w-` = ws-server-scale, `h-` = hub-api, `c-` = colyseus.
- "(inf)" marks a verifier-flagged inference or my own arithmetic.
- No traffic profile was supplied: tick rate, message size, players per Land and number of Lands are all unknown. Every sizing number below is arithmetic on stated assumptions, not a measurement.

**Summary**
- The load lands on the relay. The relay is also the only component whose connection count scales with players.
- Connection count alone is not the hard limit.
  - Node + uWebSockets.js held 1,018,366 idle connections at ~5.4 KB each, but vendor-run and idle only [w-14].
  - Go Centrifugo held 1M connections on 20 pods with ~500k msg/s delivered [w-8].
  - Message rate and egress bandwidth bind first.
- On Q5, options that move bytes off company infrastructure exist, but each has an unresolved blocker.
  - Cloudflare Tunnel: terms-of-service fit is unresolved [n-39][n-40] and it costs $4.50 per tunnel above 1,000 [n-34].
  - WebRTC direct with fallback: Colyseus has no WebRTC game transport [n-28][c-23], and no source gives the relayed share for home/CGNAT hosts [n-21].
- hub-api: TypeScript with viem is better supported by evidence. Symfony is viable only if the PHP crypto path is benchmarked first.

## 1. Where the connection load lands

**Map servers (player machines)**
- One Room lives in one process, and a single-process server needs no Redis [w-43][c-16].
- Colyseus FAQ baseline: 1 vCPU / 1 GB handles 1,000-2,000 concurrent connections for simple games, fewer for complex state. No hard per-room limit is stated, and default patchRate is 50 ms [c-17].
- Load on a map server is bounded by one Land's players.

**Relay (all browser connections plus every map server's outbound link)**
- Each join is an HTTP POST to /matchmake/..., then a WebSocket to a URL built from publicAddress or the client's endpoint host [c-4][c-5][c-7]. The relay must therefore carry both the HTTP matchmake and the WS upgrade to the same map-server port [c-6].
- On egress-billed hosts, every relayed byte is outgoing traffic (inf) [n-24]. Market anchor for relayed bytes: $0.05 per GB [n-23].
- Arithmetic (inf): 20 patches/s per client at the default patchRate [c-17] gives an upper bound of about 20k msg/s at 1k players, 200k at 10k and 2M at 100k.
- For comparison: ~100,000 msg/s for Node 18 + ws vs ~700,000 for a uWS-based runtime (16-client chatroom, vendor, old) [w-12], and ~500k msg/s on 20 pods in Centrifugo [w-8]. These are different workloads, so use them for order of magnitude only.
- Per-player kbps is unknown, so no bandwidth cost model is possible.

**hub-api**
- The paths are SIWE login, registration (delegation verify plus on-chain read), ticket signing and reports. These are per-user paths (inf).
- CPU: noble-curves verify is 1,352 ops/s at 739 µs on one Apple M4, and no recover figure is published [h-18]. That is about 0.74 core-seconds per 1,000 verifies/s (inf). In Node, crypto blocks the event loop [h-11].
- A vendor with an interest in a competing extension claims ~100-135 ms per verify in pure PHP. It gives no methodology, so treat it as LOW confidence and re-measure [h-30].
- HTTP heartbeats from map servers would cost N_servers / interval requests per second. Example (hypothetical): 100,000 servers at 30 s is about 3,333 req/s. This can be avoided by deriving presence from the relay link with Redis TTL keys [h-33][h-35][h-36].
- Directory reads can be absorbed by a shared cache [h-38].

**Indexer.** It is not on the connection path. Ponder is a TypeScript framework on Postgres [h-39].

## 2. Relay options

| Option | Company carries game traffic? | Documented scale numbers | Fit with Colyseus 0.18 | Main risk |
|---|---|---|---|---|
| A. Node + `ws`, forward-all | Yes (project design) | ~100,000 msg/s, Node 18 + ws, 16-client chatroom, vendor, old [w-12]. No per-connection figure found. | WS is Colyseus's default transport [n-25]. Relay must carry matchmake HTTP and WS [c-4][c-6]. | No documented 10k+/100k+ figure. permessage-deflate can fragment memory [w-13]. |
| B. Node + uWebSockets.js | Yes | 1,018,366 idle connections, ~5.4 KB each, 32 vCPU, 200 conn/s ramp, competitor-published [w-14]. Author claims 100k very active TLS 1.3 sockets on a Raspberry Pi 4, no details [w-16]. | Colyseus recommends uWS for production [c-11]. Its transport pins uWS v20.52.0, and Node 26 support arrived in v20.67.0, so an override is likely (inf) [c-12][w-17]. | Idle-only numbers. Binaries track Node majors [w-17]. Benchmark with a non-JS client [w-19]. |
| C. Go (coder/websocket, gorilla, gobwas) | Yes | Centrifugo: 1M connections, 20 pods, ~30 KB/conn, ~500k msg/s, p99 200 ms, Redis pub/sub, 2020, self-published [w-8]. gobwas epoll demo ~20 GB to ~600 MB per 1M, hardware unspecified [w-6]. | Protocol-level, no Colyseus coupling. Same HTTP+WS routing rule [c-4][c-6]. | Second language. Memory depends on library: naive goroutine design is ~20 KB/conn [w-6]. |
| D. Elixir/Phoenix | Yes | ~2M idle sockets on one 128 GB / 40-core box, 2015 [w-1]. 2,277,845 TCP on one server, 2012 [w-2]. Discord: 500,000 sessions per VM [w-3]. | Built-in cluster pub/sub [w-5]. | Third runtime. Mostly old, idle-only numbers. |
| E. Rust | Yes | No documented evidence at 10k+. Only 10-500-connection chart benchmarks [w-21] and single-connection throughput [w-22]. | Protocol-level. | Unproven by sources. |
| F. frp / rathole (self-hosted tunnel) | Yes [n-42] | rathole: loopback, CPU-bound benchmark only [n-44]. frp: none. | Stock WS passes through generic tunnels (vendor blog) [c-24]. | frp: shared token, per-user isolation not documented [n-43]. rathole: one port per service, hot-reloaded config, API WIP [n-45]. |
| G. Cloudflare Tunnel per Land | No, traffic flows via Cloudflare [n-32] | 1,000 tunnels per account [n-33]. $4.50 per additional tunnel per month, inactive tunnels count [n-34]. At 10,000 tunnels: $40,500 per month (inf, list price). | WebSockets supported on all plans [n-36]. Stock Colyseus (inf), generic tunnel pattern [c-24]. | Terms unresolved: Zero Trust no-resale [n-39], "VPN or similar proxy" clause [n-40]. Idle timeout value not stated [n-36]. |
| H. WebRTC direct, TURN/WS fallback | Only the fallback share | Generic WebRTC only: up to 17.7% of sessions via TURN (2017, secondhand) [n-18]. 22% of failed calls (not overall) [n-19]. Tailscale author's non-measured estimate: direct path over 90% of the time (UDP/WireGuard) [n-20]. coturn "thousands simultaneous calls per CPU" (vendor) [n-22]. | Poor. Colyseus WebRTC plugin is signaling-only [n-28][c-23]. Custom Transport is possible but undocumented [n-29][c-14]. | CGNAT/hard NAT breaks traversal [n-21]. TURN carries all traffic for that connection [n-16] and is bandwidth-heavy [n-17]. node-datachannel lists no Node 26 [n-31]. |
| I. libp2p circuit relay v2 + DCUtR | Only if limits are removed | Relay defaults: 2 min, 128 KiB, 16 circuits [n-3][n-4][n-5]. DCUtR 70%±7.1% on IPFS peers, conditional on earlier stages [n-7][n-8]. | Browsers cannot be dialed [n-9]. No libp2p transport in Colyseus [n-25]. | Limited by design [n-1]. Removing limits makes it option A (inf) [n-2]. |
| J. Cloudflare Durable Object per Land | No | Max 32,768 WS per DO [w-23]. Soft limit 1,000 req/s per object [w-24]. Incoming WS billed 20:1, outgoing free [w-27]. | Custom relay code, no Colyseus docs. | Unconfirmed whether each WS message counts toward 1,000 rps [w-24]. Many small messages can overwhelm one DO [w-26]. Objects with scheduled callbacks don't hibernate [w-29]. |
| K. Managed gateways (AWS API GW, Azure Web PubSub, Ably) | No | AWS: 500 new conn/s, $1.00 per M messages [w-31][w-32]. Azure: 1,000 connections per unit [w-34]. Ably: 50 msg/s per channel and per connection [w-35]. | Poor: broker/message-API models, not a byte pipe (inf). | Per-message pricing and caps against game tick rates. |

Colyseus WebTransport (h3-transport) is experimental [n-27][c-13]. It does not solve home-NAT hosts (inf) [n-14].

**Multi-node routing (works with any engine above)**
- **Pattern A, hash by Land id at the load balancer.**
  - Caddy `lb_policy query/header` [w-38].
  - nginx `hash ... consistent` [w-40].
  - Envoy ring hash remaps 1/N of keys [w-41].
  - Reloads close WebSockets unless `stream_close_delay` is set [w-39].
  - Caddy falls back to random if the key is missing [w-38].
- **Pattern B, directory assigns the relay node.**
  - Precedent: DERP home-relay selection [w-44] and Colyseus seat reservation followed by a direct dial to the owning process [w-43][c-7].
  - Avoid broadcasting to all nodes [w-46].

## 3. hub-api options

| Dimension | TypeScript (Fastify/Hono + viem) | Symfony, PHP 8.5, FrankenPHP/RoadRunner |
|---|---|---|
| SIWE / wallet verify | `verifySiweMessage` [h-12]. `verifyMessage` handles smart accounts (ERC-1271/6492/8010) [h-13]. EIP-4361 says ERC-1271 SHOULD be used for contract accounts [h-19]. | zbkm/siwe v0.5.0, 845 installs, README documents signature verify only [h-21]. No ERC-1271 path found among the packages researched (inf). |
| Ticket sign/verify (EIP-712) | `signTypedData` [h-15]. Node map servers verify EOA-signed tickets offline with the util [h-14]. Interop across languages if types match [h-20]. | Hashing-only sleepfinance/eip712 (544 installs), pulls Laravel components [h-27]. |
| Chain reads | `readContract` with ABI-inferred types [h-16]. | web3.php 0.3.2 (2024-01-28), 158 open issues, installs from dev-master [h-25]. |
| secp256k1 | Pure-JS noble, no native addon [h-17]. 1,352 verify/s, 739 µs on Apple M4 [h-18]. | elliptic-php last release 2024-01-09, about 33 months old [h-22]. keccak last release Dec 2020 [h-24]. libsecp256k1 binding last release 2019, php ^7.0 [h-29]. ~100 ms per verify claim is LOW confidence [h-30]. |
| HTTP overhead | Fastify 91,539 req/s hello-world, hardware and Node version unstated [h-1]. Not hub-api throughput. | Worker mode boots the app once [h-2]. Symfony Runtime reuses one kernel and needs state-reset discipline [h-3]. Single blog, LOW confidence: ping FPM ~2,100 vs FrankenPHP ~8,500 vs RoadRunner ~9,200 req/s, no gain on CPU-bound work [h-6]. PHP 8.5 binaries exist [h-8]. No same-hardware comparison with Node. |
| CPU-bound work | Blocks the event loop, so use a worker pool or more instances [h-11]. | Not covered by sources beyond [h-6]. |
| Lifecycle | No claim on Fastify/Hono/viem under Node 26: no documented evidence. | 8.1 needs PHP >= 8.4 and ends Jan 2027. 7.4 LTS needs PHP >= 8.2 with security fixes to Nov 2029 [h-9]. |
| Stack fit | Same language as Ponder, relay and map servers [h-39]. | Second runtime. |
| Scaling | Stateless, share-nothing [h-10]. | Same [h-10]. |

**Hybrid (Symfony for CRUD, small TypeScript crypto service).** This is reasoning from [h-12]-[h-18] only. No source evidences its cost/benefit against going all-TypeScript.

**Language-independent hub-api offloads**
- Redis TTL presence written by the relay and deleted on close [h-33].
- Do not use keyspace "expired" events as the trigger [h-34].
- A silent death is detected only after about one heartbeat interval [h-35].
- Redis benchmarked at over 60,000 connections still sustaining 50,000 q/s. The same page notes that 30,000 connections halve throughput compared with 100 connections [h-36].
- Directory reads served via `s-maxage` + `stale-while-revalidate` [h-38].

## 4. Recommendation per tier

Per-player rates are hypothetical (see section 1).

### Tier <= 1k concurrent players
- **Relay:** one Node 26 process, Land-keyed, forward-all, plain WebSocket, compression off.
  - Evidence: ~20k msg/s upper bound (inf) against ~100,000 msg/s for ws [w-12] (different workload), with a Colyseus FAQ baseline for scale [c-17]. Deflate is off [w-13].
  - The only documented ws figure at this tier is the chatroom number, so confirm with a load test. No documented evidence exists for ws at 10k+ [w-12].
- **Path:** forward-all only, with no hole punching, because CGNAT and hard NAT are where traversal fails [n-21].
- **Map servers:** keep the default ws transport [c-9][c-17]. No documented evidence that uWS helps a per-Land Colyseus server: no Colyseus-specific benchmark [c-11].
- **hub-api:** TypeScript + viem [h-12][h-13][h-15][h-16][h-39].
  - Symfony only if a spike confirms PHP crypto speed and that no smart-wallet owners exist [h-19][h-21][h-30].
  - If PHP is chosen: 7.4 LTS [h-9] with FrankenPHP worker mode [h-2][h-3][h-8].
- **Cloudflare Tunnel:** do not use as the default before written terms confirmation [n-39][n-40]. It is free to 1,000 tunnels [n-33].

### Tier ~10k
- **Relay:** two or more nodes routed by Land id, using Pattern A [w-38][w-40][w-41] or Pattern B [w-43][w-44][c-7].
  - Engine: Node + uWS.js with a Node 26 build (v20.67.0 or later) [w-17], compression off [w-15], and backpressure checks [w-18].
  - Connection count is not the limit here: 1,018,366 idle connections documented [w-14]. The ~200k msg/s upper bound (inf) is split across nodes.
  - No documented evidence for Node under active 10k game traffic: load-test with a non-JS client [w-19]. Go [w-8] is the documented alternative.
- **Reconnects:** expect closed sockets on node changes [w-39], and set `allowReconnection` so Colyseus SDK reconnect can work [c-20].
- **Bandwidth offload:** decide only from measured relayed bytes. No documented evidence for the relayed share of this population: [n-18][n-19][n-20] are generic.
- **hub-api:** TypeScript, two or more stateless instances [h-10]. Run ecrecover on a worker pool or separate instances [h-11]. Use cached directory reads [h-38] and relay-derived presence [h-33][h-35].
- **Do not choose** Tunnel per Land: 9,000 extra tunnels at $4.50 is $40,500 per month (inf) [n-34].

### Tier ~100k+
- **Relay:** a sharded fleet with the same Land-keyed routing [w-38]-[w-46].
  - The engine is decided by load test on active traffic.
  - Documented 1M-class evidence:
    - Go, active pub/sub [w-8].
    - Elixir, idle plus Discord production claims [w-1][w-2][w-3].
    - Node + uWS.js, idle only [w-14].
    - Rust: no documented evidence.
  - Keep Node + uWS.js if the active-traffic test passes. Otherwise swap the engine to Go behind the same routing layer [w-8].
  - The ~2M msg/s upper bound (inf) is about 4x Centrifugo's delivered rate [w-8], a different workload.
- **Offload candidates:**
  - WebRTC direct with relay fallback, but only after measurement and a custom Colyseus Transport [n-28][n-29][c-14]. Home/CGNAT share unknown [n-21].
  - Managed gateways and Durable Objects: no documented evidence that they fit game-tick traffic. Caps and metering are in [w-24][w-32][w-35].
- **hub-api:** TypeScript stateless fleet, Redis TTL presence [h-33][h-36], CDN-cached directory [h-38].
  - Redis HA/clustering: no documented evidence.
  - Ticket signing per gate crossing: noble sign 4,217 ops/s on M4 [h-18].

### Phase 0/1 builds so the next tier needs no rewrite
1. Put the Land id in the path or query on both the map-server link and browser connections, so the hash or directory routing in section 2 can be added without protocol changes [w-38][w-40][w-41][w-43][w-44].
   - The WS side tolerates a path prefix, because the regex matches the last two segments [c-6].
   - The HTTP matchmake route is exactly `/matchmake/:method/:roomName`, so the relay must strip any prefix [c-6].
   - publicAddress may carry host plus path: Colyseus Cloud generates one [c-7].
2. The relay serves both the HTTP matchmake and the WS upgrade [c-4][c-6], and passes CORS headers through [c-21].
3. Hub-gated join: the map server verifies the travel ticket, reserves the seat, and the client calls `consumeSeatReservation` [c-8]. `beforeUpgrade` rejects ticketless or non-relay upgrades [c-15]. Tickets are verified offline [h-14][h-20].
4. Presence as `presence:<land>` TTL keys, refreshed on ping/pong and deleted on close, with no reliance on keyspace events [h-33][h-34][h-35].
5. Directory responses with `s-maxage` and `stale-while-revalidate` [h-38].
6. Per-session byte and message counters on the relay. Reason: no documented relayed-share figure for this population [n-18][n-19][n-20].
7. Compression off, and relay frame limit at least Colyseus's 4096-byte default `maxPayload` [c-10][w-13][w-15]. Bounded per-connection buffering for slow clients, using uWS backpressure when on uWS [w-18].
8. A load-test harness from day 1, with a non-JS client [w-19].
9. Node 26: `@colyseus/core` declares Node >= 22 [c-1]. uWS.js supports 26 from v20.67.0 [w-17].

## 5. Open questions for the owner

1. What does "large connection volume" mean in numbers? Needed: concurrent players per tier, players per Land, number of Lands, tick/patch rate and message size. All sizing above is arithmetic.
2. Egress budget: is relaying 100% of game traffic acceptable, and at what $ per GB? Only anchors exist [n-23][n-24].
3. Can a Land owner be a smart-contract wallet (Safe, ERC-4337)? If yes, ERC-1271/6492 verification is mandatory [h-19][h-13] and only viem documents it among the options researched.
4. How stale may online/offline status be (seconds or tens of seconds)? This sets heartbeat TTL, grace period and `s-maxage` [h-33][h-35][h-38].
5. Are you willing to depend on Cloudflare? If so, someone must get written terms confirmation [n-39][n-40] and confirm pricing [n-34].
6. Appetite for a second language (Go) at the 100k tier, or for investing in a custom WebRTC transport [n-29][n-31]?
7. Team weight of existing Symfony expertise versus one TypeScript stack. No source speaks to this.
8. Ticket format: EIP-712 (interop only documented in [h-20]) or a simpler signed token?
9. Approval for time-boxed spikes:
   - HTTP matchmake behind a path-prefix proxy, with publicAddress carrying a path.
   - Colyseus uWS transport override on Node 26.
   - Phaser 4 + `@colyseus/sdk` smoke test. The tutorial links Phaser 3 and no Phaser 4 statement exists [c-18].
   - Relay load test of ws vs uWS.js on Node 26.
   - PHP-vs-viem ecrecover benchmark.
   - Colyseus heartbeat (3000 ms × 2 retries [c-10]) against relay keepalive.
   - Presence ownership across multiple relay nodes.

## 6. Dropped claims

No claim had verdict "unsupported" or "unreachable". These sub-statements were excluded from partially-verified claims:
- n-8: "end-to-end rate is lower than 70%" is inference. I used only the "conditional on earlier stages" wording.
- n-12: the NAT/port-opening part is inference. I did not use WebRTC Direct for the NAT case.
- n-38: Cloudflare moved the restriction to a CDN-specific section rather than abolishing it. The "weakens the folklore" reading is interpretation. Not used.
- h-10: the load-balancer scaling sentence is not on the cited page. I used only "stateless and share-nothing".
- h-18: the audit-history lines are misleading for viem's pinned noble version. I used only the benchmark numbers.
- h-22: age is about 33 months, not 21.
- w-1: dropped "3 then 45+ Tsung machines" and the Phoenix/Cowboy versions.
- w-6: dropped "demo code not production-ready".
- w-14: the "RAM per idle connection" row is not verbatim. Figures come from the efficiency table and FAQ.
- w-19: dropped the "HTTP hello-world" characterization.
- c-7: publicAddress is documented as a multi-machine scaling hook. Relay use is inference.
- c-18: the Phaser version claim is wrong, because the tutorial links Phaser 3.
- c-22: dropped the blanket "no relay documented". The built-in RelayRoom is an app-level message relay, not a network relay.

## Source index

**nat-traversal**
- n-1, n-2: https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md. "provide switched connectivity with a limited duration and data cap" / "When omitted, it indicates that the relay does not apply any limits."
- n-3, n-4, n-5: https://raw.githubusercontent.com/libp2p/go-libp2p/master/p2p/protocol/circuitv2/relay/resources.go. "Duration: 2 * time.Minute," / "Data:     1 << 17, // 128K" / "MaxCircuits:     16,"
- n-7, n-8: https://arxiv.org/html/2510.27500v1. "We establish a contemporary baseline success rate of 70%±7.1% for the hole-punching stage." / "conditional on the success of these earlier stages, rather than the end-to-end success rate"
- n-9: https://github.com/libp2p/specs/blob/master/connections/hole-punching.md. "hosts running on browser platforms can not be directly dialed."
- n-14: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API. "transmitting data between client and server using HTTP/3 Transport"
- n-15: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel. "It's been available across browsers since January 2020."
- n-16: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols. "This obviously comes with some overhead so it is only used if there are no other alternatives."
- n-17: https://web.dev/articles/webrtc-infrastructure. "Unlike STUN servers, they inherently consume a lot of bandwidth."
- n-18: https://openvidu.io/blog/2026/06/09/turn-key-considerations/. "A small study by Philipp Hancke shows that up to 17.7% of sessions go through a TURN relay."
- n-19: https://www.nojitter.com/video-conferencing/know-where-to-turn-when-deploying-webrtc. "Of those failed calls, 22% required some form of media relay."
- n-20, n-21: https://tailscale.com/blog/how-nat-traversal-works. "I'd estimate you could get a direct connection over 90% of the time" / "It only takes one of them in the whole path to break our current traversal plans."
- n-22: https://github.com/coturn/coturn. "can handle thousands simultaneous calls per CPU (when TURN protocol is used)"
- n-23: https://developers.cloudflare.com/realtime/turn/. "Otherwise, it costs $0.05/real-time GB outbound from Cloudflare to the TURN client."
- n-24: https://docs.hetzner.com/cloud/billing/faq/. "We only bill for outgoing traffic. Incoming and internal traffic is free."
- n-25: https://docs.colyseus.io/server/transport. "WebSockets (Default)"
- n-27 (= c-13): https://docs.colyseus.io/server/transport/webtransport. "Experimental - This WebTransport implementation hasn't been battle tested."
- n-28 (= c-23): https://docs.colyseus.io/room/plugins/webrtc. "This plugin is signaling only: it handles the SDP/ICE exchange needed to establish WebRTC connections."
- n-29: https://github.com/colyseus/colyseus/blob/master/packages/core/src/Transport.ts. "public abstract listen(port?: number | string, hostname?: string, backlog?: number, listeningListener?: Function): this;"
- n-31: https://github.com/murat-dogan/node-datachannel. "WebRTC For Node.js and Electron (including WebSocket Client & Server). libdatachannel node bindings."
- n-32: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/. "initiates an outbound connection through your firewall from the origin to the Cloudflare global network"
- n-33: https://developers.cloudflare.com/cloudflare-one/account-limits/. "`cloudflared` tunnels per account | 1,000"
- n-34: https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/. "Tunnels for Platforms costs $4.50 per additional tunnel per month."
- n-36: https://developers.cloudflare.com/network/websockets/. "Cloudflare supports proxied WebSocket connections without additional configuration."
- n-39: https://www.cloudflare.com/service-specific-terms-zero-trust-services. "You shall not resell Cloudflare Zero Trust to any third parties"
- n-40: https://www.cloudflare.com/terms/. "use the Services to provide a virtual private network or other similar proxy services."
- n-42: https://github.com/fatedier/frp. "A frps server is still needed, as P2P here only refers to the actual data transmission."
- n-43: https://gofrp.org/en/docs/features/http-https/subdomain/. "You only need to resolve `*.{subdomainHost}` to the server where frps is located."
- n-44: https://github.com/rapiz1/rathole. "rathole has similar latency to frp, but can handle a more connections, provide larger bandwidth, with less memory usage."
- n-45: https://github.com/rapiz1/rathole/blob/main/README.md. "Services can be added or removed dynamically by hot-reloading the configuration file. HTTP API is WIP."

**ws-server-scale**
- w-1: https://phoenixframework.org/blog/the-road-to-2-million-websocket-connections. "2 million clients, limited by ulimit"
- w-2: https://blog.whatsapp.com/1-million-is-so-2011. "over 2 million tcp connections"
- w-3: https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users. "An Erlang VM responsible for sessions can have up to 500,000 live sessions on it."
- w-5: https://phoenix-pubsub.hexdocs.pm/Phoenix.PubSub.html. "uses Distributed Elixir, directly exchanging notifications between servers."
- w-6: https://speakerdeck.com/eranyanay/going-infinite-handling-1m-websockets-connections-in-go. "Each connection in the naive solution consumes ~20KB."
- w-8: https://centrifugal.dev/blog/2020/02/10/million-connections-with-centrifugo. "27 GB of RAM used mostly to handle 1 mln WebSocket connections, i.e. about 30kb RAM per connection"
- w-12: https://bun.sh/docs/api/websockets. "Bun can handle 7x more messages per second than Node.js"
- w-13, h-35: https://github.com/websockets/ws. "adds a significant overhead in terms of performance and memory consumption" / "the link between the server and the client can be interrupted in a way that keeps both the server and the client unaware"
- w-14: https://anycable.io/compare/nodejs-websocket. "1M-connection idle: uWS 1,018,366 / 5.45 GB" (FAQ; the verifier's wording of the page text)
- w-15, w-16: https://github.com/uNetworking/uWebSockets/blob/master/misc/READMORE.md. "an overhead of 4KB per WebSocket" / "a single Raspberry Pi 4 can serve more than 100k very active TLS 1.3 WebSockets, simultaneously"
- w-17 (= c-12): https://github.com/uNetworking/uWebSockets.js/releases. "This release removes Node.js 25 & Node.js 20 support and adds Node.js 26 support."
- w-18: https://unetworking.github.io/uWebSockets.js/generated/interfaces/WebSocket.html. "Returns 1 for success, 2 for dropped due to backpressure limit, and 0 for built up backpressure that will drain over time."
- w-19: https://github.com/uNetworking/uWebSockets/tree/master/benchmarks. "You can, absolutely not, benchmark uWS using a JavaScript client."
- w-21: https://github.com/Gelbpunkt/tokio-websockets/blob/main/benches/README.md. "In order to bottleneck faster, we're also using a single-threaded runtime."
- w-22: https://github.com/PrivateRookie/ws-tool. "uWebSocket | 100000000 | 10014 | 9986019.57"
- w-23: https://developers.cloudflare.com/durable-objects/api/state/. "The WebSocket Hibernation API permits a maximum of 32,768 WebSocket connections per Durable Object"
- w-24: https://developers.cloudflare.com/durable-objects/platform/limits/. "An individual Object has a soft limit of 1,000 requests per second."
- w-26, w-29: https://developers.cloudflare.com/durable-objects/best-practices/websockets/. "Sending many small messages can overwhelm a single Durable Object." / "Events such as alarms, incoming requests, and scheduled callbacks prevent hibernation."
- w-27: https://developers.cloudflare.com/durable-objects/platform/pricing/. "a 20:1 ratio is applied to incoming WebSocket messages"
- w-31: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html. "with the default quota of 500 new connections per second, if clients connect at the maximum rate over two hours, API Gateway can serve up to 3,600,000 concurrent connections."
- w-32: https://aws.amazon.com/api-gateway/pricing/. "Messages are metered in 32KB increments"
- w-34: https://learn.microsoft.com/en-us/azure/azure-web-pubsub/concept-performance. "is defined as the maximum achieved throughput when 99 percent of messages have latency that's less than 1 second"
- w-35: https://ably.com/docs/platform/pricing/limits. "Message publish rate per channel (per second) | 50 | 50 | 50 | 50"
- w-38, w-39: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy. "`query [key]` maps a request query to a sticky upstream, by hashing the query value." / "delays streaming requests such as WebSockets from being forcibly closed when the config is unloaded."
- w-40: https://nginx.org/en/docs/http/ngx_http_upstream_module.html. "The method ensures that only a few keys will be remapped to different servers when a server is added to or removed from the group."
- w-41: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers. "the addition or removal of one host from a set of N hosts will affect only 1/N requests"
- w-43: https://docs.colyseus.io/scalability. "Each Room belongs to a single Colyseus process."
- w-44: https://tailscale.com/kb/1232/derp-servers. "The coordination server then shares each client's selection with the other clients across the tailnet."
- w-46: https://centrifugal.dev/blog/2020/11/12/scaling-websocket. "The basic approach here is to publish messages to all server instances"

**hub-api**
- h-1: https://fastify.dev/benchmarks/. "| Fastify | 5.12.7 | 91,539 | 10.40 | 16.41 |"
- h-2: https://frankenphp.dev/docs/worker/. "Boot your application once and keep it in memory."
- h-3: https://symfony.com/doc/current/components/runtime.html. "By default, `FrankenPhpWorkerRunner` reuses the same kernel instance across every request handled by a worker process."
- h-6: https://dev.to/mattleads/benchmark-frankenphp-vs-roadrunner-in-symfony-8-2lgp. "| A: Ping | FrankenPHP (Worker) | ~8,500 | 4ms |"
- h-8: https://github.com/dunglas/frankenphp. "We provide FrankenPHP binaries for Linux, macOS (Apple Silicon) and Windows containing PHP 8.5."
- h-9: https://symfony.com/releases. "| 8.1 | Stable (maintained) | 8.4.0 | May 2026 | January 2027 |"
- h-10: https://12factor.net/processes. "Twelve-factor processes are stateless and share-nothing."
- h-11: https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop. "Remember, the Event Loop should orchestrate client requests, not fulfill them itself."
- h-12: https://viem.sh/docs/siwe/actions/verifySiweMessage. "EIP-4361 formatted message to be verified."
- h-13: https://viem.sh/docs/actions/public/verifyMessage. "only supports Externally Owned Accounts." (util-vs-action contrast; the action supports smart accounts)
- h-14: https://viem.sh/docs/utilities/verifyTypedData. "This utility can only verify typed data that was signed by an Externally Owned Account (EOA)."
- h-15: https://viem.sh/docs/accounts/local/signTypedData. "Signs typed data and calculates an Ethereum-specific signature in https://eips.ethereum.org/EIPS/eip-712"
- h-16: https://viem.sh/docs/contract/readContract. "TypeScript types for `args` will be inferred from the function name & ABI, to guard you from inserting the wrong values."
- h-17: https://registry.npmjs.org/viem/latest. "\"@noble/curves\":\"1.9.1\""
- h-18: https://github.com/paulmillr/noble-curves. "| verify | 1,352 | 739 μs |"
- h-19: https://eips.ethereum.org/EIPS/eip-4361. "The verification method specified in ERC-1271 SHOULD be used."
- h-20: https://eips.ethereum.org/EIPS/eip-712. "the address of the contract that will verify the signature."
- h-21: https://packagist.org/packages/zbkm/siwe. "This package provides a PHP implementation of EIP-4361: Sign In With Ethereum."
- h-22: https://packagist.org/packages/simplito/elliptic-php. "Published on Packagist.org on 2024-01-09 14:59 UTC."
- h-24: https://packagist.org/packages/kornrunner/keccak. "Pure PHP implementation of Keccak"
- h-25: https://packagist.org/packages/web3p/web3.php. "Published on Packagist.org on 2024-01-28 07:51 UTC"
- h-27: https://packagist.org/packages/sleepfinance/eip712. "Generate Eip712 Hashes for signing"
- h-29: https://packagist.org/packages/bitwasp/secp256k1-php. "php: ^7.0."
- h-30: https://dev.to/buildcoreworks/building-high-performance-secp256k1-ecdsa-for-php-2987x-faster-2jl3. "100-135ms" per verification
- h-33: https://redis.io/docs/latest/commands/expire/. "After the timeout has expired, the key will automatically be deleted."
- h-34: https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/. "there are no guarantees that the Redis server will be able to generate the `expired` event at the time the key time to live reaches the value of zero."
- h-36: https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/. "Redis has already been benchmarked at more than 60000 connections, and was still able to sustain 50000 q/s in these conditions."
- h-38: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control. "The `stale-while-revalidate` response directive indicates that the cache could reuse a stale response while it revalidates it to a cache."
- h-39: https://ponder.sh/docs/get-started. "an open-source TypeScript framework for EVM data indexing."

**colyseus**
- c-1: https://raw.githubusercontent.com/colyseus/colyseus/master/packages/core/package.json. "\"name\": \"@colyseus/core\" ... \"version\": \"0.18.23\" ... \"license\": \"MIT\" ... \"engines\": ... \"node\": \">= 22.x\""
- c-4, c-5: https://raw.githubusercontent.com/colyseus/colyseus/master/packages/sdk/src/Client.ts. "const httpResponse = await (this.http as HTTP<any>).post(`/matchmake/${method}/${roomName}`, {" / "const endpointURL = `${endpoint}/${seatReservation.processId}/${seatReservation.roomId}?${searchParams}`;"
- c-6: https://raw.githubusercontent.com/colyseus/colyseus/master/packages/transport/ws-transport/src/WebSocketTransport.ts. "const processAndRoomId = parsedURL.pathname.match(/\\/[a-zA-Z0-9_\\-]+\\/([a-zA-Z0-9_\\-]+)$/);"
- c-7: https://docs.colyseus.io/server. "The seat reservation returned to the SDK carries it, so clients connect to the right machine directly." (path-style publicAddress precedent: verifier read `getDefaultPublicAddress()` in packages/core/src/utils/Env.ts)
- c-8: https://docs.colyseus.io/sdk. "Your backend can do the matchmaking itself and hand the client a seat."
- c-9: https://docs.colyseus.io/server/transport. "WebSockets (the default), uWebSockets.js (native), and WebTransport."
- c-10, c-15: https://docs.colyseus.io/server/transport/ws. "`maxPayload` default 4096 (4kb)" / "Runs before the WebSocket handshake, while the connection is still a plain HTTP request."
- c-11: https://docs.colyseus.io/server/transport/uwebsockets. "The uWebSockets.js generally performs better than the default WebSockets implementation,"
- c-14: https://raw.githubusercontent.com/colyseus/colyseus/master/packages/core/src/Transport.ts. "export abstract class Transport {"
- c-16: https://docs.colyseus.io/server/presence. "For single-process deployments, the default in-memory presence is sufficient."
- c-17: https://docs.colyseus.io/faq. "As a baseline, a small cloud server (1 vCPU, 1GB RAM) can typically handle 1,000-2,000 concurrent connections"
- c-18: https://docs.colyseus.io/learn/tutorial/phaser/basic-player-movement. "npm install --save phaser @colyseus/sdk"
- c-20: https://docs.colyseus.io/sdk/connection. "Automatic reconnection only triggers if the room has been connected for at least `minUptime` milliseconds."
- c-21: https://docs.colyseus.io/server/http-routes. "CORS is enabled by default. You can customize the headers:"
- c-24: https://localtonet.com/blog/self-host-colyseus-behind-nat-localtonet. "The Localtonet client creates an outbound relay connection, so the workflow does not require inbound router port forwarding"
