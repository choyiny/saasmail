import { describe, expect, it } from "vitest";
import {
  adaptReceived,
  adaptSent,
  parseCc,
  type ReceivedSelect,
  type SentSelect,
} from "../lib/messages/adapters";
import { parseMessageRef, serializeMessageRef } from "../lib/messages/types";

describe("message adapters", () => {
  it("adapts a received row into the unified contract", () => {
    const row: ReceivedSelect = {
      id: "recv-1",
      personId: "person-1",
      recipient: "support@example.com",
      subject: null,
      bodyHtml: "<p>Hello</p>",
      bodyText: null,
      messageId: "recv-1@example.com",
      isRead: 0,
      cc: JSON.stringify([{ email: "copy@example.com", name: "Copy" }]),
      conversationId: "conv-1",
      receivedAt: 123,
      personEmail: "alice@example.com",
      personName: "Alice",
    };

    expect(adaptReceived(row)).toEqual({
      ref: { kind: "received", id: "recv-1" },
      direction: "inbound",
      inbox: "support@example.com",
      personId: "person-1",
      conversationId: "conv-1",
      messageId: "recv-1@example.com",
      inReplyTo: null,
      from: { email: "alice@example.com", name: "Alice" },
      to: { email: "support@example.com" },
      cc: [{ email: "copy@example.com", name: "Copy" }],
      subject: null,
      bodyText: null,
      bodyHtml: "<p>Hello</p>",
      occurredAt: 123,
      isRead: false,
      source: { campaignId: null },
      delivery: null,
    });
  });

  it("keeps an orphaned received sender nullable instead of inventing an address", () => {
    const row: ReceivedSelect = {
      id: "recv-orphan",
      personId: "missing-person",
      recipient: "support@example.com",
      subject: "Orphan",
      bodyHtml: null,
      bodyText: "Hello",
      messageId: null,
      isRead: 1,
      cc: null,
      conversationId: null,
      receivedAt: 124,
      personEmail: null,
      personName: null,
    };

    expect(adaptReceived(row).from).toBeNull();
  });

  it("adapts a sent row into the unified contract", () => {
    const row: SentSelect = {
      id: "sent-1",
      personId: null,
      fromAddress: "support@example.com",
      toAddress: "subscriber@example.com",
      subject: "Campaign",
      bodyHtml: null,
      bodyText: "Hello",
      inReplyTo: "prior@example.com",
      messageId: "sent-1@example.com",
      status: "sent",
      cc: null,
      conversationId: null,
      campaignId: "campaign-1",
      sentAt: 456,
      personName: "Subscriber",
    };

    expect(adaptSent(row)).toEqual({
      ref: { kind: "sent", id: "sent-1" },
      direction: "outbound",
      inbox: "support@example.com",
      personId: null,
      conversationId: null,
      messageId: "sent-1@example.com",
      inReplyTo: "prior@example.com",
      from: { email: "support@example.com" },
      to: { email: "subscriber@example.com", name: "Subscriber" },
      cc: [],
      subject: "Campaign",
      bodyText: "Hello",
      bodyHtml: null,
      occurredAt: 456,
      isRead: null,
      source: { campaignId: "campaign-1" },
      delivery: { status: "sent" },
    });
  });

  it("treats malformed cc as an empty list", () => {
    expect(parseCc("not json")).toEqual([]);
    expect(parseCc('{"email":"no-array@example.com"}')).toEqual([]);
    expect(parseCc(null)).toEqual([]);
  });

  it("round-trips message refs without treating ids as globally unique", () => {
    const ref = { kind: "sent" as const, id: "abc:def" };
    const encoded = serializeMessageRef(ref);

    expect(encoded).toBe("sent:abc:def");
    expect(parseMessageRef(encoded)).toEqual(ref);
    expect(parseMessageRef("other:abc")).toBeNull();
    expect(parseMessageRef("received:")).toBeNull();
  });
});
