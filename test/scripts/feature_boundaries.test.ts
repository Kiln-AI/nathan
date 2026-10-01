import { describe, expect, it } from "vitest";
import { featureBoundaryViolations, importSpecifiers, resolveImport } from "../../scripts/lib/feature_boundaries";

const violations = (path: string, ...specifiers: string[]) =>
  featureBoundaryViolations([{ path, source: specifiers.map((s) => `import { x } from "${s}";`).join("\n") }]).map(
    (v) => v.specifier,
  );

describe("importSpecifiers", () => {
  it("finds static, type-only, re-export, side-effect, multi-line and dynamic imports", () => {
    const source = `
      import { a } from "./a";
      import type { B } from '../b';
      import {
        c,
        d,
      } from "./cd";
      export * from "./e";
      export { f } from "./f";
      import "./side-effect";
      const g = await import("./g");
      const notAnImport = "from './nope'";
    `;
    expect(importSpecifiers(source).sort()).toEqual(
      ["./a", "../b", "./cd", "./e", "./f", "./side-effect", "./g"].sort(),
    );
  });
});

describe("resolveImport", () => {
  it("resolves relative to the importing file and drops extensions and /index", () => {
    expect(resolveImport("src/features/x/sub/deep.ts", "../state")).toBe("src/features/x/state");
    expect(resolveImport("src/features/x/a.ts", "../../slack/index.ts")).toBe("src/slack");
    expect(resolveImport("src/features/x/a.ts", "./")).toBe("src/features/x");
  });
});

describe("featureBoundaryViolations", () => {
  it("allows a feature's own files from any depth", () => {
    expect(violations("src/features/x/sub/deep.ts", "../state", "./sibling", "../", "../sub2/y")).toEqual([]);
    expect(violations("src/features/x/index.ts", "./state", "./sub/deep")).toEqual([]);
  });

  it("allows src/core and the gateway entry points from any depth", () => {
    expect(violations("src/features/x/a.ts", "../../core/time", "../../slack", "../../github/index")).toEqual([]);
    expect(violations("src/features/x/sub/b.ts", "../../../core/jobs", "../../../slack/index.ts")).toEqual([]);
  });

  it("rejects other features from any depth or path shape", () => {
    expect(violations("src/features/x/a.ts", "../other", "../other/state")).toEqual(["../other", "../other/state"]);
    expect(violations("src/features/x/sub/deep.ts", "../../other_feature")).toEqual(["../../other_feature"]);
    expect(violations("src/features/x/index.ts", "../../features/other_feature")).toEqual([
      "../../features/other_feature",
    ]);
    expect(violations("src/features/x/a.ts", "../x_other/a")).toEqual(["../x_other/a"]);
  });

  it("rejects gateway internals and anything else outside the allowed areas", () => {
    expect(violations("src/features/x/a.ts", "../../slack/client", "../../github/auth", "../../index")).toEqual([
      "../../slack/client",
      "../../github/auth",
      "../../index",
    ]);
  });

  it("lets the feature registry import feature entry points and core", () => {
    expect(violations("src/features/index.ts", "./pr_management", "../core/feature")).toEqual([]);
    expect(violations("src/features/index.ts", "../slack/client")).toEqual(["../slack/client"]);
    expect(violations("src/features/index.ts", "./pr_management/state")).toEqual(["./pr_management/state"]);
  });

  it("ignores package imports and files outside src/features", () => {
    expect(violations("src/features/x/a.ts", "zod", "luxon")).toEqual([]);
    expect(violations("src/core/app.ts", "../features/x/internal")).toEqual([]);
  });
});
