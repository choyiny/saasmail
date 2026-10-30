[saasmail](../README.md) › [Docs](README.md) › **Test mail**

# Test mail

An end-to-end test that drives a sign-up, a magic link, a password reset or a
newsletter send has to read the mail the app sent. saasmail can be that
mailbox: give it a [test inbox](inboxes.md#test-inboxes), send the app's mail
to a plus address of it, and ask `GET /api/test-mail/wait` for the message.

## Setting it up

1. In the Cloudflare dashboard, for the domain: Email Routing → Settings →
   **Subaddressing** on. Then add a literal rule `e2e@<domain>` → Send to a
   Worker → your saasmail Worker.
2. In saasmail, create the inbox `e2e@<domain>` on the **Inboxes** page and
   turn on **Test inbox** while it is still empty.
3. Invite a member user for CI and give it access to that inbox only. The
   member signs in once, adds a passkey (creating a key requires one) and
   creates its `sk_…` key under **API keys**
   ([Users and API keys](users-and-api-keys.md#api-keys)). Store the key as a
   CI secret.

Use a member key, not an admin's: the endpoint works with an admin key too,
but an admin key in CI can read every inbox through the other routes.

Test mail counts toward your sending provider's quota like any mail the app
sends.

## The endpoint

`GET /api/test-mail/wait`, with a session or `Authorization: Bearer sk_…`.
It answers the first message to the test inbox that matches, oldest first, or
`204` when none arrived before the timeout.

| Query     | Required | Meaning                                                                                                                                                          |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox`   | yes      | The test inbox address (the base address, no `+detail`)                                                                                                          |
| `detail`  | no       | Only mail sent to `local+detail@`; compared lowercased                                                                                                           |
| `since`   | yes      | Epoch seconds: only mail received at or after it                                                                                                                 |
| `subject` | no       | Substring of the subject, case-insensitive for ASCII letters only: write accented letters in the case the mail uses (`réinitialisation`, not `RÉINITIALISATION`) |
| `from`    | no       | Exact sender address                                                                                                                                             |
| `timeout` | no       | Seconds to wait, 1–30, default 25                                                                                                                                |

A `200` body:

```json
{
  "id": "V1StGXR8_Z5jdHi6B-myT",
  "inbox": "e2e@example.com",
  "detail": "reset-1730296800000",
  "from": "no-reply@example.com",
  "subject": "Reset your password",
  "receivedAt": 1730296805,
  "text": "Your code is 482913. Reset at https://example.com/reset?a=1&b=2",
  "html": "<p>…</p>",
  "links": ["https://example.com/reset?a=1&b=2"],
  "codes": ["482913"]
}
```

- `links`: the `http(s)` URLs of the HTML's `href`s (with entities such as
  `&amp;` decoded) and of the text, without duplicates, at most 20.
- `codes`: whole runs of 4 to 8 digits (not part of a longer number) in the
  subject and the text, or in the HTML turned into text when the message has no
  text part; without duplicates, in order, at most 10. The test picks the one it
  needs.
- `403` (one body for both cases): the caller may not read the inbox, or it is
  not a test inbox. The endpoint never waits on a normal inbox.
- `400`: a missing or invalid parameter.

The wait checks the database at once, after one second, then every two
seconds, and stops when the client disconnects. A message a member archived or
snoozed is still found. The call is not recorded in the audit log, like the
other message reads. MCP clients have the same wait as
[`wait_for_test_mail`](mcp.md#scopes).

## A helper for Playwright

Secrets: `TEST_MAIL_URL` (the saasmail base URL), `TEST_MAIL_INBOX`
(`e2e@<domain>`) and `TEST_MAIL_KEY` (the member's key).

```ts
// e2e/fixtures/test-mail.ts
export function testAddress(runId: string): string {
  const [local, domain] = process.env.TEST_MAIL_INBOX!.split("@");
  return `${local}+${runId}@${domain}`;
}

export async function waitForMail(q: {
  runId: string;
  since: number;
  subject?: string;
}) {
  const url = new URL("/api/test-mail/wait", process.env.TEST_MAIL_URL);
  url.searchParams.set("inbox", process.env.TEST_MAIL_INBOX!);
  url.searchParams.set("detail", q.runId.toLowerCase());
  url.searchParams.set("since", String(Math.floor(q.since / 1000)));
  if (q.subject) url.searchParams.set("subject", q.subject);
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.TEST_MAIL_KEY}` },
    });
    if (res.status === 200)
      return (await res.json()) as {
        links: string[];
        codes: string[];
        subject: string;
      };
    if (res.status !== 204) throw new Error(`test-mail: HTTP ${res.status}`);
  }
  throw new Error("No mail in 2 minutes");
}

// In a spec:
// const runId = `reset-${Date.now()}`; const since = Date.now();
// await page.getByLabel("E-mail").fill(testAddress(runId));
// await page.getByRole("button", { name: "Reset" }).click();
// const mail = await waitForMail({ runId, since, subject: "reset" });
// await page.goto(mail.links.find((l) => l.includes("/reset"))!);
```

Use one address per message (one `runId` per test): a message sent to two plus
addresses of the same inbox is stored once, under the first.

---

**See also:** [Inboxes](inboxes.md#test-inboxes) · [Users and API keys](users-and-api-keys.md) · [MCP server](mcp.md)
