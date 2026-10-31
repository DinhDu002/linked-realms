// The Land's frame and its connection to the Shell (docs/protocols/shell-land-ui.md): one iframe,
// whose `src` is a Directory URL; on every `load` a fresh handoff, a new MessageChannel and `init`.
import type { LandInfo } from "@linked-realms/shared";
import type { Handoff } from "@linked-realms/shared/identity";
import type { PortHandler } from "./portHandler.ts";

/** A Land that reloads faster than this is stopped. */
export const RELOAD_MIN_INTERVAL_MS = 5000;
/** A handoff made for a travel is used for the first load only while it is this fresh (tickets live 60 s). */
export const PREPARED_MAX_AGE_MS = 30_000;

export interface FrameHostDeps {
  area: HTMLElement;
  prepare(land: LandInfo, from?: number): Promise<Handoff>;
  character(): { address: string; name: string };
  /**
   * Builds the handler for one frame load; `send` posts on that load's port, and `isCurrent` is
   * true until that port closes (a reload, Leave or another Land).
   */
  makeHandler(
    land: LandInfo,
    send: (message: unknown) => void,
    isCurrent: () => boolean,
  ): PortHandler;
  /** Called whenever a load's port closes, so a prompt it opened can be closed too. */
  onPortClosed(): void;
  /** Tells the Player why there is no connection (with a way to retry), or clears the notice. */
  notice(text: string | undefined, retry?: () => void): void;
  now?: () => number;
}

export interface OpenOptions {
  /** The Land the Character comes from: set only for the load that a `travel` caused. */
  from?: number;
  /** A handoff for `land` made at `at` (Unix ms), used for the first load if still fresh. */
  prepared?: { handoff: Handoff; at: number };
}

export function createFrameHost({
  area,
  prepare,
  character,
  makeHandler,
  onPortClosed,
  notice,
  now = Date.now,
}: FrameHostDeps) {
  let current: { land: LandInfo; iframe: HTMLIFrameElement } | undefined;
  let frozen = false;
  let closePort: (() => void) | undefined;

  const freeze = () => {
    area.inert = frozen;
    area.classList.toggle("frozen", frozen);
    if (current) current.iframe.inert = frozen;
  };

  function close() {
    closePort?.();
    closePort = undefined;
    current?.iframe.remove();
    current = undefined;
  }

  function open(land: LandInfo, options: OpenOptions = {}) {
    close();
    notice(undefined);
    const origin = new URL(land.url).origin;
    if (!/^https?:\/\//.test(origin)) throw new Error("not a web URL");

    const iframe = document.createElement("iframe");
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-pointer-lock",
    );
    iframe.setAttribute("allow", "");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.title = `Land ${land.landId}`;
    const mine = { land, iframe };
    current = mine;
    let from = options.from;
    let prepared = options.prepared;
    let lastLoadAt: number | undefined;
    let loads = 0;

    iframe.addEventListener("load", async () => {
      const load = ++loads;
      const at = now();
      if (
        lastLoadAt !== undefined &&
        at - lastLoadAt < RELOAD_MIN_INTERVAL_MS
      ) {
        close();
        notice("This Land keeps reloading");
        return;
      }
      lastLoadAt = at;
      closePort?.();
      const useFrom = from;
      const usePrepared = prepared;
      from = prepared = undefined; // only the load that a travel caused
      notice(undefined);
      try {
        const handoff =
          usePrepared && at - usePrepared.at < PREPARED_MAX_AGE_MS
            ? usePrepared.handoff
            : await prepare(land, useFrom);
        if (current !== mine || load !== loads) return; // reloaded or left meanwhile
        const { port1, port2 } = new MessageChannel();
        let live = true;
        const handler = makeHandler(
          land,
          (m) => port1.postMessage(m),
          () => live,
        );
        port1.onmessage = (e) => void handler.handle(e.data);
        closePort = () => {
          live = false;
          port1.close();
          onPortClosed();
        };
        iframe.contentWindow?.postMessage(
          { type: "linked-realms/connect", api: 1 },
          origin,
          [port2],
        );
        port1.postMessage({
          type: "init",
          land: {
            landId: land.landId,
            url: land.url,
            ownerName: land.ownerName,
          },
          character: character(),
          handoff,
        });
      } catch (e) {
        if (current === mine && load === loads)
          notice(e instanceof Error ? e.message : String(e), () =>
            open(land, { from: useFrom }),
          );
      }
    });

    // src before insertion: an iframe inserted without one fires a load for about:blank first.
    iframe.src = land.url;
    area.append(iframe);
    freeze();
  }

  return {
    open,
    close,
    get land() {
      return current?.land;
    },
    /** Freezes the frame (inert, no pointer events) while the Shell shows a prompt. */
    setFrozen(value: boolean) {
      frozen = value;
      freeze();
    },
  };
}

export type FrameHost = ReturnType<typeof createFrameHost>;
