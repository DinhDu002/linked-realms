# Hosting your Land

Your Land is a Map server running on your machine. It links out to the Hub's relay, so you do not open any port, and it runs the miner, which mines only after you switch it on in the game. This guide uses Docker; it takes one command once the image is built.

Testnet only (P7): Base Sepolia, chain id 84532. `GOLD` has no value.

## What you need

- Docker (Docker Desktop on macOS and Windows, Docker Engine on Linux). Any 64-bit machine that can stay on; mining uses as many CPU threads as you allow, nothing else is heavy.
- A Character, made in the game client. Making a Character gives you your Land: the client shows `Your Land: <id> at (x, y)`. Your Land cannot be transferred, because it lives on your machine.
- The world's settings, published by the project with the testnet world: the relay URL and the Hub's ticket signer address.
- An RPC endpoint for Base Sepolia. The public `https://sepolia.base.org` is rate-limited; the miner reads the chain every second, so a free key from an RPC provider is more reliable.
- A little Base Sepolia ETH for your Mining key (below), from a faucet. Rewards never go to the Mining key: they go to your wallet, the Land owner.

## 1. Build the image

Until the project publishes the image, build it from the public repository; no clone is needed:

```bash
docker build -t linked-realms-node https://github.com/DinhDu002/linked-realms.git#main
```

## 2. Write `land.env`

```bash
# Your Land, from the game client: "Your Land: <id>"
LAND_ID=12
CHAIN_ID=84532
RPC_URL=https://sepolia.base.org
# From the testnet world's published settings
RELAY_URL=wss://relay.example
HUB_TICKET_SIGNER=0x0000000000000000000000000000000000000000
# The most threads you can choose in the game when you switch mining on (default: all but one)
MINING_MAX_THREADS=2
```

Nothing in this file is secret. The Mining key is generated inside the container and never leaves the `/data` volume.

## 3. Start your Land

```bash
docker run -d --name linked-realms-land --restart unless-stopped \
  --env-file land.env -v linked-realms-land:/data --cpus 2 linked-realms-node
```

`--cpus 2` is a hard limit Docker enforces on top of `MINING_MAX_THREADS`; set both to what you are happy to give.

Read the start-up log:

```bash
docker logs linked-realms-land
```

```
Mining key created: 0x4B6F…dcBB, balance 0 ETH. Mining is off until the Land owner switches it on.
WARNING: Mining key has no ETH: fund 0x4B6F…dcBB from a faucet to pay fees for submitting Solutions
Map server for Land 12 (owner 0x…) at ws://127.0.0.1:2567
Reachable through the relay at wss://relay.example (once the Land owner registers the Mining key with the Hub), …
relay link closed (4404 Land is not in the Directory (unknown or hidden)); retrying in 1 s
```

The `4404` lines are expected until step 4.

## 4. Register your Map server

The Mining key is your Map server's identity. It holds only fees, never your assets (P2). You tell the Hub that this key may host your Land:

1. Send a little Base Sepolia ETH to the Mining key address from the log. It pays the fee each time your miner submits a Solution.
2. In the game client, connect the wallet that owns the Land and sign in to the Hub.
3. Under `Your Land`, paste the Mining key address into "Register Map server" and sign. Your wallet shows a Delegation for your Land id and that address; sign only an address your own server printed.
4. Within 30 seconds the log stops showing `4404`, and the Directory lists your Land as online.

## 5. Mine

Enter your Land from the Directory. As the owner you see "Turn mining on" and a thread count; nobody else can switch it. Mining stops when you switch it off, and does not start by itself after a restart. Rewards go to your wallet; the client shows your `GOLD` balance and Rounds won.

## Everyday tasks

| Task | Command |
|---|---|
| Watch the log | `docker logs -f linked-realms-land` |
| Stop your Land (it shows offline within seconds) | `docker stop linked-realms-land` |
| Start it again | `docker start linked-realms-land` |
| Update | Build the image again (step 1), then `docker rm -f linked-realms-land` and run step 3 again. The volume keeps the Mining key, so you do not register again. |
| Remove everything | `docker rm -f linked-realms-land && docker volume rm linked-realms-land`. This deletes the Mining key; move its ETH out first if you care about it. |

**Moving to another machine.** Either copy the volume and run the same command, or start fresh and register the new Mining key (step 4). The newest registration wins; the old machine is cut off within 30 seconds.

## When something is wrong

| Log line | Meaning and fix |
|---|---|
| `relay link closed (4404 Land is not in the Directory …)` | Not registered yet (step 4), or the Land was hidden after an abuse report. |
| `relay link closed (4403 signer is not the Land's delegated Mining key)` | The Hub has a different Mining key for this Land, for example after you registered another machine. Register this one again. |
| `relay link closed (4409 replaced by a newer link)` | Another machine is hosting the same Land with the same key. Stop one of them. |
| `relay link closed (1013 Hub unavailable, retry later)` | The Hub is down; your server keeps retrying. |
| `WARNING: Mining key has no ETH` | Fund the Mining key address (step 4.1). |
| `RPC is chain … but CHAIN_ID is …: refusing to start` | `RPC_URL` points at another network than `CHAIN_ID`. |
| `no deployment for chain 84532` | The image predates the testnet deployment. Build it again. |
| `LAND_ID …`, `HUB_TICKET_SIGNER …`, `RELAY_URL …` errors | Fix that line in `land.env`, then `docker rm -f linked-realms-land` and run step 3 again. |

## What your machine does and does not do

- It runs the Land's simulation for visitors and, when you switch it on, the miner. It opens no inbound port.
- It never runs code sent by other players or servers (P6), and it never holds your wallet's key (P2).
- Everything that matters to other players is decided by the contracts (P1): a modified server cannot mint `GOLD` or take anyone's Land.
