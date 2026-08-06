import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { json200Response } from "../lib/helpers";
import { lookupDomainDns } from "../lib/domain-dns";
import type { Variables } from "../variables";

export const domainsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DnsRecordSchema = z.object({
  name: z.string(),
  type: z.enum(["MX", "TXT"]),
  value: z.string().nullable().openapi({
    description:
      "`null` when only Cloudflare can supply the value — the DKIM public key is generated per domain, so the operator copies it from Email Routing → Settings.",
  }),
  action: z.enum(["add", "replace"]).openapi({
    description:
      "`replace` means edit the record already at this name rather than adding a second one. SPF arrives pre-merged: only one SPF record per name is legal.",
  }),
  note: z.string().nullable(),
});

const DomainDnsSchema = z.object({
  routing: z.enum(["cloudflare", "elsewhere", "none", "unknown"]),
  mx: z.array(z.string()),
  spf: z.enum(["cloudflare", "elsewhere", "none", "unknown"]),
  spfRecord: z.string().nullable(),
  dkim: z.enum(["cloudflare", "elsewhere", "none", "unknown"]),
  missingRecords: z.array(DnsRecordSchema),
});

const DomainSchema = z.object({
  domain: z.string(),
  inboxCount: z.number(),
  messageCount: z.number(),
  dns: DomainDnsSchema,
});

const listDomainsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Domains"],
  description:
    "List the domains this deployment handles mail for, derived from received messages + sender_identities, each with its live MX/SPF/DKIM status read over DNS-over-HTTPS. `routing`/`spf`/`dkim` are `unknown` when the resolver could not be reached — that is not a misconfiguration, and a check that answered `unknown` contributes no missing records of its own. Each entry in `missingRecords` carries an `action`: `add` for a name with nothing on it, `replace` where a record already exists and must be edited instead of duplicated. The DKIM entry has a `null` value because Cloudflare generates that key per domain — the operator must copy it from Email Routing → Settings in the dashboard.",
  responses: {
    ...json200Response(z.array(DomainSchema), "Domains and their DNS status"),
  },
});

domainsRouter.openapi(listDomainsRoute, async (c) => {
  const db = c.get("db");
  type Row = { domain: string; inboxCount: number; messageCount: number };
  const rows = await db.all<Row>(sql`
    WITH universe AS (
      SELECT DISTINCT LOWER(recipient) AS email FROM ${emails}
      UNION
      SELECT LOWER(email) FROM ${senderIdentities}
    ),
    inbox_counts AS (
      SELECT LOWER(SUBSTR(email, INSTR(email, '@') + 1)) AS domain,
             COUNT(*) AS n
      FROM universe
      WHERE INSTR(email, '@') > 0
      GROUP BY 1
    ),
    message_counts AS (
      SELECT LOWER(SUBSTR(recipient, INSTR(recipient, '@') + 1)) AS domain,
             COUNT(*) AS n
      FROM ${emails}
      WHERE INSTR(recipient, '@') > 0
      GROUP BY 1
    )
    SELECT i.domain AS domain,
           i.n AS inboxCount,
           COALESCE(m.n, 0) AS messageCount
    FROM inbox_counts i
    LEFT JOIN message_counts m ON m.domain = i.domain
    ORDER BY i.domain
  `);

  const dns = await Promise.all(rows.map((r) => lookupDomainDns(r.domain)));

  return c.json(
    rows.map((r, i) => ({
      domain: r.domain,
      inboxCount: r.inboxCount,
      messageCount: r.messageCount,
      dns: dns[i],
    })),
    200,
  );
});
