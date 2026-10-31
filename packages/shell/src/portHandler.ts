// What the Shell does with a message from a Land UI on the MessageChannel port
// (docs/protocols/shell-land-ui.md). The Shell listens to nothing else, so messages from other
// windows or origins never reach it. Every check and limit is here; the window is not.
import { DIRECTIONS, type Direction } from "@linked-realms/shared";
import {
  MESSAGE_MAX_CODE_POINTS,
  type SignedStatement,
  type StatementFields,
} from "@linked-realms/shared/identity";
import { readTransfer, type Payment, type SendForm } from "./gold.ts";
import { LockedError } from "./vault.ts";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_ID_LENGTH = 64;
export const TRAVEL_MIN_INTERVAL_MS = 1000;
export const REFUSAL_COOLDOWN_MS = 10_000;
export const MAX_REFUSALS = 3;

export type TravelRefusedReason =
  "no-land" | "offline" | "locked" | "busy" | "rate-limited" | "error";

export type TravelOutcome =
  { ok: true } | { ok: false; reason: TravelRefusedReason; landId?: number };

/** What the Player sees in the signing prompt; the Shell wrote every part of it but `text`. */
export interface SignRequest {
  landId: number;
  origin: string;
  character: { address: string; name: string };
  text: string;
}

/** What the Player sees in the payment prompt: the Shell's own lines about a Land's `pay`. */
export interface PayRequest {
  landId: number;
  origin: string;
  payment: Payment;
}

/** What the Player did with the signing prompt; `busy` when another Land's prompt is open. */
export type SignAnswer = "approved" | "denied" | "busy";

export interface PortDeps {
  now(): number;
  /** The Land in the frame: its id and its URL's origin. */
  land: { landId: number; origin: string };
  character(): { address: string; name: string };
  send(message: unknown): void;
  /**
   * Carries the Character through a Gate, loading the neighbour's frame. It asks for the password
   * only through `unlock`, which carries this Land's limits.
   */
  travel(
    direction: Direction,
    unlock: () => Promise<boolean>,
  ): Promise<TravelOutcome>;
  isUnlocked(): boolean;
  /** Asks for the password in the Shell's own modal; false when the Player cancels. */
  ensureUnlocked(): Promise<boolean>;
  /** False once this frame load has ended: a request still waiting then opens no prompt. */
  isCurrent(): boolean;
  /** True while a dialog of the Shell is open: a prompt for any Land, the Player's own Send. */
  dialogOpen(): boolean;
  /** Shows the signing prompt. */
  confirm(request: SignRequest): Promise<SignAnswer>;
  /** Signs the statement; throws LockedError if the Shell locked meanwhile. */
  sign(fields: StatementFields<"land-message">): SignedStatement;
  /**
   * Checks a payment against the Character's account and the Node, and prices it; throws when it
   * cannot be made, after telling the Player why in the Shell's own bar.
   */
  preparePayment(form: SendForm): Promise<Payment>;
  /** Shows the payment prompt. */
  confirmPayment(request: PayRequest): Promise<SignAnswer>;
  /**
   * Signs and sends the payment; its transaction id, also when the Node's answer was lost. Throws
   * LockedError if the Shell locked meanwhile, and the Node's refusal.
   */
  sendPayment(payment: Payment): Promise<string>;
}

/** The message's JSON form, or undefined when it cannot be serialised or is over 64 KiB. */
function readMessage(data: unknown): Record<string, unknown> | undefined {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return undefined;
  }
  if (
    json === undefined ||
    json.length > MAX_MESSAGE_BYTES ||
    new TextEncoder().encode(json).length > MAX_MESSAGE_BYTES
  )
    return undefined;
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : undefined;
}

