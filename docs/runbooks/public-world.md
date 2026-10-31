# Running a public world

One server runs the Hub, the relay, the Shell and the Hub's PostgreSQL behind Caddy, from `deploy/`. Land owners run their Map servers on their own machines with [docs/self-hosting.md](../self-hosting.md). LR's test network runs beside it as a compose project of its own, and its Checkpoint signer on the project owner's machine (section 7); the main network comes after step 2C (P7).

## 1. Names

The world needs four names. In this runbook:

| Variable | Example | What it serves |
|---|---|---|
| `SHELL_DOMAIN` | `play.example.org` | The Shell, where Players keep their keys |
| `HUB_DOMAIN` | `hub.example.org` | The Hub's API. Every signed statement names it, so choose it once |
| `RELAY_HOST` | `relay.example.org` | Where Map servers link out to |
| `LAND_BASE_DOMAIN` | `example-lands.net` | Every Land, at `<landId>.example-lands.net` |

Put the Lands under a registrable domain of their own, never under the Shell's or the Hub's. A Land's pages are written by its owner, and anything under the same registrable domain as the Shell could set cookies for it. Then ask for the Lands' domain to be listed on the [Public Suffix List](https://github.com/publicsuffix/list): until it is, Lands can set cookies for one another. That is a known limit.

## 2. DNS

- `A` (and `AAAA` if the server has IPv6) records for `SHELL_DOMAIN`, `HUB_DOMAIN` and `RELAY_HOST`, pointing at the server.
- The same for `*.LAND_BASE_DOMAIN`.
- Keep these records DNS-only: Caddy must see each client's own address, because the Hub counts its per-network limits from it.

Every name gets a certificate from Let's Encrypt. The three single names use the HTTP challenge. The Lands share one wildcard certificate, which needs the DNS-01 challenge, so Caddy needs an API token for the Lands' DNS zone. The example uses Cloudflare: a token with `Zone.DNS: Edit` on that zone only. For another provider, change the `xcaddy --with` module in `deploy/compose.public.yaml` and the `dns` line in `deploy/Caddyfile` to that provider's module from <https://github.com/caddy-dns>.

## 3. The server

A Linux machine with Docker Engine and the Compose plugin, ports 80 and 443 open (443 on both TCP and UDP), and a clone of this repository.

```bash
git clone https://github.com/DinhDu002/linked-realms.git && cd linked-realms
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Fill in `deploy/.env`: the four names, `ACME_EMAIL`, `CLOUDFLARE_API_TOKEN`, and three secrets made with `openssl rand -hex 32`:

- `POSTGRES_PASSWORD`: the Hub's database.
- `HUB_TICKET_KEY`: the seed of the key that signs Travel tickets. It lets a Character into a Land and holds no assets. Every Map server trusts its address, which it reads from `GET /keys` at start, so keep a copy: a new key means every Land owner restarts their Map server, and those who pinned `HUB_TICKET_SIGNER` change it.
- `HUB_SESSION_SECRET`: signs the Hub's session tokens. Changing it only ends every session, and the Shell signs in again by itself.

Leave `HUB_ADMINS` empty for now. `LAND_IMAGE` is the Map server image the Shell's "Your Land" command runs; leave it unset for the project's image (`.github/workflows/image.yml`).

## 4. Start

```bash
docker compose -f deploy/compose.public.yaml up -d --build
docker compose -f deploy/compose.public.yaml ps   # hub-api and relay become healthy
curl -s https://hub.example.org/keys             # the ticket signer, and relayUrl wss://relay.example.org
curl -s https://relay.example.org/health         # ok
```

Then open `https://play.example.org` and create a Character.

The `caddy` container's address is fixed (`172.30.0.10`) and named in `HUB_TRUSTED_PROXIES`, so the Hub reads clients' addresses from the `X-Forwarded-For` header Caddy writes, and from no one else. If the subnet `172.30.0.0/24` is already used on the server, change it, Caddy's address and `HUB_TRUSTED_PROXIES` together.

## 5. The admin

An admin can list abuse reports and hide a Land.

1. Create the admin's Character in the Shell and copy its address.
2. Put it in `HUB_ADMINS` in `deploy/.env` (several are comma-separated), then `docker compose -f deploy/compose.public.yaml up -d hub-api`.

The routes are `GET /admin/reports` and `POST /admin/lands/:landId/hidden`, with an admin's session token (`packages/hub-api/README.md`). The Shell has no admin page yet, so in step 2B nothing calls them for you: that is a known limit.

## 6. Tell Land owners

Publish the Shell's URL, the Hub's URL (`https://hub.example.org`) and the relay's URL (`wss://relay.example.org`), and point them to [docs/self-hosting.md](../self-hosting.md). A Land is in the Directory once its owner registers its Map server and the Hub sees it online.

Land owners may also serve their Land at a domain of their own (self-hosting, step 6). Publish where those domains point: a `CNAME` to `relay.example.org`, or the server's addresses for a domain that cannot have a `CNAME`. Caddy makes a certificate for a name it does not know only when the Hub's `GET /tls/allowed?domain=` answers `200`, which it does only for an own domain the Hub has checked, on a visible Land with a cell.

## 7. The chain

LR's company services: a seed node that every other Node dials first, the Public node whose RPC the Shell reads, and an archive that keeps every Block. They are a compose project of their own (`deploy/compose.chain.yaml`), on this server or another. Each runs the `lr-node` image, which holds the binary and no key.

1. Open the P2P port to the internet: TCP 9444, or `LR_P2P_PORT` in `deploy/.env`. It is the only port the chain publishes.
2. Choose a name for the Public node's RPC, `rpc.example.org` here, give it DNS like the others, put it in `RPC_DOMAIN` in `deploy/.env`, and add it to the Caddy in front (`deploy/Caddyfile`):

   ```
   rpc.example.org {
   	reverse_proxy 172.31.0.3:9445
   }
   ```

3. Start the chain, then join Caddy to its network at the one address the Public node trusts for `X-Forwarded-For`, so it counts its rate limits for each client and not for Caddy:

   ```bash
   docker compose -f deploy/compose.chain.yaml up -d --build
   docker network connect --ip 172.31.0.10 linked-realms-chain_default <the Caddy container>
   curl -s https://rpc.example.org -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"lr_getInfo"}'   # the tip, and latestCheckpoint
   ```

   Then rebuild the Shell, which is built with that name and the network (`LR_NETWORK`) and calls only it and the Hub: `docker compose -f deploy/compose.public.yaml up -d --build shell`.

   Recreating the Caddy container drops the join; run `docker network connect` again. If the subnet `172.31.0.0/24` is already used on the server, change it, the two addresses and `--rpc-proxy` in `deploy/compose.chain.yaml` together.

The Checkpoint signer runs on the project owner's own machine, never on the chain's server: its key can rewrite deep history (ADR 0015). It is a Node that checks every Block itself and dials the seed. Once it is synced, it signs the Block at each multiple of 10 that is at least 6 Blocks below its tip, and its Checkpoints reach every Node through the seed. Its key is the 24 words of the network's Checkpoint signer key, in a file on that machine, which compose mounts as a secret. `lr-node` refuses words that are not the network's key.

```bash
sudo chown 10001 /path/to/words && sudo chmod 0400 /path/to/words   # on Linux: the image's user reads it
LR_SEED=seed.example.org:9444 CHECKPOINT_WORDS=/path/to/words \
  docker compose -f deploy/compose.signer.yaml up -d --build
docker compose -f deploy/compose.signer.yaml logs -f   # "checkpoint <height> <Block id>" every 10 Blocks
```

`LR_SEED` is the chain server's name, or its address, and the P2P port. A name is looked up when the signer starts, so restart the signer after the server's address changes.

## 8. The check with three Players

Step 2C ends when three Players on three machines play on the test network (`PLAN.md`, 2C "Done when"). With the world (sections 3 to 6) and the chain (section 7) running, and the signer printing Checkpoints:

1. Each Player, on their own machine, opens the Shell, makes a Character, and runs the command under "Your Land" with `-e NODE_SEEDS=seed.example.org:9444` (self-hosting, steps 1 to 5). Each Land is online in the Directory within about 15 seconds.
2. In their own Land, each switches the Mine on and signs the switch in the Shell. Each Mine wins Blocks: every visitor sees the flash, and the Shell's balance grows.
3. Each sends Gold with a memo to another through the Shell's Send. The recipient sees it as received once a Block holds it.
4. Each walks into another's Land, through a Gate or from the Directory.
5. Record the date, the three machines, and a Block each Mine won and a transfer each Player sent in `PLAN.md`'s Log.

## Everyday tasks

| Task | Command |
|---|---|
| Update | `git pull`, then `docker compose -f deploy/compose.public.yaml up -d --build`. Map servers reconnect by themselves. |
| Logs | `docker compose -f deploy/compose.public.yaml logs -f hub-api relay caddy` |
| Back up | Keep `deploy/.env`, and dump the database: `docker compose -f deploy/compose.public.yaml exec postgres pg_dump -U linked_realms linked_realms > hub.sql` |
| Update the chain | `git pull`, then `docker compose -f deploy/compose.chain.yaml up -d --build`, and the same on the signer's machine with `deploy/compose.signer.yaml` |
| Chain logs | `docker compose -f deploy/compose.chain.yaml logs -f`; the signer prints each Checkpoint it signs |
| Relay load | `docker compose -f deploy/compose.public.yaml exec relay wget -qO- http://127.0.0.1:8080/stats` (`/stats` and `/online` are not public) |

## Known limits

- `hub-api` runs as one process: used sign-in nonces, rate limits and the presence cache live in its memory.
- Lands can set cookies for one another until the Lands' domain is on the Public Suffix List.
- No admin page in the Shell.
- The Public node's RPC takes 128 connections in all. Its rate limits count calls for each client, but one client can hold every WebSocket.
- The Checkpoint signer trusts the Nodes it dials to show it the best chain: it cannot see a longer branch that the seed hides from it.
- An own domain's certificate is ordered on its first visit. Let's Encrypt limits how many certificates one account orders in a short time, so a burst of new own domains may wait.
