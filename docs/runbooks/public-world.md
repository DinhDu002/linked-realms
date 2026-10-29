# Running a public world

One server runs the Hub, the relay, the Shell and the Hub's PostgreSQL behind Caddy, from `deploy/`. Land owners run their Map servers on their own machines with [docs/self-hosting.md](../self-hosting.md). Test network only (P7).

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
- `HUB_TICKET_KEY`: the seed of the key that signs Travel tickets. It lets a Character into a Land and holds no assets. Every Map server trusts its address (`HUB_TICKET_SIGNER`), so keep a copy: a new key means every Land owner changes that setting.
- `HUB_SESSION_SECRET`: signs the Hub's session tokens. Changing it only ends every session, and the Shell signs in again by itself.

Leave `HUB_ADMINS` empty for now.

## 4. Start

```bash
docker compose -f deploy/compose.public.yaml up -d --build
docker compose -f deploy/compose.public.yaml ps   # hub-api and relay become healthy
curl -s https://hub.example.org/keys             # the ticket signer to publish
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

## Everyday tasks

| Task | Command |
|---|---|
| Update | `git pull`, then `docker compose -f deploy/compose.public.yaml up -d --build`. Map servers reconnect by themselves. |
| Logs | `docker compose -f deploy/compose.public.yaml logs -f hub-api relay caddy` |
| Back up | Keep `deploy/.env`, and dump the database: `docker compose -f deploy/compose.public.yaml exec postgres pg_dump -U linked_realms linked_realms > hub.sql` |
| Relay load | `docker compose -f deploy/compose.public.yaml exec relay wget -qO- http://127.0.0.1:8080/stats` (`/stats` and `/online` are not public) |

## Known limits

- `hub-api` runs as one process: used sign-in nonces, rate limits and the presence cache live in its memory.
- Lands can set cookies for one another until the Lands' domain is on the Public Suffix List.
- No admin page in the Shell.
