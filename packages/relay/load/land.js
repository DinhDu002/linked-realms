/* global __ENV, console, setInterval, setTimeout, clearInterval -- k6 runtime globals */
// k6 load test for the relay (PLAN.md section 3.5 rule 8). Opens VUS Player WebSockets to a
// Land (`Host: <LAND>.<LAND_BASE_DOMAIN>`) linked by scripts/load-host.ts and exchanges about 20 messages per second each way:
// every Player sends a 100-byte message each 50 ms (the host echoes it, which gives the
// round-trip latency), and the host broadcasts 100 bytes to every Player at 20 Hz.
//
//   k6 run -e RELAY_WS=ws://host.docker.internal:8080 -e LAND=1 -e LAND_BASE_DOMAIN=localhost:8080 -e VUS=200 -e SECONDS=30 -e RAMP_SECONDS=10 land.js
import { WebSocket } from "k6/websockets";
import { Counter, Trend } from "k6/metrics";
import { sleep } from "k6";

const RELAY_WS = __ENV.RELAY_WS || "ws://127.0.0.1:8080";
const LAND = __ENV.LAND || "1";
// *.localhost does not resolve inside Docker, so connect to RELAY_WS and name the Land in Host.
const LAND_BASE_DOMAIN = __ENV.LAND_BASE_DOMAIN || "localhost:8080";
const VUS = Number(__ENV.VUS || 200);
const SECONDS = Number(__ENV.SECONDS || 30);
// Players join spread over this window: a burst of hundreds of connects overflows the listen
// backlog of the local Map server on macOS (somaxconn 128) and says nothing about the relay.
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 10);
const SEND_EVERY_MS = 50; // 20 messages per second
const PAYLOAD_BYTES = 100;

const sent = new Counter("relay_messages_sent");
const echoes = new Counter("relay_echoes_received");
const broadcasts = new Counter("relay_broadcasts_received");
const wsErrors = new Counter("relay_ws_errors");
const rtt = new Trend("relay_rtt_ms", true);

export const options = {
  scenarios: {
    players: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: `${RAMP_SECONDS + SECONDS + 60}s`,
    },
  },
  thresholds: {
    relay_rtt_ms: ["p(95)<500"],
    relay_ws_errors: ["count==0"],
  },
};

export default function () {
  sleep(Math.random() * RAMP_SECONDS);
  const ws = new WebSocket(`${RELAY_WS}/play`, null, {
    headers: { Host: `${LAND}.${LAND_BASE_DOMAIN}` },
  });
  ws.onopen = () => {
    const timer = setInterval(() => {
      ws.send(`e|${Date.now()}|`.padEnd(PAYLOAD_BYTES, "x"));
      sent.add(1);
    }, SEND_EVERY_MS);
    setTimeout(() => {
      clearInterval(timer);
      ws.close();
    }, SECONDS * 1000);
  };
  ws.onmessage = (event) => {
    const data = String(event.data);
    if (data.startsWith("e|")) {
      echoes.add(1);
      rtt.add(Date.now() - Number(data.split("|")[1]));
    } else broadcasts.add(1);
  };
  ws.onerror = (event) => {
    wsErrors.add(1);
    console.error(`ws error: ${event.error}`);
  };
}
