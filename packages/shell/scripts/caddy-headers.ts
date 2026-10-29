// Prints the Shell's response headers (src/headers.ts) as a Caddy `header` block, so the image
// sends exactly what `vite preview` and the browser tests use. Run with the build's VITE_HUB_URL.
import { shellHeaders } from "../src/headers.ts";

const hubUrl = process.env.VITE_HUB_URL || "http://localhost:8787";
const lines = Object.entries(shellHeaders(hubUrl)).map(([name, value]) => {
  if (value.includes('"')) throw new Error(`${name} cannot hold a quote`);
  return `\t${name} "${value}"`;
});
console.log(["header {", ...lines, "}"].join("\n"));
