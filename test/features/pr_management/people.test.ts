import { describe, expect, it } from "vitest";
import { PR_USERS, testPeople } from "../../helpers/pr";

describe("People", () => {
  const people = testPeople();

  it("labels mapped logins with a mention and others by login", () => {
    expect(people.label("Bob")).toBe("<@UBOB>");
    expect(people.label("outsider")).toBe("outsider");
  });

  it("tags owners, falling back to the triager for unmapped ones, deduped", () => {
    expect(people.tags(["bob", "outsider", "stranger", "dan"])).toEqual(["<@UBOB>", "<@UDAN>"]);
    expect(people.tags([])).toEqual([]);
  });

  it("tags nobody for unmapped owners when the triager is unmapped too", () => {
    const withoutTriager = testPeople("ghost-triager", PR_USERS);
    expect(withoutTriager.tags(["outsider", "carol"])).toEqual(["<@UCAROL>"]);
  });
});
