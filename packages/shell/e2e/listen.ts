import { createServer, type RequestListener } from "node:http";

/**
 * Listens on both loopbacks: on macOS the system resolver maps `*.localhost` to `::1` only, and
 * `localhost` may be either.
 */
export async function listenOnLoopbacks(
  handler: RequestListener,
  port: number,
): Promise<() => void> {
  const servers = ["127.0.0.1", "::1"].map((host) => {
    const server = createServer(handler);
    return new Promise<() => void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(() => server.close()));
    });
  });
  const closers = await Promise.all(servers);
  return () => closers.forEach((close) => close());
}
