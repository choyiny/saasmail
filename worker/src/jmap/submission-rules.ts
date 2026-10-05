import { MAX_RECIPIENTS, MAX_SEND_ATTACHMENTS } from "../lib/send-limits";
import { MAX_DELAYED_SEND } from "./constants";
import { parseJmapDate } from "./dates";

/** To, Cc and Bcc together, within the provider's per-message recipient cap. */
export const MAX_SUBMISSION_RECIPIENTS = MAX_RECIPIENTS;

/** An RFC 8621 §7.5 SetError, with every extra field this server uses. */
export type SubmissionSetError = {
  type: string;
  description?: string;
  properties?: string[];
  maxRecipients?: number;
  invalidRecipients?: string[];
  maxSize?: number;
};

export type EnvelopeAddress = { email: string; parameters: null };
/** mailFrom may carry one RFC 4865 parameter: HOLDFOR or HOLDUNTIL. */
export type Envelope = {
  mailFrom: { email: string; parameters: Record<string, string> | null };
  rcptTo: EnvelopeAddress[];
};

type Address = { name: string | null; email: string };
type RecipientColumns = { toJson: string; ccJson: string; bccJson: string };

/**
 * A conservative "is this deliverable" test: no whitespace, no RFC 5322
 * specials anywhere, and a dotted domain. Deliberately stricter than RFC 5321
 * (quoted local parts and address literals are refused) — a JMAP client that
 * needs them can be told the address is not supported.
 */
const SENDABLE =
  /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(\.[^\s@<>()[\]\\,;:".]+)+$/;

export function isSendableAddress(email: string): boolean {
  return SENDABLE.test(email);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addresses(json: string): Address[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as Address[]) : [];
}

function uniqueLower(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))];
}

/** The deduplicated, lowercased To ∪ Cc ∪ Bcc of a content row: the envelope. */
export function submissionRecipients(content: RecipientColumns): string[] {
  return uniqueLower(
    [
      ...addresses(content.toJson),
      ...addresses(content.ccJson),
      ...addresses(content.bccJson),
    ].map((address) => address.email),
  );
}

/**
 * Several To addresses and Bcc are sent only through a provider that delivers
 * them (EmailSender.recipientSupport); refusing beats dropping recipients.
 */
export function checkRecipientSupport(
  content: RecipientColumns,
  support: { multipleTo: boolean; bcc: boolean },
): SubmissionSetError | null {
  if (addresses(content.toJson).length > 1 && !support.multipleTo) {
    return {
      type: "invalidEmail",
      properties: ["to"],
      description: "The configured email provider sends to one To address only",
    };
  }
  if (addresses(content.bccJson).length > 0 && !support.bcc) {
    return {
      type: "invalidEmail",
      properties: ["bcc"],
      description: "The configured email provider can't send Bcc",
    };
  }
  return null;
}

/** Spec §3.2 steps 3–4. */
export function checkContentRecipients(
  content: RecipientColumns,
): SubmissionSetError | null {
  const to = addresses(content.toJson);
  if (to.length === 0) {
    return { type: "noRecipients", description: "The Email has no To address" };
  }
  const recipients = submissionRecipients(content);
  const invalid = recipients.filter((email) => !isSendableAddress(email));
  if (invalid.length > 0) {
    return {
      type: "invalidRecipients",
      invalidRecipients: invalid,
      description: "Some recipients are not valid email addresses",
    };
  }
  if (recipients.length > MAX_SUBMISSION_RECIPIENTS) {
    return {
      type: "tooManyRecipients",
      maxRecipients: MAX_SUBMISSION_RECIPIENTS,
    };
  }
  return null;
}

type EnvelopeResult = {
  envelope: Envelope | null;
  error: SubmissionSetError | null;
  /** Epoch seconds the send is held until (RFC 4865); null sends now. */
  releaseAt: number | null;
};

function envelopeError(error: SubmissionSetError): EnvelopeResult {
  return { envelope: null, error, releaseAt: null };
}

const HOLD_FOR = /^[0-9]{1,9}$/;

/**
 * RFC 4865 FUTURERELEASE on `mailFrom.parameters`: exactly one of
 * `HOLDFOR=<seconds>` or `HOLDUNTIL=<RFC 3339 date-time>`, at most
 * MAX_DELAYED_SEND ahead. A hold that is already over (HOLDFOR=0, a past
 * HOLDUNTIL) releases the message now. Parameter names are case-insensitive,
 * as in SMTP; any other parameter is refused.
 */
