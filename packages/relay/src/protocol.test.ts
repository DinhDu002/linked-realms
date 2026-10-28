import { describe, expect, it } from "vitest";
import {
  KIND_TEXT,
  ProtocolError,
  decodeFrame,
  encodeFrame,
  hostHelloMessage,
  isForwardPath,
  parseControl,
  sendableCloseCode,
} from "./protocol.ts";

describe("data frames", () => {
  it("round-trips stream id, kind and payload", () => {
    const frame = encodeFrame(0xfffffffe, KIND_TEXT, Buffer.from("hi"));
    expect(frame.subarray(0, 5)).toEqual(Buffer.from([255, 255, 255, 254, 1]));
    const decoded = decodeFrame(frame);
    expect(decoded.stream).toBe(0xfffffffe);
    expect(decoded.kind).toBe(KIND_TEXT);
    expect(decoded.payload.toString()).toBe("hi");
  });

  it("rejects short frames and unknown kinds", () => {
    expect(() => decodeFrame(Buffer.from([0, 0, 0, 1]))).toThrow(ProtocolError);
    expect(() => decodeFrame(Buffer.from([0, 0, 0, 1, 2]))).toThrow(
      "bad frame kind",
    );
  });
});

describe("parseControl", () => {
  const sig = `0x${"ab".repeat(65)}`;

  it("accepts every message type", () => {
    for (const m of [
      { t: "challenge", nonce: "abc123" },
      { t: "hello", signature: sig },
      { t: "ready" },
      {
        t: "http",
        id: 1,
        method: "POST",
        path: "/matchmake/x?a=1",
        headers: { accept: "a" },
        body: "",
      },
      {
        t: "http-response",
        id: 1,
        status: 200,
        headers: { "set-cookie": ["a", "b"] },
        body: "aGk=",
      },
      { t: "open", stream: 7, path: "/p/r?x=y" },
      { t: "close", stream: 7, code: 1000 },
    ])
      expect(parseControl(JSON.stringify(m))).toEqual(m);
  });

  it("rejects malformed input", () => {
    const bad = [
      "nope",
      "[]",
      '{"t":"unknown"}',
      '{"t":"open","stream":-1,"path":"/a"}',
      '{"t":"open","stream":1.5,"path":"/a"}',
      '{"t":"open","stream":1,"path":"a"}',
      '{"t":"open","stream":1,"path":"/a b"}',
      '{"t":"close","stream":1,"code":99999}',
      '{"t":"hello","signature":"0x12"}',
      '{"t":"challenge","nonce":"XYZ"}',
      '{"t":"http","id":1,"method":"get","path":"/","headers":{},"body":""}',
      '{"t":"http","id":1,"method":"GET","path":"/","headers":{"bad name":"x"},"body":""}',
      '{"t":"http","id":1,"method":"GET","path":"/","headers":{"a":1},"body":""}',
      '{"t":"http","id":1,"method":"GET","path":"/","headers":{},"body":"***"}',
      '{"t":"http-response","id":1,"status":700,"headers":{},"body":""}',
      '{"t":"http-response","id":1,"status":101,"headers":{},"body":""}',
    ];
    for (const raw of bad)
      expect(() => parseControl(raw), raw).toThrow(ProtocolError);
  });

  it("keeps a __proto__ header as plain data", () => {
    const m = parseControl(
      '{"t":"http-response","id":1,"status":200,"headers":{"__proto__":"x"},"body":""}',
    );
    expect(
      Object.getPrototypeOf(m.t === "http-response" ? m.headers : null),
    ).toBe(null);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

it("builds the host hello message", () => {
  expect(hostHelloMessage(7, "ff")).toBe(
    "linked-realms relay: host Land 7\nNonce: ff",
  );
});

it("checks forward paths", () => {
  expect(isForwardPath("/matchmake/joinOrCreate/land?a=1")).toBe(true);
  for (const p of ["", "x", "/a b", "/a\nb", "/é", `/${"a".repeat(2048)}`])
    expect(isForwardPath(p), p).toBe(false);
});

it("maps unsendable close codes to 1011", () => {
  expect(sendableCloseCode(1000)).toBe(1000);
  expect(sendableCloseCode(4409)).toBe(4409);
  for (const c of [1005, 1006, 1015, 0, 999, 5000])
    expect(sendableCloseCode(c)).toBe(1011);
});
