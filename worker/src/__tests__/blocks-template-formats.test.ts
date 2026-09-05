import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { emailTemplates } from "../db/email-templates.schema";
import { campaigns } from "../db/campaigns.schema";
import { lists } from "../db/lists.schema";
import { snapshotCampaign } from "../lib/campaign-sender";

const now = () => Math.floor(Date.now() / 1000);

const blockDoc = (blocks: unknown[]) => ({ version: 1, blocks });

const HELLO = blockDoc([
  { id: "h", type: "heading", data: { level: 1, html: "Hello" } },
  {
    id: "p",
    type: "paragraph",
    data: { html: "Hi {{subscriber_name}}" },
  },
  {
    id: "u",
    type: "paragraph",
    data: { html: '<a href="{{unsubscribe_url}}">Unsubscribe</a>' },
  },
]);

const create = (apiKey: string, body: Record<string, unknown>) =>
  authFetch("/api/email-templates", {
    apiKey,
    method: "POST",
    body: JSON.stringify({
      slug: "block-tpl",
      name: "Block",
      subject: "Subject",
      fromAddress: null,
      ...body,
    }),
  });

const update = (apiKey: string, slug: string, body: Record<string, unknown>) =>
  authFetch(`/api/email-templates/${slug}`, {
    apiKey,
    method: "PUT",
    body: JSON.stringify(body),
  });