/** One handler per frame load: the limits start again when the Land is reloaded. */
export function createPortHandler(deps: PortDeps) {
  let lastTravelAt = -Infinity;
  let travelling = false;
  /** A `signMessage` or a `pay` is open: one at a time. */
  let signOpen = false;
  let refusals = 0;
  let lastRefusalAt = -Infinity;

  const signResult = (id: string, result: object) =>
    deps.send({ type: "signResult", id, ...result });

  const refuse = () => {
    refusals++;
    lastRefusalAt = deps.now();
  };
  const coolingDown = () =>
    refusals >= MAX_REFUSALS ||
    deps.now() - lastRefusalAt < REFUSAL_COOLDOWN_MS;

  /**
   * The password prompt on this Land's behalf. A cancel counts as a refusal, so a Land cannot
   * keep reopening the prompt: while it cools down, or once it is blocked, the answer is no.
   */
  async function unlock(): Promise<boolean> {
    if (deps.isUnlocked()) return true;
    if (coolingDown()) return false;
    if (await deps.ensureUnlocked()) return true;
    refuse();
    return false;
  }

  async function travel(direction: Direction) {
    const now = deps.now();
    const refuseTravel = (reason: TravelRefusedReason, landId?: number) =>
      deps.send({
        type: "travelRefused",
        direction,
        reason,
        ...(landId === undefined ? {} : { landId }),
      });
    if (travelling) return refuseTravel("busy");
    if (now - lastTravelAt < TRAVEL_MIN_INTERVAL_MS)
      return refuseTravel("rate-limited");
    lastTravelAt = now;
    travelling = true;
    try {
      const outcome = await deps.travel(direction, unlock);
      if (!outcome.ok) refuseTravel(outcome.reason, outcome.landId);
    } catch {
      refuseTravel("error");
    } finally {
      travelling = false;
    }
  }

  async function signMessage(id: string, text: unknown) {
    if (
      typeof text !== "string" ||
      !text.isWellFormed() ||
      [...text].length > MESSAGE_MAX_CODE_POINTS
    )
      return signResult(id, { error: "invalid" });
    if (refusals >= MAX_REFUSALS) return signResult(id, { error: "blocked" });
    if (signOpen || coolingDown()) return signResult(id, { error: "busy" });
    signOpen = true;
    try {
      if (!(await unlock())) return signResult(id, { error: "locked" });
      if (!deps.isCurrent()) return;
      const character = deps.character();
      const answer = await deps.confirm({
        ...deps.land,
        character,
        text,
      });
      if (answer === "busy") return signResult(id, { error: "busy" });
      if (answer === "denied") {
        refuse();
        return signResult(id, { error: "denied" });
      }
      const signed = deps.sign({
        land: deps.land.landId,
        landUrl: deps.land.origin,
        character: character.address,
        issued: Math.floor(deps.now() / 1000),
        message: text,
      });
      signResult(id, { signed });
    } catch (e) {
      signResult(id, {
        error: e instanceof LockedError ? "locked" : "invalid",
      });
    } finally {
      signOpen = false;
    }
  }

  /**
   * A payment the Land asks for. The Land gets the transaction id the Shell sent, never the signed
   * bytes; it learns that the payment happened only from the chain.
   */
  async function pay(id: string, m: Record<string, unknown>) {
    const { amount, recipient, memo = "" } = m;
    if (
      typeof amount !== "string" ||
      typeof recipient !== "string" ||
      typeof memo !== "string" ||
      !memo.isWellFormed()
    )
      return signResult(id, { error: "invalid" });
    const form = { to: recipient, amount, memo, fee: "" };
    try {
      readTransfer(form);
    } catch {
      return signResult(id, { error: "invalid" });
    }
    if (refusals >= MAX_REFUSALS) return signResult(id, { error: "blocked" });
    if (signOpen || coolingDown()) return signResult(id, { error: "busy" });
    signOpen = true;
    try {
      if (!(await unlock())) return signResult(id, { error: "locked" });
      // Busy before any call to the Node, so a Land cannot keep the Shell calling it meanwhile.
      if (deps.dialogOpen()) return signResult(id, { error: "busy" });
      let payment: Payment;
      try {
        payment = await deps.preparePayment(form);
      } catch {
        // Counted like a refusal, so a Land cannot keep the Shell calling the Node for it.
        refuse();
        return signResult(id, { error: "failed" });
      }
      if (!deps.isCurrent()) return; // the Land left while the Node answered: no prompt
      const answer = await deps.confirmPayment({ ...deps.land, payment });
      if (answer === "busy") return signResult(id, { error: "busy" });
      if (answer === "denied") {
        refuse();
        return signResult(id, { error: "denied" });
      }
      signResult(id, { txId: await deps.sendPayment(payment) });
    } catch (e) {
      signResult(id, { error: e instanceof LockedError ? "locked" : "failed" });
    } finally {
      signOpen = false;
    }
  }

  return {
    /** Handles one message from the port; unknown or malformed ones are ignored. */
    async handle(data: unknown): Promise<void> {
      const m = readMessage(data);
      if (!m) return;
      if (m.type === "travel") {
        if (DIRECTIONS.includes(m.direction as Direction))
          await travel(m.direction as Direction);
        return;
      }
      if (m.type !== "signMessage" && m.type !== "pay") return;
      // Without a usable id there is nothing to answer.
      if (
        typeof m.id !== "string" ||
        m.id === "" ||
        m.id.length > MAX_ID_LENGTH
      )
        return;
      if (m.type === "pay") await pay(m.id, m);
      else await signMessage(m.id, m.text);
    },
  };
}

export type PortHandler = ReturnType<typeof createPortHandler>;
