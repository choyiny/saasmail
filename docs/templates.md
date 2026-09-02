[saasmail](../README.md) › [Docs](README.md) › **Email templates**

# Email templates

![Email templates](screenshots/templates.jpg)

Create reusable HTML email templates with `{{variable}}` interpolation. Edit templates with a live HTML editor, preview rendered output, and send them via the API or the UI. Top-level variables are automatically extracted and validated before sending — a send that omits one is rejected with `400` rather than mailing a half-rendered template. Templates are scoped to allowed inboxes.

**Validation covers top-level names only.** Names used inside a `{{#section}}`
body are _not_ validated, because they resolve against the current item at
render time rather than against what the caller passed. An unresolved name
inside a section renders **empty**; only the section's own name is required.

`GET /api/email-templates/{slug}/variables` returns three lists:

- `variables` — top-level names the caller must supply, or the send fails.
  This is the send contract; its shape and meaning are unchanged.
- `optional` — names that render empty when absent: `{{key?}}` tags and
  inverted (`{{^key}}`) section names.
- `sections` — each section's name, whether it's inverted, and the names its
  body references. Those body names resolve per item at render time and are
  never part of `variables`, even though the response now surfaces them for
  the editor and API callers building a form around a template.

## Template syntax

| Tag                  | Behavior                                                   |
| -------------------- | ---------------------------------------------------------- |
| `{{key}}`            | Value, HTML-escaped in the body; plain text in the subject |
| `{{{key}}}`          | Value, raw — for pre-rendered HTML                         |
| `{{key?}}`           | Optional; renders empty instead of failing the send        |
| `{{key\|nl2br}}`     | Escaped, then newlines become `<br>`                       |
| `{{#key}}…{{/key}}`  | Renders if truthy; iterates arrays                         |
| `{{#key?}}…{{/key}}` | Same as `{{#key}}`, but doesn't fail the send if missing   |
| `{{^key}}…{{/key}}`  | Renders if falsy or empty                                  |
| `{{.}}`              | Current item inside an array-of-strings section            |

```html
{{#items}}
<tr>
  <td>{{name}}</td>
  <td>{{currency}}{{price}}</td>
</tr>
{{/items}} {{^items}}
<p>Nothing to show yet.</p>
{{/items}}
```

Names inside a section resolve against the current item first, then fall back
to the top level — so `{{currency}}` above can live outside `items`. A name a
section body cannot resolve renders empty; it is not reported as missing,
because only the section's own name (`items`) is a caller contract.

A tag name is a run of word characters (or a bare `.`), with no spaces inside
the braces. Anything else — `{{ spaced }}`, `{{user.name}}`, `{{not-a-var}}` —
is left alone as literal text, exactly as before the rewrite, so prose that
happens to contain braces is never mistaken for a variable. Sections may nest
up to 64 levels.

An unbalanced or mismatched section tag is a **parse error**: the request
fails with `400` and a diagnostic naming the offending tag, rather than
sending something half-formed. This affects
`POST /api/email-templates/{slug}/send`,
`GET /api/email-templates/{slug}/variables`, and `POST /api/send/reply/{id}`.
A sequence step whose template does not parse is marked `failed`.

The `variables` payload itself — the JSON you POST, not the template markup —
may nest objects and arrays up to 32 levels deep. A payload nested deeper than
that is rejected with `400` naming the limit, rather than risking a stack
overflow while validating it. This is independent of the 64-level cap on
section nesting above: one bounds the data you send, the other bounds the
template you write.

The template editor's UI understands this grammar too — grouping detected
variables into Required, Optional, and Sections, and rendering a live preview
with sample values in place of the raw tokens — so what you see while editing
matches what a real send does.

## Upgrading: escaping is now the default

Variables were previously substituted raw. They are now HTML-escaped in the
body, so a value containing markup renders as text rather than as HTML. The
subject line is a plain-text header, not HTML, so values substituted there are
passed through unchanged — as they always have been.

**If any of your templates deliberately pass HTML through a variable, change
those tags from `{{key}}` to `{{{key}}}` before upgrading.** Templates whose
variables carry plain text need no change.

One related consequence: because `{{{key}}}` now means raw output, any run of
three or more consecutive braces is read differently than before. `{{{name}}}`
used to render as `{` followed by the substituted value followed by `}`; it is
now an unescaped substitution. This only affects templates that stack braces
against a tag — ordinary `{{key}}` tags in ordinary text are untouched.

This also applies to [sequence sends](sequences.md), which share the same renderer.
Multi-line values still collapse in HTML — use `{{key|nl2br}}`, or wrap the
block in `style="white-space: pre-line"`.

---

**See also:** [Sequences](sequences.md) · [Suppressions and unsubscribe](suppressions.md) for `{{unsubscribe_url}}` · the `/create-saasmail-template` Claude Code skill
