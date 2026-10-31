# @linked-realms/dashboard

The world's public figures on one page with no script: Lands online, Mines mining (reward addresses that won a Block in the last 24 hours), mean Block time and estimated hash rate over the last 100 gaps, the winners of the last 2000 Blocks with the Accounts their Blocks created, and the latest Blocks. It reads the Public node's RPC (`lr_getInfo`, `lr_getHeaders`, `lr_getNewAccountCounts`; [docs/protocols/node-rpc.md](../../docs/protocols/node-rpc.md)) and the Hub's `GET /directory`, and holds no state: one read serves every viewer for 10 seconds, and the page refreshes every 30.

| Variable       | What it is                                                                     | Default  |
| -------------- | ------------------------------------------------------------------------------ | -------- |
| `NODE_RPC_URL` | The Public node's RPC                                                          | required |
| `HUB_URL`      | The Hub; without it Lands online is "unknown" and winners are not named by Land | none     |
| `PORT`         | The page's port                                                                | 8790     |

```bash
NODE_RPC_URL=http://localhost:9445 HUB_URL=http://localhost:8787 pnpm --filter @linked-realms/dashboard start
```

A winner is named by Land when its reward address is a Land owner's: a Land's Mine pays its owner.
