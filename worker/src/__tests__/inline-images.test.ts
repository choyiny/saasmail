import { describe, it, expect, vi } from "vitest";
import { createEmailSender, PostmarkSender } from "../lib/email-sender";
import { inlineDataImages } from "../lib/email-sender/inline-images";
import { buildMimeMessage } from "../lib/email-sender/providers/mime";

// 1×1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_URI = `data:image/png;base64,${PNG_B64}`;

describe("inlineDataImages", () => {
  it("moves a data-URI <img> into an inline attachment referenced by cid:", () => {
    const out = inlineDataImages({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: `<p>hi</p><img src="${PNG_URI}" alt="x">`,
    });

    expect(out.html).not.toContain("data:");
    expect(out.attachments).toHaveLength(1);
    const att = out.attachments![0];
    expect(att.contentType).toBe("image/png");
    expect(att.filename).toBe("image-1.png");
    expect(att.contentId).toBeTruthy();
    expect(out.html).toContain(`src="cid:${att.contentId}"`);
    expect(new Uint8Array(att.content as Uint8Array).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("keeps existing attachments and shares one part for a repeated image", () => {
    const existing = {
      filename: "doc.pdf",
      contentType: "application/pdf",
      content: new Uint8Array([1]),
    };
    const out = inlineDataImages({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: `<img src='${PNG_URI}'><img alt="y" src="${PNG_URI}">`,
      attachments: [existing],
    });

    expect(out.attachments).toHaveLength(2);
    expect(out.attachments![0]).toBe(existing);
    const cid = out.attachments![1].contentId;
    expect(out.html.match(new RegExp(`cid:${cid}`, "g"))).toHaveLength(2);
  });

  it("returns the params untouched when there is no data-URI image", () => {
    const params = {
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: `<img src="https://example.com/a.png"><p>data:image/png;base64,AAAA</p>`,
    };
    expect(inlineDataImages(params)).toBe(params);
  });
});

describe("providers send data-URI images as inline CID parts", () => {
  it("Cloudflare: the structured send carries an inline part, not a data: URI", async () => {
    const binding = { send: vi.fn().mockResolvedValue({ messageId: "m" }) };
    const sender = createEmailSender({
      EMAIL: binding,
    } as unknown as CloudflareBindings);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: `<p>hi</p><img src="${PNG_URI}">`,
      text: "hi",
    });

    expect(result.error).toBeNull();
    // The fork sends through the binding's structured form, so the inline
    // part is an attachment object rather than MIME text.
    const sent = binding.send.mock.calls[0][0];
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0].disposition).toBe("inline");
    expect(sent.attachments[0].contentId).toMatch(/@saasmail$/);
    expect(sent.html).toContain(`src="cid:${sent.attachments[0].contentId}"`);
    expect(JSON.stringify(sent)).not.toContain("data:image/png");
  });

  it("Gmail/Outlook: the raw MIME carries a related inline part", () => {
    const raw = buildMimeMessage({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: `<img src="${PNG_URI}">`,
    });

    expect(raw).toContain("multipart/related");
    expect(raw).toMatch(/Content-ID: <[^>]+@saasmail>/);
    expect(raw).toContain('src="cid:');
    expect(raw).not.toContain("data:image/png");
  });

  it("Postmark: the image goes in Attachments with a ContentID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm" }), {
        status: 200,
      }),
    );
    const sender = new PostmarkSender(
      "pm_test",
      fetchMock as unknown as typeof fetch,
    );

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: `<img src="${PNG_URI}">`,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.HtmlBody).not.toContain("data:");
    expect(body.Attachments).toHaveLength(1);
    expect(body.Attachments[0].ContentID).toMatch(/^cid:/);
    expect(body.HtmlBody).toContain(`src="${body.Attachments[0].ContentID}"`);
  });
});
