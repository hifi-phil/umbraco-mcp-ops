import { describe, expect, it } from "vitest";
import { closingIssues } from "./closing-refs";

describe("closingIssues — the issues a PR's description closes", () => {
  it("every GitHub closing keyword, any case, with or without a colon", () => {
    const body = "Closes #1\nfixes #2, Resolved: #3\nCLOSE #4 and fix #5\nresolves #6 / fixed #7 / closed #8 / resolve #9";
    expect(closingIssues(body).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("each issue once, however often it's named", () => {
    expect(closingIssues("Closes #12. Also fixes #12.")).toEqual([12]);
  });

  it("not a mention without a keyword, another repo's issue, or a keyword inside a word", () => {
    expect(closingIssues("See #12, related to #13")).toEqual([]);
    expect(closingIssues("Closes umbraco/Umbraco-CMS#14")).toEqual([]);
    expect(closingIssues("prefixes #15, disclosed #16")).toEqual([]);
  });

  it("an empty or missing description -> none", () => {
    expect(closingIssues("")).toEqual([]);
    expect(closingIssues(null)).toEqual([]);
    expect(closingIssues(undefined)).toEqual([]);
  });
});
