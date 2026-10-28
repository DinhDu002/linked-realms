import { mkdirSync, writeFileSync } from "node:fs";
import {
  outputs,
  renderEmptyLand,
  renderMiningVectors,
  renderRulesSol,
  renderSpiralVectors,
} from "../src/codegen/index.ts";

const files: Array<[URL, string]> = [
  [outputs.rulesSol, renderRulesSol()],
  [outputs.spiralVectors, renderSpiralVectors()],
  [outputs.emptyLand, renderEmptyLand()],
  [outputs.miningVectors, renderMiningVectors()],
];
for (const [url, content] of files) {
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, content);
  console.log(`wrote ${url.pathname}`);
}
