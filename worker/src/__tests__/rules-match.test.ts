import { describe, expect, it } from "vitest";
import {
  matchCondition,
  matchConditions,
  type RuleMessage,
} from "../lib/rules/match";
import type { RuleCondition } from "../lib/rules/types";

const base: RuleMessage = {
  fromAddress: "Alice@Example.COM",
  subject: "Quarterly Invoice Ready",
  bodyText: "Hello Team, payment is due Friday.",
  bodyHtml: "<p>ignored while bodyText exists</p>",
  hasAttachments: true,
  spamScore: 6.5,
  headers: {
    "X-Customer-Tier": "Enterprise",
    "X-Trace": "ABC-123",
  },
};

describe("rule condition matching", () => {
  it.each([
    [
      { field: "from_address", operator: "equals", value: "alice@example.com" },
      true,
    ],
    [{ field: "from_address", operator: "contains", value: "EXAMPLE" }, true],
    [{ field: "from_address", operator: "ends_with", value: ".com" }, true],
    [{ field: "from_domain", operator: "equals", value: "example.com" }, true],
    [{ field: "subject", operator: "contains", value: "INVOICE" }, true],
    [{ field: "subject", operator: "starts_with", value: "quarterly" }, true],
    [
      {
        field: "subject",
        operator: "equals",
        value: "Quarterly Invoice Ready",
      },
      true,
    ],
    [{ field: "body", operator: "contains", value: "DUE friday" }, true],
    [{ field: "has_attachments", operator: "is", value: true }, true],
    [{ field: "spam_score", operator: "gte", value: 6 }, true],
    [{ field: "spam_score", operator: "lte", value: 6 }, false],
    [
      {
        field: "header",
        name: "x-customer-tier",
        operator: "equals",
        value: "enterprise",
      },
      true,
    ],
    [
      {
        field: "header",
        name: "X-TRACE",
        operator: "contains",
        value: "abc",
      },
      true,
    ],
  ] as Array<[RuleCondition, boolean]>)(
    "matches %j => %s",
    (condition, expected) => {
      expect(matchCondition(condition, base)).toBe(expected);
    },
  );

  it.each([null, "", "   "])(
    "uses HTML text when bodyText is %j",
    (bodyText) => {
      const message = {
        ...base,
        bodyText,
        bodyHtml: "<div>Hello <strong>World</strong> &amp; friends</div>",
      };
      expect(
        matchCondition(
          { field: "body", operator: "contains", value: "world & friends" },
          message,
        ),
      ).toBe(true);
    },
  );

  it("does not match null spam scores", () => {
    expect(
      matchCondition(
        { field: "spam_score", operator: "lte", value: 100 },
        { ...base, spamScore: null },
      ),
    ).toBe(false);
  });

  it("ANDs all conditions", () => {
    const result = matchConditions(
      [
        { field: "from_domain", operator: "equals", value: "example.com" },
        { field: "subject", operator: "contains", value: "missing" },
      ],
      base,
    );
    expect(result.matched).toBe(false);
    expect(result.conditionResults.map((entry) => entry.matched)).toEqual([
      true,
      false,
    ]);
  });
});
