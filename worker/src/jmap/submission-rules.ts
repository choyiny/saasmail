/** One To plus MAX_CC_ENTRIES (50) is the transactional 1:1 send (spec J4). */
export const MAX_SUBMISSION_RECIPIENTS = 51;

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
export type Envelope = { mailFrom: EnvelopeAddress; rcptTo: EnvelopeAddress[] };

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

/** The deduplicated, lowercased To ∪ Cc of a content row. */
export function submissionRecipients(content: RecipientColumns): string[] {
  return uniqueLower(
    [...addresses(content.toJson), ...addresses(content.ccJson)].map(
      (address) => address.email,
    ),
  );
}

/** Spec §3.2 steps 3–4. */
export function checkContentRecipients(
  content: RecipientColumns,
): SubmissionSetError | null {
  const to = addresses(content.toJson);
  const bcc = addresses(content.bccJson);
  const invalidProperties: string[] = [];
  if (to.length > 1) invalidProperties.push("to");
  if (bcc.length > 0) invalidProperties.push("bcc");
  if (invalidProperties.length > 0) {
    return {
      type: "invalidEmail",
      properties: invalidProperties,
      description:
        "saasmail sends to exactly one To address plus Cc, and does not support Bcc",
    };
  }
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

/**
 * Spec §3.2 step 5. A null/omitted envelope is derived (RFC 8621 §7): mailFrom
 * is the identity's address and rcptTo is To ∪ Cc. A supplied one must match
 * exactly and carry no SMTP parameters.
 */
export function resolveEnvelope(
  value: unknown,
  identityEmail: string,
  recipients: string[],
): { envelope: Envelope | null; error: SubmissionSetError | null } {
  const derived: Envelope = {
    mailFrom: { email: identityEmail, parameters: null },
    rcptTo: recipients.map((email) => ({ email, parameters: null })),
  };
  if (value === undefined || value === null) {
    return { envelope: derived, error: null };
  }
  const shapeError = {
    envelope: null,
    error: { type: "invalidProperties", properties: ["envelope"] },
  };
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
    return {
      envelope: null,
      error: {
        type: "forbiddenMailFrom",
        description: "mailFrom must be the identity's address",
      },
    };
  }
  const given = uniqueLower(
    (rcptTo as Record<string, unknown>[]).map((item) => item.email as string),
  );
  const expected = new Set(recipients);
  if (
    given.length !== expected.size ||
    !given.every((email) => expected.has(email))
  ) {
    return {
      envelope: null,
      error: {
        type: "invalidEmail",
        properties: ["to", "cc"],
        description: "rcptTo must equal the Email's To and Cc addresses",
      },
    };
  }
  const withParameters = [
    mailFrom,
    ...(rcptTo as Record<string, unknown>[]),
  ].some(
    (address) =>
      address.parameters !== undefined && address.parameters !== null,
  );
  if (withParameters) {
    return {
      envelope: null,
      error: {
        type: "invalidProperties",
        properties: ["envelope"],
        description: "SMTP parameters are not supported",
      },
    };
  }
  return { envelope: derived, error: null };
}
