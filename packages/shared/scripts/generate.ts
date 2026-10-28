import { mkdirSync, writeFileSync } from "node:fs";
import {
  outputs,
  renderEmptyLand,
  renderRulesSol,
  renderSpiralVectors,
} from "../src/codegen/index.ts";

const files: Array<[URL, string]> = [
  [outputs.rulesSol, renderRulesSol()],
  [outputs.spiralVectors, renderSpiralVectors()],
  [outputs.emptyLand, renderEmptyLand()],
];
for (const [url, content] of files) {
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, content);
  console.log(`wrote ${url.pathname}`);
}
