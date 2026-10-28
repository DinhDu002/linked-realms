import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  outputs,
  renderEmptyLand,
  renderRulesSol,
  renderSpiralVectors,
} from "./index.ts";

// Fails when someone edits the rules without running `pnpm --filter @linked-realms/shared generate`.
describe("generated artefacts are up to date", () => {
  it("contracts/src/generated/Rules.sol", () => {
    expect(readFileSync(outputs.rulesSol, "utf8")).toBe(renderRulesSol());
  });

  it("test-vectors/spiral.json", () => {
    expect(readFileSync(outputs.spiralVectors, "utf8")).toBe(
      renderSpiralVectors(),
    );
  });

  it("maps/empty-land.json", () => {
    expect(readFileSync(outputs.emptyLand, "utf8")).toBe(renderEmptyLand());
  });
});
