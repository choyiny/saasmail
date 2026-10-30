// Cloudflare Email Sending queue messages, from the examples on Cloudflare's
// "Events & schemas" page. `payload.messageId` is the id the send binding
// returned, angle brackets included, as a live bounce carries it.

const source = {
  type: "email.sending",
  zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
  domain: "saasmail.test",
};
const metadata = {
  accountId: "f9f79265f388666de8122cfb508d7776",
  eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
  eventSchemaVersion: 1,
  eventTimestamp: "2026-06-01T02:48:57.132Z",
};

export const EVENT_TIMESTAMP = Math.floor(
  Date.parse(metadata.eventTimestamp) / 1000,
);

type Overrides = {
  eventId?: string;
  messageId?: string | null;
  recipient?: string;
  eventTimestamp?: unknown;
};

function payloadBase(o: Overrides, fallbackId: string) {
  return {
    eventId: o.eventId ?? fallbackId,
    ...(o.messageId === null
      ? {}
      : { messageId: o.messageId ?? "<cf-msg-1@saasmail.test>" }),
    sender: "support@saasmail.test",
    recipient: o.recipient ?? "user@example.net",
    subject: "Your receipt",
    terminal: true,
  };
}

function meta(o: Overrides) {
  return "eventTimestamp" in o
    ? { ...metadata, eventTimestamp: o.eventTimestamp }
    : metadata;
}

export function bouncedEvent(o: Overrides & { type?: "hard" | "soft" } = {}) {
  const hard = (o.type ?? "hard") === "hard";
  return {
    type: "cf.email.sending.message.bounced",
    source,
    payload: {
      ...payloadBase(o, "0190d0c4-7ea1-7af2-8b88-c1d2e3f4a5b6"),
      delivery: {
        status: "bounced",
        provider: "external_smtp",
        deliveryTimeMs: 2143,
        smtpStatusCode: hard ? "550" : "451",
        smtpEnhancedStatusCode: hard ? "5.1.1" : "4.2.0",
        smtpResponse: hard
          ? "550 5.1.1 User unknown"
          : "451 4.2.0 Temporary mailbox error",
      },
      bounce: hard
        ? {
            type: "hard",
            classification: "permanent_failure",
            reason: "550 5.1.1 User unknown",
          }
        : {
            type: "soft",
            classification: "temporary_failure",
            reason: "451 4.2.0 Temporary mailbox error",
          },
    },
    metadata: meta(o),
  };
}

export function complainedEvent(o: Overrides = {}) {
  return {
    type: "cf.email.sending.message.complained",
    source,
    payload: {
      ...payloadBase(o, "0190d0c4-9f01-7c44-b2a1-aabbccddeeff"),
      delivery: { status: "complained" },
      complaint: { type: "abuse" },
    },
    metadata: meta(o),
  };
}

export function rejectedEvent(o: Overrides & { reason?: string } = {}) {
  return {
    type: "cf.email.sending.message.rejected",
    source,
    payload: {
      ...payloadBase(o, "0190d0c4-830a-77e5-8fa0-8d10f4e8dc8b"),
      delivery: { status: "rejected" },
      rejection: {
        reason: o.reason ?? "suppressed",
        party: "recipient",
        detail: "Recipient is suppressed",
      },
    },
    metadata: meta(o),
  };
}

export function failedEvent(o: Overrides = {}) {
  return {
    type: "cf.email.sending.message.failed",
    source,
    payload: {
      ...payloadBase(o, "0190d0c4-81c1-7bc6-9344-829cd9001a12"),
      delivery: { status: "failed" },
      failure: { reason: "delivery_failed" },
    },
    metadata: meta(o),
  };
}

export function deliveredEvent(o: Overrides = {}) {
  return {
    type: "cf.email.sending.message.delivered",
    source,
    payload: {
      ...payloadBase(o, "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f"),
      delivery: {
        status: "delivered",
        provider: "gmail",
        deliveryTimeMs: 1234,
        smtpStatusCode: "250",
        smtpEnhancedStatusCode: "2.0.0",
        smtpResponse: "250 2.0.0 OK 1714820445 a1b2c3 - gsmtp",
      },
    },
    metadata: meta(o),
  };
}
