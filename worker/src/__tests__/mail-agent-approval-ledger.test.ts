/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type AgentApprovalLedger,
  type AgentApprovalLedgerEntry,
} from "../agent/mail-agent";

describe("MailAgent SQL approval ledger", () => {
  it("persists, prunes, and removes approval metadata in the SQLite DO", async () => {
    const stub = env.MAIL_AGENT.get(
      env.MAIL_AGENT.idFromName("approval-ledger-sql-test"),
    );
    const now = Math.floor(Date.now() / 1000);
    const expired: AgentApprovalLedgerEntry = {
      approvalId: "expired-approval",
      toolCallId: "expired-call",
      toolName: "assign_conversation",
      signature: "expired-signature",
      hasInputSchemaInput: false,
      createdAt: now - 8 * 24 * 60 * 60,
    };
    const first: AgentApprovalLedgerEntry = {
      approvalId: "approval-1",
      toolCallId: "call-1",
      toolName: "link_customer",
      signature: "signature-1",
      isAutomatic: false,
      requestReason: "Link these customer records",
      hasInputSchemaInput: true,
      inputSchemaInput: { personId: "person-1", otherPersonId: "person-2" },
      createdAt: now,
    };
    const second: AgentApprovalLedgerEntry = {
      approvalId: "approval-2",
      toolCallId: "call-2",
      toolName: "add_to_list",
      signature: "signature-2",
      isAutomatic: true,
      hasInputSchemaInput: false,
      createdAt: now,
    };

    await runInDurableObject(stub, async (instance) => {
      const ledger = (
        instance as unknown as { approvalLedger(): AgentApprovalLedger }
      ).approvalLedger();

      await ledger.record([expired]);
      expect(await ledger.lookup([expired.approvalId])).toEqual([expired]);

      // A subsequent record pass prunes entries older than the seven-day TTL.
      await ledger.record([first, second]);
      expect(await ledger.lookup([expired.approvalId])).toEqual([]);

      expect(
        await ledger.lookup([first.approvalId, second.approvalId]),
      ).toEqual([first, second]);

      // INSERT OR IGNORE keeps the original signed approval immutable.
      await ledger.record([{ ...first, signature: "replacement-signature" }]);
      expect(await ledger.lookup([first.approvalId])).toEqual([first]);

      await ledger.removeByToolCallIds([first.toolCallId]);
      expect(
        await ledger.lookup([first.approvalId, second.approvalId]),
      ).toEqual([second]);

      await ledger.remove([second.approvalId]);
      expect(await ledger.lookup([second.approvalId])).toEqual([]);
    });
  });
});