function parseFutureRelease(
  value: unknown,
  now: number,
): {
  parameters: Record<string, string> | null;
  releaseAt: number | null;
  error: SubmissionSetError | null;
} {
  if (value === undefined || value === null) {
    return { parameters: null, releaseAt: null, error: null };
  }
  const invalid = (description: string) => ({
    parameters: null,
    releaseAt: null,
    error: {
      type: "invalidProperties",
      properties: ["envelope"],
      description,
    },
  });
  if (!isObject(value)) return invalid("parameters must be an object");
  const entries = Object.entries(value);
  if (
    entries.length !== 1 ||
    !["HOLDFOR", "HOLDUNTIL"].includes(entries[0][0].toUpperCase())
  ) {
    return invalid(
      "The only SMTP parameter supported is one FUTURERELEASE parameter on mailFrom: HOLDFOR or HOLDUNTIL",
    );
  }
  const [rawName, rawValue] = entries[0];
  const name = rawName.toUpperCase();
  if (typeof rawValue !== "string") {
    return invalid(`${name} needs a value`);
  }
  let releaseAt: number;
  if (name === "HOLDFOR") {
    if (!HOLD_FOR.test(rawValue)) {
      return invalid("HOLDFOR must be a number of seconds");
    }
    releaseAt = now + Number(rawValue);
  } else {
    const millis = parseJmapDate(rawValue);
    if (millis === null) {
      return invalid("HOLDUNTIL must be an RFC 3339 date-time");
    }
    releaseAt = Math.ceil(millis / 1000);
  }
  if (releaseAt - now > MAX_DELAYED_SEND) {
    return invalid(
      `A send can be held for at most ${MAX_DELAYED_SEND} seconds (maxDelayedSend)`,
    );
  }
  return {
    parameters: { [name]: rawValue },
    releaseAt: releaseAt > now ? releaseAt : null,
    error: null,
  };
}

/**
 * Spec §3.2 step 5. A null/omitted envelope is derived (RFC 8621 §7): mailFrom
 * is the identity's address and rcptTo is To ∪ Cc. A supplied one must match
 * exactly; its only SMTP parameter may be a FUTURERELEASE hold on mailFrom.
 */
export function resolveEnvelope(
  value: unknown,
  identityEmail: string,
  recipients: string[],
  now: number = Math.floor(Date.now() / 1000),
): EnvelopeResult {
  const derived: Envelope = {
    mailFrom: { email: identityEmail, parameters: null },
    rcptTo: recipients.map((email) => ({ email, parameters: null })),
  };
  if (value === undefined || value === null) {
    return { envelope: derived, error: null, releaseAt: null };
  }
  const shapeError = envelopeError({
    type: "invalidProperties",
    properties: ["envelope"],
  });
  if (
    !isObject(value) ||
    !isObject(value.mailFrom) ||
    !Array.isArray(value.rcptTo)
  ) {
    return shapeError;
  }
  const mailFrom = value.mailFrom;
  const rcptTo = value.rcptTo as unknown[];
  if (
    typeof mailFrom.email !== "string" ||
    !rcptTo.every((item) => isObject(item) && typeof item.email === "string")
  ) {
    return shapeError;
  }
  if (mailFrom.email.trim().toLowerCase() !== identityEmail) {
    return envelopeError({
      type: "forbiddenMailFrom",
      description: "mailFrom must be the identity's address",
    });
  }
  const given = uniqueLower(
    (rcptTo as Record<string, unknown>[]).map((item) => item.email as string),
  );
  const expected = new Set(recipients);
  if (
    given.length !== expected.size ||
    !given.every((email) => expected.has(email))
  ) {
    return envelopeError({
      type: "invalidEmail",
      properties: ["to", "cc", "bcc"],
      description: "rcptTo must equal the Email's To, Cc and Bcc addresses",
    });
  }
  const rcptParameters = (rcptTo as Record<string, unknown>[]).some(
    (address) =>
      address.parameters !== undefined && address.parameters !== null,
  );
  if (rcptParameters) {
    return envelopeError({
      type: "invalidProperties",
      properties: ["envelope"],
      description: "SMTP parameters are not supported on rcptTo",
    });
  }
  const hold = parseFutureRelease(mailFrom.parameters, now);
  if (hold.error) return envelopeError(hold.error);
  return {
    envelope: {
      ...derived,
      mailFrom: { email: identityEmail, parameters: hold.parameters },
    },
    error: null,
    releaseAt: hold.releaseAt,
  };
}

/** Every stored part goes out as an attachment, inline or not. */
export function checkAttachmentCount(count: number): SubmissionSetError | null {
  if (count <= MAX_SEND_ATTACHMENTS) return null;
  return {
    type: "invalidEmail",
    properties: ["attachments"],
    description: `A message can carry at most ${MAX_SEND_ATTACHMENTS} attachments, inline images included; this one has ${count}`,
  };
}
