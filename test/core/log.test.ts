import { describe, expect, it } from "vitest";
import { createConsoleLogger } from "../../src/core/log";

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { lines, sink: (line: string) => lines.push(JSON.parse(line)) };
}

describe("createConsoleLogger", () => {
  it("writes one JSON line per call with level, message and fields", () => {
    const { lines, sink } = capture();
    const log = createConsoleLogger({ env: "test" }, sink);
    log.debug("d");
    log.info("hello", { pr: 42 });
    log.warn("w");
    log.error("e");
    expect(lines).toEqual([
      { level: "debug", msg: "d", env: "test" },
      { level: "info", msg: "hello", env: "test", pr: 42 },
      { level: "warn", msg: "w", env: "test" },
      { level: "error", msg: "e", env: "test" },
    ]);
  });

  it("merges child fields over the parent's", () => {
    const { lines, sink } = capture();
    createConsoleLogger({ env: "test", feature: "a" }, sink).child({ feature: "b" }).info("x");
    expect(lines[0]).toEqual({ level: "info", msg: "x", env: "test", feature: "b" });
  });

  it("serializes errors with name, message and stack", () => {
    const { lines, sink } = capture();
    createConsoleLogger({}, sink).error("boom", { error: new TypeError("bad") });
    expect(lines[0]?.error).toMatchObject({ name: "TypeError", message: "bad", stack: expect.any(String) });
  });

  it("never throws on unserializable fields", () => {
    const { lines, sink } = capture();
    createConsoleLogger({}, sink).error("x", { n: 1n });
    expect(lines[0]).toMatchObject({ level: "error", msg: "x", logError: expect.any(String) });
  });

  it("doesn't let fields overwrite the level or message", () => {
    const { lines, sink } = capture();
    createConsoleLogger({ msg: "base" }, sink).warn("real", { level: "info", msg: "field" });
    expect(lines[0]).toMatchObject({ level: "warn", msg: "real" });
  });
});
