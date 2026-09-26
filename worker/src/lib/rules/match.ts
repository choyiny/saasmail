import { htmlToText } from "../html-to-text";
import type { RuleCondition } from "./types";

export type RuleMessage = {
  fromAddress: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
  spamScore: number | null;
  headers: Record<string, string>;
};

export type ConditionResult = {
  condition: RuleCondition;
  matched: boolean;
};

function folded(value: string): string {
  return value.toLowerCase();
}

function textMatches(
  actual: string,
  operator: "equals" | "contains" | "starts_with" | "ends_with",
  expected: string,
): boolean {
  const left = folded(actual);
  const right = folded(expected);
  if (operator === "equals") return left === right;
  if (operator === "contains") return left.includes(right);
  if (operator === "starts_with") return left.startsWith(right);
  return left.endsWith(right);
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = folded(name);
  for (const [key, value] of Object.entries(headers)) {
    if (folded(key) === target) return value;
  }
  return null;
}

export function matchCondition(
  condition: RuleCondition,
  message: RuleMessage,
): boolean {
  switch (condition.field) {
    case "from_address":
      return textMatches(
        message.fromAddress,
        condition.operator,
        condition.value,
      );
    case "from_domain": {
      const at = message.fromAddress.lastIndexOf("@");
      if (at === -1) return false;
      return textMatches(
        message.fromAddress.slice(at + 1),
        "equals",
        condition.value,
      );
    }
    case "subject":
      return textMatches(
        message.subject ?? "",
        condition.operator,
        condition.value,
      );
    case "body": {
      const body =
        message.bodyText !== null && message.bodyText.trim() !== ""
          ? message.bodyText
          : htmlToText(message.bodyHtml ?? "");
      return textMatches(body, "contains", condition.value);
    }
    case "has_attachments":
      return message.hasAttachments === condition.value;
    case "spam_score":
      if (message.spamScore === null) return false;
      return condition.operator === "gte"
        ? message.spamScore >= condition.value
        : message.spamScore <= condition.value;
    case "header": {
      const value = headerValue(message.headers, condition.name);
      return (
        value !== null &&
        textMatches(value, condition.operator, condition.value)
      );
    }
  }
}

export function matchConditions(
  conditions: RuleCondition[],
  message: RuleMessage,
): { matched: boolean; conditionResults: ConditionResult[] } {
  const conditionResults = conditions.map((condition) => ({
    condition,
    matched: matchCondition(condition, message),
  }));
  return {
    matched: conditionResults.every((result) => result.matched),
    conditionResults,
  };
}
