import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPool } from "./db.ts";

describe("createPool", () => {
  it("handles idle-client errors: an unhandled pool 'error' event would crash the process", () => {
    const on = vi.spyOn(pg.Pool.prototype, "on");
    const logs: string[] = [];
    createPool("postgres://u:secret-pw@127.0.0.1:1/x", (m) => logs.push(m));
    const call = on.mock.calls.find(([event]) => event === "error");
    expect(call).toBeDefined();
    (call?.[1] as (e: Error) => void)(
      new Error("terminating connection postgres://u:secret-pw@h/x"),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("secret-pw");
    on.mockRestore();
  });
});
