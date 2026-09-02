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

---

**See also:** [Setup](setup.md) · [Configuration](configuration.md) · [Per-inbox forwarding](inboxes.md#per-inbox-forwarding) (why forwarding goes through your provider rather than Email Routing)
