import { describe, expect, it } from "vitest";
import { requireSecret } from "../../src/core/env";

describe("requireSecret", () => {
  it("returns a set secret", () => {
    expect(requireSecret({ TOKEN: "xoxb-1" }, "TOKEN")).toBe("xoxb-1");
  });

  it.each([{}, { TOKEN: "" }, { TOKEN: "   " }, { TOKEN: 42 }])("throws with setup instructions for %j", (env) => {
    expect(() => requireSecret(env, "TOKEN")).toThrow("Missing secret TOKEN. Set it with: wrangler secret put TOKEN");
  });
});
