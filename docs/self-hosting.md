# Hosting your Land

Your Land is a Map server running on your machine. It links out to the world's relay, so you do not open any port. This guide uses Docker; it takes one command once the image is built.

Test network only (P7). There is no Gold yet: the chain, the Node and the Mine arrive in step 2C.

## What you need

- Docker (Docker Desktop on macOS and Windows, Docker Engine on Linux), on a 64-bit machine that can stay on and whose clock is right: the Hub refuses statements more than 5 minutes off.
- A Character, made in the world's Shell. The Shell shows its address (`tlr1…`) under "Character" and again under "Your Land".
- The world's settings, published by whoever runs it: the Hub's URL and the relay's URL. The Hub publishes its ticket signer itself:

  ```bash
  curl -s https://hub.example.org/keys   # {"ticket":{"address":"tlr1…","publicKey":"…"}}
  ```

## 1. Build the image

Until the project publishes the image, build it from the public repository; no clone is needed. The first build compiles the Rust core to WebAssembly and takes a few minutes.

```bash
docker build -t linked-realms-node https://github.com/DinhDu002/linked-realms.git#main
```

## 2. Write `land.env`

```bash
# Your Character's address, from the Shell
LAND_OWNER=tlr1…
# From the world's published settings
HUB_URL=https://hub.example.org
RELAY_URL=wss://relay.example.org
# ticket.address from GET <HUB_URL>/keys
HUB_TICKET_SIGNER=tlr1…
```

Nothing in this file is secret. The Map server key is created inside the container on first start and never leaves the `/data` volume.

## 3. Start your Land

```bash
docker run -d --name linked-realms-land --restart unless-stopped \
  --env-file land.env -v linked-realms-land:/data linked-realms-node
```

Read the start-up log:

```bash
docker logs linked-realms-land
```

```
Map server listening on http://127.0.0.1:2567
Accepting Travel tickets signed by tlr1…

Map server key created: tlr1qqqa3mt0…
Next, the Land owner (tlr1…) signs a Delegation for this Map server key under "Your Land" in the Shell.
Waiting for the Hub to create the Land...
```

## 4. Register your Map server

The Map server key is your Map server's identity. It holds no assets and is not your Character's key (P2). You tell the Hub that this key may serve your Land:

1. In the Shell, unlock your Character and find "Your Land". Under "Waiting Map servers" it lists every Map server key that named you as its owner.
2. Check that the key matches the `Map server key created:` line of your log, then choose "Register". The Shell signs a Delegation for that key with your Character's key, which never leaves the Shell, and the Hub creates your Land.
3. Within 10 seconds the log shows `Serving Land <id>` and `linked to the relay as Land <id>`. Within about 15 seconds more, the Hub gives your Land a cell next to the others, and "Your Land" shows `Its cell is (x, y). It is online.`

A Character has one Land. Register only a key your own server printed: whoever runs that key serves your Land.

## 5. Play

Your Land is in the Directory. Choose "Enter" to walk around it; walking onto a Gate at its edge takes your Character into the neighbouring Land, if there is one.

## 6. Your own domain (optional)

Your Land is always at `<landId>.<the world's Land domain>`. It can also be served at a domain you own, such as `play.example.com`:

1. At your DNS provider, point the domain at the world's relay: a `CNAME` record to the name the world's operator publishes for own domains, or the addresses they publish for a domain that cannot have a `CNAME`.
2. Add a `TXT` record named `_linked-realms.play.example.com` with the value `land=<your Land id>`. "Your Land" in the Shell shows that value.
3. In the Shell, under "Your Land", enter the domain and choose "Save domain". The Hub reads the `TXT` record; if your DNS provider has not published it yet, the Hub names the record it is missing, so try again a few minutes later.

The Directory then shows your Land at `https://play.example.com`. Its certificate is made on the first visit, once your Land has a cell, so that visit takes a few seconds longer. Keep the `TXT` record: the Hub reads it again once a day and removes the domain when the record no longer names your Land. "Remove domain" takes it off at once.

## Everyday tasks

| Task | Command |
|---|---|
| Watch the log | `docker logs -f linked-realms-land` |
| Stop your Land (it shows offline within about 15 seconds) | `docker stop linked-realms-land` |
| Start it again | `docker start linked-realms-land` |
| Update | Build the image again (step 1), then `docker rm -f linked-realms-land` and run step 3 again. The volume keeps the Map server key, so you do not register again. |
| Remove everything | `docker rm -f linked-realms-land && docker volume rm linked-realms-land`. This deletes the Map server key. The Land stays yours: a new Map server shows up under "Waiting Map servers", and "Use this one" moves your Land to it. |

**Moving to another machine.** Either copy the volume and run the same command, or start fresh and choose "Use this one" for the new key in the Shell. The newest Delegation wins; the relay cuts the old machine off within 30 seconds.

**Offline for long.** A Land keeps its cell while offline. After 30 days offline it loses the cell, and when it comes back it gets a new one at the edge of the world.

## When something is wrong

| Log line | Meaning and fix |
|---|---|
| `could not register with the Hub (…); retrying in … s` | The Hub cannot be reached, or refused the statement: check `HUB_URL` and your clock. |
| `Land … is owned by …, not by LAND_OWNER …: not serving it` | This key serves another Character's Land. Set `LAND_OWNER` to your own address, or start with a new volume. |
| `relay link closed (4401 …)` | The relay refused the link: `RELAY_URL` is not the world's relay, your Land now uses another Map server key, or the Land was hidden after an abuse report. |
| `relay link closed (4403 Map server key changed or Land hidden)` | You chose another Map server key for this Land, or it was hidden. |
| `relay link closed (4409 replaced by a newer link)` | Another machine serves the same Land with the same key. Stop one of them. |
| `relay link closed (1013 …)` | The Hub is down or the relay is full; your server keeps retrying. |
| `/data/map-server-key is readable by others` or `must hold a 32-byte hex seed` | The key file was changed by hand. Restore it, or remove the volume to start with a new key (step 4 again). |
| `LAND_OWNER …`, `HUB_TICKET_SIGNER …`, `RELAY_URL …` errors | Fix that line in `land.env`, then `docker rm -f linked-realms-land` and run step 3 again. |

## What your machine does and does not do

- It runs your Land for its visitors and opens no inbound port.
- It checks every arriving Character's Travel ticket, signed by the Hub, and arrival statement, signed by the Character.
- It never runs code sent by other players or servers (P6) and never holds a Player's key (P2): only its own Map server key.
- It cannot change another Land or the Hub's records (P1). From step 2C, Gold is decided by chain rules that every Node checks.