describe("template formats", () => {
  let apiKey: string;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("creating a block template", () => {
    it("compiles the document and stores all three columns", async () => {
      const res = await create(apiKey, {
        format: "block",
        bodyJson: HELLO,
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as any;
      expect(body.format).toBe("block");
      expect(body.bodyJson.blocks).toHaveLength(3);
      expect(body.bodyHtml).toContain("<!doctype html>");
      expect(body.bodyHtml).toContain("Hello");

      const [row] = await getDb()
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.slug, "block-tpl"));
      expect(row.format).toBe("block");
      expect(row.bodyHtml).toBe(body.bodyHtml);
    });

    /**
     * If both representations were accepted the two would drift, and whichever
     * the client happened to set is what subscribers would receive.
     */
    it("refuses a client-supplied bodyHtml", async () => {
      const res = await create(apiKey, {
        format: "block",
        bodyJson: HELLO,
        bodyHtml: "<p>mine</p>",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/bodyHtml is not accepted/);
    });

    it("requires bodyJson", async () => {
      const res = await create(apiKey, { format: "block" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/bodyJson is required/);
    });

    it("refuses bodyJson on an html template", async () => {
      const res = await create(apiKey, {
        bodyHtml: "<p>x</p>",
        bodyJson: HELLO,
      });
      expect(res.status).toBe(400);
    });

    it("names the offending field when the document is invalid", async () => {
      const res = await create(apiKey, {
        format: "block",
        bodyJson: blockDoc([
          {
            id: "i",
            type: "image",
            data: { src: "data:image/png;base64,AAA" },
          },
        ]),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/data:/);
    });

    /**
     * The tag check has to run on the *compiled* output, so a malformed
     * section typed into a block fails the write with the same diagnostic a
     * hand-written HTML template would produce.
     */
    it("rejects an unbalanced section typed into a block", async () => {
      const res = await create(apiKey, {
        format: "block",
        bodyJson: blockDoc([
          { id: "p", type: "paragraph", data: { html: "{{#items}}unclosed" } },
        ]),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/items/);
    });

    it("sanitizes block content before it reaches bodyHtml", async () => {
      const res = await create(apiKey, {
        format: "block",
        bodyJson: blockDoc([
          {
            id: "p",
            type: "paragraph",
            data: { html: '<script>alert(1)</script><b onclick="x">hi</b>' },
          },
        ]),
      });
      const body = (await res.json()) as any;
      expect(body.bodyHtml).not.toContain("<script>");
      expect(body.bodyHtml).not.toContain("onclick");
      expect(body.bodyHtml).toContain("<b>hi</b>");
      expect(body.bodyJson.blocks[0].data.html).toBe("alert(1)<b>hi</b>");
    });
  });

  describe("existing HTML templates are untouched", () => {
    it("defaults to html with a null bodyJson", async () => {
      const res = await create(apiKey, {
        slug: "plain",
        bodyHtml: "<p>Hi {{name}}</p>",
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as any;
      expect(body.format).toBe("html");
      expect(body.bodyJson).toBeNull();
      expect(body.bodyHtml).toBe("<p>Hi {{name}}</p>");
    });

    it("a row written before the column existed reads back as html", async () => {
      // Simulates a pre-migration row: the DB default supplies `format`.
      await getDb()
        .insert(emailTemplates)
        .values({
          id: "legacy-1",
          slug: "legacy",
          name: "Legacy",
          subject: "Old",
          bodyHtml: "<p>unchanged</p>",
          fromAddress: null,
          createdAt: now(),
          updatedAt: now(),
        } as never);

      const res = await authFetch("/api/email-templates/legacy", { apiKey });
      const body = (await res.json()) as any;
      expect(body.format).toBe("html");
      expect(body.bodyJson).toBeNull();
      expect(body.bodyHtml).toBe("<p>unchanged</p>");
    });
  });

  describe("format conversion", () => {
    beforeEach(async () => {
      await create(apiKey, { format: "block", bodyJson: HELLO });
    });

    it("block to html keeps the compiled HTML and drops the document", async () => {
      const before = (await (
        await authFetch("/api/email-templates/block-tpl", { apiKey })
      ).json()) as any;

      const res = await update(apiKey, "block-tpl", { format: "html" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.format).toBe("html");
      expect(body.bodyJson).toBeNull();
      expect(body.bodyHtml).toBe(before.bodyHtml);
    });

    /**
     * A blank body has nothing to lose, and refusing there would block the
     * ordinary path: a campaign created blank starts as `html`, and choosing
     * "blocks" is the operator's first act.
     */
    it("html to block is allowed when there is no content to lose", async () => {
      await create(apiKey, { slug: "empty", bodyHtml: "   " });
      const res = await update(apiKey, "empty", {
        format: "block",
        bodyJson: HELLO,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.format).toBe("block");
      expect(body.bodyHtml).toContain("Hello");
    });

    it("html to block is refused once there is content — the conversion would be lossy", async () => {
      await create(apiKey, { slug: "plain", bodyHtml: "<p>x</p>" });
      const res = await update(apiKey, "plain", {
        format: "block",
        bodyJson: HELLO,
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/cannot be converted/);
    });
  });

  describe("updating a block template", () => {
    beforeEach(async () => {
      await create(apiKey, { format: "block", bodyJson: HELLO });
    });

    it("recompiles bodyHtml from the new document", async () => {
      const res = await update(apiKey, "block-tpl", {
        bodyJson: blockDoc([
          { id: "p", type: "paragraph", data: { html: "Replaced entirely" } },
        ]),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.bodyHtml).toContain("Replaced entirely");
      expect(body.bodyHtml).not.toContain("Hello");
    });

    it("refuses a bodyHtml write", async () => {
      const res = await update(apiKey, "block-tpl", {
        bodyHtml: "<p>mine</p>",
      });
      expect(res.status).toBe(400);
    });

    it("leaves the body alone when only the name changes", async () => {
      const before = (await (
        await authFetch("/api/email-templates/block-tpl", { apiKey })
      ).json()) as any;

      const res = await update(apiKey, "block-tpl", { name: "Renamed" });
      const body = (await res.json()) as any;

      expect(body.name).toBe("Renamed");
      expect(body.bodyHtml).toBe(before.bodyHtml);
      expect(body.bodyJson).toEqual(before.bodyJson);
    });
  });
});

/**
 * The invariant, tested: a block-authored campaign sends through the campaign
 * path with the compiler nowhere in it.
 *
 * Content lives on the **campaign** now. A template is only a starting point —
 * its content is copied in at creation, and the campaign owns it from then on.
 * That is what makes templates reusable instead of one-throwaway-per-campaign.
 */
describe("a block-authored campaign sends through the campaign path", () => {
  let apiKey: string;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());

    await getDb()
      .insert(lists)
      .values({
        id: "list-1",
        name: "Weekly",
        description: null,
        fromAddress: "news@saasmail.test",
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
      } as never);
  });

  /** Create the block template, then a campaign seeded from it. */
  async function seedCampaignFromBlockTemplate() {
    await create(apiKey, { format: "block", bodyJson: HELLO });
    const res = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Weekly #1",
        subject: "This week",
        templateSlug: "block-tpl",
        listId: "list-1",
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as any;
  }

  it("copies the template's compiled content into the campaign at creation", async () => {
    const campaign = await seedCampaignFromBlockTemplate();

    expect(campaign.format).toBe("block");
    expect(campaign.bodyHtml).toContain("<!doctype html>");
    expect(campaign.bodyHtml).toContain("Hello");
    expect(campaign.bodyJson.blocks).toHaveLength(3);
  });

  it("snapshots the campaign's own body and derives a text part from it", async () => {
    const campaign = await seedCampaignFromBlockTemplate();

    expect(await snapshotCampaign(getDb(), campaign.id, now())).toBeNull();

    const [row] = await getDb()
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));

    expect(row.htmlSnapshot).toContain("<!doctype html>");
    expect(row.htmlSnapshot).toContain("Hello");
    expect(row.textSnapshot).toContain("Hello");
    expect(row.contentSnapshotAt).not.toBeNull();
  });

  it("leaves template variables in the snapshot for per-recipient interpolation", async () => {
    const campaign = await seedCampaignFromBlockTemplate();
    await snapshotCampaign(getDb(), campaign.id, now());

    const [row] = await getDb()
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));

    expect(row.htmlSnapshot).toContain("{{subscriber_name}}");
    expect(row.htmlSnapshot).toContain("{{unsubscribe_url}}");
  });

  it("recompiles the campaign body when its blocks are edited", async () => {
    const campaign = await seedCampaignFromBlockTemplate();

    const res = await authFetch(`/api/campaigns/${campaign.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({
        bodyJson: blockDoc([
          {
            id: "p",
            type: "paragraph",
            data: { html: "Rewritten on the campaign" },
          },
        ]),
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.bodyHtml).toContain("Rewritten on the campaign");
    expect(body.bodyHtml).not.toContain("Hello");
  });

  it("is unaffected by editing or deleting the template it was seeded from", async () => {
    const campaign = await seedCampaignFromBlockTemplate();

    await update(apiKey, "block-tpl", {
      bodyJson: blockDoc([
        { id: "p", type: "paragraph", data: { html: "Template moved on" } },
      ]),
    });
    await getDb().delete(emailTemplates);

    expect(await snapshotCampaign(getDb(), campaign.id, now())).toBeNull();
    const [row] = await getDb()
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));

    expect(row.htmlSnapshot).toContain("Hello");
    expect(row.htmlSnapshot).not.toContain("Template moved on");
  });
});
