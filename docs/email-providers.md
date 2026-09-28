[saasmail](../README.md) › [Docs](README.md) › **Email providers**

# Email providers

Inbound is always Cloudflare. Outbound is your pick of four.

|               | Cloudflare | Resend | Bavimail | Postmark |
| ------------- | ---------- | ------ | -------- | -------- |
| **Sending**   | ✅         | ✅     | ✅       | ✅       |
| **Receiving** | ✅         | ❌     | ❌       | ❌       |

## Choosing one

Pick one outbound provider at deploy time:

- **Cloudflare Email Sending** — no third-party account needed. Add a `send_email` binding (`EMAIL`) in `wrangler.jsonc` and onboard your domain at [Email Service](https://dash.cloudflare.com/?to=/:account/email-service).
- **[Resend](https://resend.com/)** — set `RESEND_API_KEY` as a secret.
- **[Bavimail](https://bavimail.com/)** — set `BAVIMAIL_API_KEY` and `BAVIMAIL_ALIAS_ID` as secrets. The alias ID identifies the sending alias configured in your Bavimail dashboard.
- **[Postmark](https://postmarkapp.com/)** — set `POSTMARK_API_KEY` as a secret (your Postmark server's API token). Verify each send-from domain in the Postmark dashboard.

## Selection precedence

At runtime: **Bavimail** (when both env vars are set) > **Postmark** (when `POSTMARK_API_KEY` is set) > **Resend** (when `RESEND_API_KEY` is set) > **Cloudflare Email Sending** (when the `EMAIL` binding exists). If none are configured, send attempts return a "No email provider configured" error.

Setting more than one provider's variables is not an error — the highest one in
that order wins, and the others are ignored.

## Several To and Bcc

JMAP submissions can have several To addresses and Bcc recipients. Cloudflare, Resend and Postmark deliver them; Bcc recipients are in the envelope only, never in the message's headers. Bavimail's API takes one To address and a Cc list, so on Bavimail a JMAP submission with a second To or any Bcc is refused rather than sent to fewer people.

## Per-message limits

Every send path applies Cloudflare's limits, the strictest of the four, whichever provider is configured: at most **50 recipients** (To, Cc and Bcc together) and **32 attachments**, inline images included. The attachment size allowance is each provider's own; on Cloudflare the whole message must fit 5 MiB to arbitrary recipients.

On Cloudflare, saasmail uses the `send_email` binding's structured form: every To and Cc is a real recipient, with its display name, and Cloudflare assembles the message and assigns its `Message-ID` and `Date` itself.

Two Cloudflare quirks of that form, seen live:

- **A text attachment arrives with a line break appended.** A `text/*` file (`.txt`, `.csv`, `.md`, …) that saasmail sends as `abc` reaches the recipient as `abc` plus a newline. Binary attachments and images arrive byte-for-byte. saasmail keeps the true content type rather than disguising text files as `application/octet-stream`.
- **An inline image loses its filename.** It still renders in the message (its Content-ID, type and bytes are intact), but a recipient who saves it sees no name.

---

**See also:** [Setup](setup.md) · [Configuration](configuration.md) · [Per-inbox forwarding](inboxes.md#per-inbox-forwarding) (why forwarding goes through your provider rather than Email Routing)
