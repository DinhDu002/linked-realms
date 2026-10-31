# Hosting your Land

Your Land is a Map server running on your machine. It links out to the world's relay, so you do not open any port. It takes one command, which the Shell writes for you.

Your Land also runs a Node of LR, the project's chain, and its Mine, which mines Gold by Proof of Work for your Character. The Mine is off until you switch it on (P5). The main network starts after step 2C (P7); until then Gold is on the test network.

## What you need

- Docker (Docker Desktop on macOS and Windows, Docker Engine on Linux), running, on a 64-bit machine (x86-64 or ARM) that can stay on and whose clock is right: the Hub refuses statements more than 5 minutes off.
- A Character, made in the world's Shell (the project's test world is <https://play.linkedrealms.com>).
- For the Mine, memory to spare: with 2.5 GiB free it mines in fast mode, otherwise in light mode, several times slower.

## 1. Run the command from the Shell

In the Shell, unlock your Character and find "Your Land". It shows one command with your Character's address and the world's Hub in it. Choose "Copy command", paste it into a terminal (Terminal on macOS and Linux, PowerShell on Windows) and run it. It looks like this:

```bash
docker run -d --name linked-realms-land --restart unless-stopped -v linked-realms-land:/data -e LAND_OWNER=tlr1… -e HUB_URL=https://hub.example.org ghcr.io/dinhdu002/linked-realms-node:latest
```

The first run downloads the image, a few hundred megabytes. The Map server then reads the Hub's ticket signer and the relay's URL from the Hub (`GET <HUB_URL>/keys`), so you set nothing else. Nothing in the command is secret. The Map server key is created inside the container on first start and never leaves the `linked-realms-land` volume.

Read the start-up log:

```bash
docker logs linked-realms-land
```

```
Map server listening on http://127.0.0.1:2567
Accepting Travel tickets signed by tlr1… (from the Hub)

Map server key created: tlr1qqqa3mt0…
Next, the Land owner (tlr1…) signs a Delegation for this Map server key under "Your Land" in the Shell.
Waiting for the Hub to create the Land...
```

## 2. Register your Map server

The Map server key is your Map server's identity. It holds no assets and is not your Character's key (P2). You tell the Hub that this key may serve your Land:

1. In the Shell, unlock your Character and find "Your Land". Under "Waiting Map servers" it lists every Map server key that named you as its owner.
2. Check that the key matches the `Map server key created:` line of your log, then choose "Register". The Shell signs a Delegation for that key with your Character's key, which never leaves the Shell, and the Hub creates your Land.
3. Within 10 seconds the log shows `Serving Land <id>` and `linked to the relay as Land <id>`. Within about 15 seconds more, the Hub gives your Land a cell next to the others, and "Your Land" shows `Its cell is (x, y). It is online.`

A Character has one Land. Register only a key your own server printed: whoever runs that key serves your Land.

## 3. Play

Your Land is in the Directory. Choose "Enter" to walk around it; walking onto a Gate at its edge takes your Character into the neighbouring Land, if there is one.

## 4. Your own domain (optional)

Your Land is always at `<landId>.<the world's Land domain>`. It can also be served at a domain you own, such as `play.example.com`:

1. At your DNS provider, point the domain at the world's relay: a `CNAME` record to the name the world's operator publishes for own domains, or the addresses they publish for a domain that cannot have a `CNAME`.
2. Add a `TXT` record named `_linked-realms.play.example.com` with the value `land=<your Land id>`. "Your Land" in the Shell shows that value.
3. In the Shell, under "Your Land", enter the domain and choose "Save domain". The Hub reads the `TXT` record; if your DNS provider has not published it yet, the Hub names the record it is missing, so try again a few minutes later.

The Directory then shows your Land at `https://play.example.com`. Its certificate is made on the first visit, once your Land has a cell, so that visit takes a few seconds longer. Keep the `TXT` record: the Hub reads it again once a day and removes the domain when the record no longer names your Land. "Remove domain" takes it off at once.

## 5. Your Mine

The Map server starts your Land's Node, `lr-node`, with its Mine off, and keeps its chain in the same volume (`/data/lr-node`). The Node dials out to the Nodes in `NODE_SEEDS` and opens no port. Until it has another Node and has caught up with the chain, every visitor's Land shows `Mine unavailable`. Add `-e NODE_SEEDS=host:port` to the command with the seed Node the world's operator publishes.

