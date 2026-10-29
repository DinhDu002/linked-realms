import init from "../pkg/linked_realms_core.js";

/** Resolves once the WebAssembly module is loaded. Await it before using anything else. */
export const ready: Promise<void> = init().then(() => undefined);

export * from "./api.ts";
