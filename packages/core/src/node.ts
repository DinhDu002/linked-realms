import { readFileSync } from "node:fs";
import { initSync } from "../pkg/linked_realms_core.js";

initSync({
  module: readFileSync(
    new URL("../pkg/linked_realms_core_bg.wasm", import.meta.url),
  ),
});

/** Resolves once the WebAssembly module is loaded; already loaded in Node. */
export const ready: Promise<void> = Promise.resolve();

export * from "./api.ts";
