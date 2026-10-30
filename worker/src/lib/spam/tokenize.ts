import { trimQuotedText } from "../email-parser";
import { htmlToText } from "../html-to-text";

/** Tokens per message, looked up and trained. */
export const MAX_TOKENS = 150;
/** Characters of the body that are tokenized. */
const BODY_LIMIT = 3000;
/** Characters of HTML converted to text when there is no text body. */
const HTML_LIMIT = 32_000;

export interface TokenizableMessage {
  fromAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
}

// A leading currency sign belongs to the word: "$500" is a token.
const WORD = /[$€]?[\p{L}\p{N}][\p{L}\p{N}'$%€.-]*/gu;
const DIGITS_ONLY = /^[\d.,'-]+$/;

/** Lowercase words of 3–24 characters; plain numbers are dropped. */
function words(text: string): string[] {
  const found: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    // A word's trailing punctuation is not part of it ("today." → "today").
    const word = match[0].replace(/[.'-]+$/, "");
    if (word.length < 3 || word.length > 24) continue;
    if (DIGITS_ONLY.test(word)) continue;
    found.push(word);
  }
  return found;
}

/**
 * The distinct tokens of a message, in the order they appear, at most 150:
 * the sender (`f:` address, `d:` domain), `h:attachments`, subject words
 * (`s:`), then body words (the reply without its quoted tail, first 3,000
 * characters). Pure.
 */
export function tokenize(message: TokenizableMessage): string[] {
  const tokens = new Set<string>();
  const add = (token: string) => {
    if (tokens.size < MAX_TOKENS) tokens.add(token);
  };
  const from = message.fromAddress?.trim().toLowerCase();
  if (from) {
    add(`f:${from}`);
    const at = from.lastIndexOf("@");
    if (at !== -1) add(`d:${from.slice(at + 1)}`);
  }
  if (message.hasAttachments) add("h:attachments");
  for (const word of words(message.subject ?? "")) add(`s:${word}`);
  // HTML is cut before it is converted: the conversion is the costly part.
  const body = message.bodyText?.trim()
    ? message.bodyText
    : message.bodyHtml
      ? htmlToText(message.bodyHtml.slice(0, HTML_LIMIT))
      : "";
  for (const word of words(
    trimQuotedText(body.slice(0, BODY_LIMIT * 4)).slice(0, BODY_LIMIT),
  )) {
    add(word);
  }
  return [...tokens];
}
