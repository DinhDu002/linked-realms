// Load-test host: a stub Hub plus a stub Map server linked to the relay as one Land. It echoes
// every Player message and broadcasts a 100-byte message to every Player at 20 Hz, without
// Colyseus, so the load test measures the relay (and the agent) rather than a game server.
//
//   HUB_PORT=8799 RELAY_URL=http://127.0.0.1:8080 LAND_ID=1 node scripts/load-host.ts
// then start the relay with HUB_URL=http://127.0.0.1:8799.
import { createServer } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WebSocketServer } from "ws";
import { connectHost } from "../src/agent.ts";

const landId = Number(process.env.LAND_ID ?? 1);
const hubPort = Number(process.env.HUB_PORT ?? 8799);
const relayUrl = process.env.RELAY_URL ?? "http://127.0.0.1:8080";
const BROADCAST_HZ = 20;
const BROADCAST_BYTES = 100;

const privateKey = generatePrivateKey(); // random per run, never printed
const miningKey = privateKeyToAccount(privateKey).address;

// Stub Hub: only the Directory entry of this Land.
createServer((req, res) => {
  if (req.url !== `/directory/${landId}`) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      landId,
      owner: miningKey,
      x: 0,
      y: 0,
      miningKey,
      online: true,
    }),
  );
}).listen(hubPort, () => console.log(`stub Hub on :${hubPort}`));

// Stub Map server on a free local port.
const local = createServer();
const wss = new WebSocketServer({ server: local, perMessageDeflate: false });
wss.on("connection", (ws) =>
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary })),
);
const broadcast = "b|".padEnd(BROADCAST_BYTES, "x");
setInterval(() => {
  for (const ws of wss.clients) ws.send(broadcast);
}, 1000 / BROADCAST_HZ);
setInterval(() => console.log(`players: ${wss.clients.size}`), 5000);

local.listen(0, "127.0.0.1", () => {
  const address = local.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  const link = connectHost({
    relayUrl,
    landId,
    privateKey,
    localPort: address.port,
    log: console.log,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void link.close().then(() => process.exit(0)));
});
