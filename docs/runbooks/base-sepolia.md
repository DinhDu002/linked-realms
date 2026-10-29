# Opening the testnet world on Base Sepolia

For the project owner. Claude Code works on anvil only in this run; every step here that touches Base Sepolia, a server or a registry is the owner's. P7: Base Sepolia (chain id 84532) only. `Deploy.s.sol` refuses any chain other than anvil (31337) and Base Sepolia.

What was checked before this runbook was written: `deploy:base-sepolia`'s script ran against an anvil started with chain id 84532. It used the real mining rules (target `2^256 / (3,200,000 × 60)`, 60-second Rounds, a Retarget every 60 Rounds, ×4 clamp, 50 `GOLD`, halving every 210,000 Rounds) and handed ownership to `OWNER`. Nothing below was run against Base Sepolia itself.

## 1. Deploy the contracts

1. Make a deployer key in a Foundry keystore. It needs only gas; the private key never appears in a file or an environment variable:

   ```bash
   cast wallet new                                    # or use an existing key
   cast wallet import linked-realms-deployer --interactive
   cast wallet address --account linked-realms-deployer
   ```

2. Fund that address with Base Sepolia ETH from a faucet. `forge script` prints the estimated cost before it broadcasts.
3. Deploy. `OWNER` receives ownership, and with it the upgrade rights (UUPS); use the owner's main wallet, not the deployer key:

   ```bash
   cd contracts
   OWNER=0xYourMainWallet BASE_SEPOLIA_RPC_URL=https://sepolia.base.org pnpm deploy:base-sepolia
   ```

   Optional: add `--verify --etherscan-api-key <key>` to the command in `contracts/package.json` to publish the sources on Basescan.

4. The script writes `packages/shared/src/deployments/84532.json`. Register it in `packages/shared/src/deployments/index.ts`:

   ```ts
   import baseSepolia from "./84532.json" with { type: "json" };
   // ...
   const deployments: Record<number, Deployment> = {
     31337: anvil as Deployment,
     84532: baseSepolia as Deployment,
   };
   ```

5. Commit both files on a branch and merge them through a pull request. Every package (Map server, `hub-api`, indexer, client) then finds the addresses for chain 84532.

## 2. Run `hub-api` and the relay

They run from the same image as the Map servers (`docker build -t linked-realms-node <repo>`), on a server with a public hostname and TLS. The project owner chose the carthings develop server for this run. On that shared server, use your own directory, compose project and ports, and do not touch carthings services.

Generate the secrets on the server. They go in a `.env` file that never leaves the server:

```bash
cast wallet new                      # HUB_TICKET_KEY: signs Travel tickets, holds nothing
openssl rand -hex 32                 # HUB_SESSION_SECRET
openssl rand -hex 16                 # POSTGRES_PASSWORD
```