1. Enter your Land. Only you see "Switch the Mine": choose it, then On and the number of threads (at most one fewer than your machine's CPUs).
2. Choose "Sign in the Shell" and approve the switch in the Shell's own prompt. The Shell signs it with your Character's key, which never leaves the Shell; your Land checks the signature before it tells the Node.
3. The Mine starts. In fast mode it first builds a 2 GiB dataset, from about 20 seconds to over a minute. The log then shows `Mine ON: 2 threads, fast mode, rewards to tlr1…`, and every visitor sees the Mine run, its hash rate and the Blocks it won. Each Block it wins pays your Character's address.

Switch it off the same way, with Off. A restart of the container or of the machine leaves the Mine off. `-e MINE_MAX_THREADS=2` caps the threads you may choose, and `-e NODE_ENABLED=false` runs no Node at all. A plain `docker run` has no huge pages, which mining would use, so it mines somewhat slower than a tuned machine.

## Everyday tasks

| Task | Command |
|---|---|
| Watch the log | `docker logs -f linked-realms-land` |
| Stop your Land (it shows offline within about 15 seconds) | `docker stop linked-realms-land` |
| Start it again | `docker start linked-realms-land` |
| Update | `docker pull ghcr.io/dinhdu002/linked-realms-node:latest` (the image in your command), then `docker rm -f linked-realms-land` and run the command again. The volume keeps the Map server key and the chain, so you do not register again. |
| Remove everything | `docker rm -f linked-realms-land && docker volume rm linked-realms-land`. This deletes the Map server key and the chain; the Gold your Mine won stays at your Character's address. The Land stays yours: a new Map server shows up under "Waiting Map servers", and "Use this one" moves your Land to it. |

**Moving to another machine.** Either copy the volume and run the same command, or start fresh and choose "Use this one" for the new key in the Shell. The newest Delegation wins; the relay cuts the old machine off within 30 seconds.

**Offline for long.** A Land keeps its cell while offline. After 30 days offline it loses the cell, and when it comes back it gets a new one at the edge of the world.

## When something is wrong

| Log line | Meaning and fix |
|---|---|
| `docker: … Conflict. The container name "/linked-realms-land" is already in use` | Your Land already runs on this machine: `docker start linked-realms-land` starts it if it is stopped. To run the command again, `docker rm -f linked-realms-land` first; the volume keeps the Map server key. |
| `Unable to find image …` then `manifest unknown` or `denied` | The image in the command is not published, or not public yet. Tell the world's operator. |
| `Cannot connect to the Docker daemon` (`… docker_engine …` on Windows) | Docker is not running: start Docker Desktop, wait until it says it is running, and run the command again. |
| `could not read GET /keys from the Hub at … (…); retrying in … s` | The Hub cannot be reached: check `HUB_URL` in the command, or wait for the Hub to come back. |
| `could not register with the Hub (…); retrying in … s` | The Hub cannot be reached, or refused the statement: check `HUB_URL` and your clock. |
| `Land … is owned by …, not by LAND_OWNER …: not serving it` | This key serves another Character's Land. Set `LAND_OWNER` to your own address, or start with a new volume. |
| `relay link closed (4401 …)` | The relay refused the link: a `RELAY_URL` you set is not the world's relay, your Land now uses another Map server key, or the Land was hidden after an abuse report. |
| `relay link closed (4403 Map server key changed or Land hidden)` | You chose another Map server key for this Land, or it was hidden. |
| `relay link closed (4409 replaced by a newer link)` | Another machine serves the same Land with the same key. Stop one of them. |
| `relay link closed (1013 …)` | The Hub is down or the relay is full; your server keeps retrying. |
| `/data/map-server-key is readable by others` or `must hold a 32-byte hex seed` | The key file was changed by hand. Restore it, or remove the volume to start with a new key (step 2 again). |
| `LAND_OWNER …`, `HUB_URL …`, `HUB_TICKET_SIGNER …`, `RELAY_URL …` errors | Copy the command from the Shell again, then `docker rm -f linked-realms-land` and run it. |
| `Mine unavailable: this Land's Node is not running or not synced` (in the Land) | The Node has no other Node yet or is catching up: check `NODE_SEEDS`, and wait. |
| `The Node stopped (…); starting it again in … s, with its Mine off` | The Node exited; the Map server starts it again. Switch the Mine on again if you want it. |
| `The Node refused its settings (exit code 2)` | A `NODE_*` or `MINE_MAX_THREADS` setting is wrong: the line above it names it. Fix it and run the command again. |
| `Could not run the Node (NODE_BIN …)` | The image has no `lr-node`: use the published image, or set `NODE_ENABLED=false`. |

## Other settings

The command sets only `LAND_OWNER` and `HUB_URL`. Add `-e NAME=value` before the image for any other setting of the Map server (`packages/map-server/README.md`), for example:

- `-e HUB_TICKET_SIGNER=tlr1…` and `-e RELAY_URL=wss://…` pin the ticket signer and the relay instead of reading them from the Hub.
- To run your own build of the image, `docker build -t linked-realms-node https://github.com/DinhDu002/linked-realms.git#main` (no clone needed; it compiles the Rust core and `lr-node` and takes ten minutes or more), then use `linked-realms-node` as the image in the command.

## What your machine does and does not do

- It runs your Land for its visitors and opens no inbound port.
- It runs a Node that checks every Block itself (P3), and mines only while you have switched the Mine on (P5).
- It checks every arriving Character's Travel ticket, signed by the Hub, and arrival statement, signed by the Character.
- It never runs code sent by other players or servers (P6) and never holds a Player's key (P2): only its own Map server key.
- It cannot change another Land or the Hub's records (P1). Gold is decided by chain rules that every Node checks, yours included.
