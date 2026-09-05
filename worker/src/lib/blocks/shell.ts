/**
 * The document shell: everything around the block rows.
 *
 * Structure is a centred table inside a full-bleed background table, which is
 * the only layout that behaves in Outlook's Word rendering engine. The `mso`
 * conditional gives Outlook a fixed-width table it can measure, since it
 * ignores `max-width`.
 *
 * The single `<style>` block carries what cannot be inlined — media queries.
 * Everything else is an inline `style` attribute written by an emitter.
 */

import type { Theme } from "./theme";

/** Escape text destined for an HTML body or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  // `replace(/x/g, …)` rather than `replaceAll`: this module is compiled by
  // `tsconfig.app.json` (the editor imports it for the preview), which targets
  // ES2020.
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Media queries and the handful of client resets that cannot be expressed
 * inline. Kept deliberately short: anything that *can* be inlined is, because
 * Gmail strips `<style>` in some contexts (notably the Gmail app with a
 * non-Gmail account).
 */
function styleBlock(theme: Theme): string {
  return `
    body { margin: 0; padding: 0; width: 100% !important; }
    table { border-collapse: collapse; }
    img { border: 0; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a { color: ${theme.linkColor}; }
    @media only screen and (max-width: 620px) {
      .sm-full { width: 100% !important; max-width: 100% !important; }
      .sm-px { padding-left: 20px !important; padding-right: 20px !important; }
    }
  `
    .replace(/\n\s+/g, "\n")
    .trim();
}

/**
 * Wrap compiled block rows in the document shell.
 *
 * `preheader` is the snippet most clients show next to the subject line. It is
 * emitted whether or not it has content: an empty, hidden preheader stops the
 * client from pulling the first line of body copy into that slot.
 */
export function wrapDocument(
  rows: string,
  theme: Theme,
  preheader = "",
): string {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
${styleBlock(theme)}
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${theme.pageBg};font-family:${theme.fontFamily};font-size:${theme.fontSize};line-height:${theme.lineHeight};color:${theme.textColor};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${theme.pageBg};">
<tr>
<td align="center" style="padding:24px 0;">
<!--[if mso]><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="600"><tr><td><![endif]-->
<table role="presentation" class="sm-full" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:${theme.contentWidth};background-color:${theme.contentBg};">
${rows}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>`;
}
