import type { SendEmailAttachment, SendEmailParams } from "./types";

const IMG_TAG = /<img\b[^>]*>/gi;
const DATA_SRC =
  /(\ssrc\s*=\s*)(["'])data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\2/i;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The composer embeds pasted and dropped images as `data:image/...;base64`
 * URIs, which Gmail, Outlook and most webmail clients refuse to render. Move
 * each one into an inline MIME part and point the `<img>` at it by `cid:` —
 * the form every client shows. A repeated image is sent once. Returns
 * `params` unchanged when the html holds no such image.
 */
export function inlineDataImages(params: SendEmailParams): SendEmailParams {
  if (!params.html || !params.html.includes("data:image/")) return params;

  const inline: SendEmailAttachment[] = [];
  const cidByUri = new Map<string, string>();

  const html = params.html.replace(IMG_TAG, (tag) =>
    tag.replace(DATA_SRC, (match, prefix, quote, contentType, b64) => {
      const key = `${contentType};${b64}`;
      let cid = cidByUri.get(key);
      if (!cid) {
        const content = decodeBase64(b64);
        if (!content) return match;
        cid = `${crypto.randomUUID()}@saasmail`;
        cidByUri.set(key, cid);
        const type = contentType.toLowerCase();
        const ext = EXTENSIONS[type] ?? type.slice("image/".length);
        inline.push({
          filename: `image-${inline.length + 1}.${ext}`,
          contentType: type,
          content,
          contentId: cid,
        });
      }
      return `${prefix}${quote}cid:${cid}${quote}`;
    }),
  );

  if (inline.length === 0) return params;
  return {
    ...params,
    html,
    attachments: [...(params.attachments ?? []), ...inline],
  };
}
