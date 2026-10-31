// The network address a request comes from, for per-network limits (PLAN.md section 5.1).
import { BlockList, isIP } from "node:net";

/** An IPv4-mapped IPv6 address (how a dual-stack socket reports IPv4 peers) as plain IPv4. */
function normalize(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return mapped ? mapped[1]! : ip.trim();
}

const family = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");

/** Parses `HUB_TRUSTED_PROXIES`: comma-separated IPs or CIDRs. Throws on anything else. */
export function trustedProxies(list: string[]): BlockList {
  const blocks = new BlockList();
  for (const entry of list) {
    const [ip = "", prefix] = entry.split("/");
    const bits = isIP(ip) === 4 ? 32 : isIP(ip) === 6 ? 128 : 0;
    if (bits === 0) throw new Error(`HUB_TRUSTED_PROXIES: "${entry}"`);
    if (prefix === undefined) blocks.addAddress(ip, family(ip));
    else if (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits)
      blocks.addSubnet(ip, Number(prefix), family(ip));
    else throw new Error(`HUB_TRUSTED_PROXIES: "${entry}"`);
  }
  return blocks;
}

/**
 * The client's address: the socket's peer, unless that peer is a trusted proxy. Then it is the
 * rightmost `X-Forwarded-For` entry that is not a trusted proxy, since only those entries were
 * written by a proxy we trust; anything to their left is whatever the client sent.
 */
export function clientAddressOf(
  trusted: BlockList,
  peer: string,
  forwardedFor: string | undefined,
): string {
  const isTrusted = (ip: string) =>
    isIP(ip) !== 0 && trusted.check(ip, family(ip));
  let client = normalize(peer);
  const entries = (forwardedFor ?? "").split(",").map(normalize);
  for (const entry of entries.filter(Boolean).reverse()) {
    if (!isTrusted(client)) return client;
    client = entry;
  }
  return client;
}

/** The network a limit counts: an IPv4 address, or the /64 of an IPv6 address. */
export function networkOf(address: string): string {
  const ip = normalize(address).replace(/%.*$/, "");
  if (isIP(ip) !== 6) return ip;
  // An embedded IPv4 tail is two groups; only the first four groups matter here.
  const groups = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  const [head = "", tail] = ip.split("::");
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return `${all
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}