| Service | Command | Settings |
|---|---|---|
| PostgreSQL | image `postgres:18.6-alpine3.24` | `POSTGRES_PASSWORD` from `.env`; no public port |
| `hub-api` | `node packages/hub-api/src/main.ts` | `DATABASE_URL`, `CHAIN_ID=84532`, `RPC_URL` (a provider key, not the public endpoint), `HUB_TICKET_KEY`, `HUB_SESSION_SECRET`, `HUB_ADMINS` (the owner's address), `HUB_SIWE_DOMAIN` (the client's host), `HUB_ALLOWED_ORIGINS` (the client's origin), `RELAY_PUBLIC_URL=https://<relay host>`, `RELAY_INTERNAL_URL=http://relay:8080`, `HUB_BUNDLER_URL` (the CDP endpoint, section 7; it holds the API key) |
| relay | `node packages/relay/src/main.ts` | `HUB_URL=http://hub-api:8787`; `MAX_CLIENTS_PER_LAND`, `MAX_HOSTS` if needed |

The `world` profile in `compose.yaml` shows the same services wired together on anvil.

Behind the TLS proxy:

- `https://<hub host>` → `hub-api:8787`.
- `https://<relay host>` → `relay:8080`, with WebSocket upgrades allowed. **Block `/online` and `/stats`** on the public hostname: `hub-api` reads `/online` over the internal network, and neither endpoint has authentication.

Publish the world's settings for Land hosts (`docs/self-hosting.md`): `RELAY_URL=wss://<relay host>`, `HUB_TICKET_SIGNER=<address of HUB_TICKET_KEY>`, `CHAIN_ID=84532`.

## 3. Run the indexer and dashboard

The indexer is not in the image. On the server, from a clone of the repository:

```bash
pnpm install --frozen-lockfile
CHAIN_ID=84532 PONDER_RPC_URL=<provider URL> DATABASE_URL=<postgres URL> HUB_URL=http://127.0.0.1:<hub port> \
  pnpm --filter @linked-realms/indexer start --schema world
```

Keep it running with your process manager. The dashboard is at `/dashboard` on port 42069; put it behind the proxy if it should be public.

## 4. Build and host the client

```bash
VITE_CHAIN_ID=84532 VITE_RPC_URL=<provider URL> VITE_HUB_URL=https://<hub host> \
  pnpm --filter @linked-realms/client build
```

Serve `packages/client/dist/` as static files from the host named in `HUB_SIWE_DOMAIN`, over HTTPS (passkeys need a secure origin). Passkeys are bound to that host name: changing it later strands every Passkey wallet's passkeys, so pick the final one. New Players create a Passkey wallet and need no ETH once section 7 is done; a browser wallet (for example MetaMask) still works, with its own Base Sepolia ETH. The dev wallet exists only on anvil.

## 5. Publish the Land image (optional)

Until an image is published, Land hosts build from the repository (`docs/self-hosting.md`). To publish, push `linked-realms-node` to a registry the project controls (for example `ghcr.io/<owner>/linked-realms-node:<version>`), and change step 1 of the guide to `docker pull`.

## 6. Stage 1 test: three Players on three machines

**Done when** (PLAN.md section 6): on testnet, at least 3 Players on 3 different machines each have a Character, a Land and a mine that is mining; they can walk into each other's Lands; `GOLD` is paid according to the rules.

For each of the three Players, on their own machine:

- [ ] Opens the client, creates a Passkey wallet (or connects a browser wallet), creates a Character. The client shows `Your Land: <id> at (x, y)`.
- [ ] Follows `docs/self-hosting.md`: starts the Land container, funds the Mining key, registers it under `Your Land`.
- [ ] Sees their Land online in the Directory, enters it, switches mining on with one thread.

Together:

- [ ] Each Player enters the other two Lands from the Directory. Adjacent Lands (spiral coordinates: the first Lands are (0, 0), (1, 0), (1, 1), …) are also reached by walking through the Gate on the shared edge.
- [ ] One Player stops their container; within seconds the others see that Land offline in the Directory, and after `docker start` it is online again.
- [ ] After about an hour of mining, the dashboard shows each Land in the winner distribution, a Round time near 60 seconds, and three mines mining.
- [ ] Each Player's `GOLD` balance in the client equals 50 × their Rounds won. On Basescan, every `RoundWon` pays the Land owner's wallet, never the Mining key.

Record the result, with the dashboard figures, in the Log in PLAN.md.

## 7. Sponsored transactions (CDP Paymaster) and the D5 spike

ADR 0005: Passkey wallets send their game transactions through `hub-api`, which checks them and forwards them to the CDP endpoint. Nothing here was run against CDP or Base Sepolia; the same flow was checked on an anvil fork of Base Sepolia with a stand-in bundler (ADR 0005, "Verified").

1. Create a CDP account and a project at the Coinbase Developer Platform, open Paymaster, select Base Sepolia, and copy the endpoint (`https://api.developer.coinbase.com/rpc/v1/base-sepolia/<key>`). It is a secret: put it only in the Hub server's `.env` as `HUB_BUNDLER_URL`, never in the client build.
2. Paymaster configuration, the same values as `packages/shared/src/rules/sponsorship.ts`:
   - Contract allowlist: `PlayerRegistry` with `createCharacter()`, `Land` with `setDesignHash(uint256,bytes32)` (addresses from `84532.json`).
   - Per-user limit: 20 user operations per day. Global limit: 10,000 user operations per day (or a USD cap you choose).
3. Restart `hub-api`. `POST /aa` answers 503 until `HUB_BUNDLER_URL` is set.

The spike (ADR 0005), from a fresh browser profile on the client's real host:

- [ ] "Create passkey wallet", then "Create Character". It succeeds while the wallet's address holds no ETH (check on Basescan: the transaction's fee is paid by the CDP paymaster).
- [ ] "Register Map server" with any address: the Hub accepts the Delegation signed by the deployed wallet.
- [ ] "Add backup passkey" on a second device or a security key. If CDP refuses it (its allowlist cannot name each Player's own wallet), switch the CDP contract allowlist off and keep its limits: the Hub's list is then the allowlist, and the Hub is the only holder of the key. Record which one you did.
- [ ] On a second device with the synced passkey, "Sign in with passkey" shows the same wallet address. Same for the Backup passkey on its own device.
- [ ] A call that is not on the list is refused: `hub-api` answers 403 "only game calls are sponsored" (covered by its tests; repeat with a crafted request only if you change the list).
- [ ] The 21st Sponsored transaction of a day for one wallet is refused with 429.

Record the result in the Log in PLAN.md. If the paymaster cannot sponsor the first transaction, ADR 0005 is re-opened with option B.
