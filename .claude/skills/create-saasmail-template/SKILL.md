---
name: create-saasmail-template
description: Write, validate, and create email templates for a saasmail instance — the full `{{variable}}` interpolation grammar, conditional/repeating `{{#section}}` rendering, HTML escaping, and the required-vs-optional send contract. Use this skill whenever the user is authoring or editing a saasmail email template, or asks anything about template markup: "add a welcome email template", "loop over line items in the email", "show this block only if they have a trial", "why does my send say missing required variables", "how do I stop the HTML in this variable from being escaped", "make this template handle an empty list". Also use it when the user is designing a sequence's step templates, since sequence sends interpolate under different (laxer, more dangerous) rules than direct template sends.
---

# Creating saasmail email templates

A template is a stored `subject` + `bodyHtml` pair rendered against caller-supplied
variables at send time. The renderer is Mustache-_flavored_ but deliberately not
Mustache — it is a small, strict grammar in `worker/src/lib/interpolate.ts`, and
the differences are where mistakes happen.

Writing a template is really writing a **contract**: the tags you use decide which
variable names every future caller must supply, and a caller that misses one gets
a `400` instead of an email. Design that contract on purpose.

To _send_ mail, enroll people in sequences, or manage API keys, use `/use-saasmail`
instead — this skill is about authoring the template itself.

## Workflow

1. **Decide the contract first.** For each piece of dynamic content, decide whether
   the caller must always supply it (`{{key}}`), might omit it (`{{key?}}`), or
   whether it is a list/conditional block (`{{#key}}`). Getting this wrong is the
   single most common failure — see "The send contract" below.
2. **Write the markup.** Email HTML, with tags from the grammar table.
3. **Create it** via `POST /api/email-templates`, or in the UI at `/templates/new`
   (which shows the detected variables and a live preview as you type). A template
   whose tags do not parse is rejected at write time with a diagnostic naming the
   offending tag — you cannot store a broken one.
4. **Verify the contract** with `GET /api/email-templates/{slug}/variables`. Confirm
   the `variables` list matches what the caller actually passes — this is the check
   that catches a mistyped or accidentally-required name before it reaches
   production.
5. **Test-send** to a real address and look at the result in a mail client.

Never skip step 4. The analyzer's answer, not your reading of the template, is what
the send path enforces.

## The grammar

A tag is `{{` or `{{{`, an optional sigil, a name, an optional `?`, zero or more
`|filter` clauses, and a matching close of the same brace count.

| Tag                  | Behavior                                                        |
| -------------------- | --------------------------------------------------------------- |
| `{{key}}`            | Value. HTML-escaped in the body; plain text in the subject      |
| `{{{key}}}`          | Value, unescaped — for pre-rendered HTML you trust              |
| `{{key?}}`           | Optional. Renders empty when absent instead of failing the send |
| `{{key\|nl2br}}`     | Escaped, then newlines become `<br>`                            |
| `{{#key}}…{{/key}}`  | Renders if truthy; iterates if the value is an array            |
| `{{#key?}}…{{/key}}` | Same, but absence does not fail the send                        |
| `{{^key}}…{{/key}}`  | Renders only if falsy, absent, or an empty array                |
| `{{.}}`              | The current item, inside an array-of-strings section            |

**A name is `\w+` (letters, digits, underscore) or a bare `.`, with no whitespace
anywhere inside the braces.** Anything that does not match is left alone as literal
text — `{{ spaced }}`, `{{user.name}}`, `{{not-a-var}}`, and `{{}}` all render
verbatim and are not variables. This strictness is a feature: prose and CSS that
happen to contain braces can never be silently promoted into a required variable
that starts rejecting every send.

There are no dotted paths. `{{user.name}}` is _text_, not a lookup — reach nested
data with a section (`{{#user}}{{name}}{{/user}}`) instead.

The only filter that exists is `nl2br`. Any other name — `{{x|upper}}`,
`{{x|toString}}` — is a parse error that rejects the template at write time.

Only the name is matched when closing, so `{{#key?}}` closes with `{{/key}}` — the
`?` and any filters belong to the opening tag.

## The send contract: required vs optional vs section

`analyzeTemplate` walks the subject and body and produces the three lists that
`GET /{slug}/variables` returns and the send path enforces:

- **`variables` (required)** — every top-level `{{key}}` and every regular
  `{{#key}}` section name. A send missing any of these fails with `400`,
  `missingVariables`, and `requiredVariables`. Nothing is mailed.
- **`optional`** — `{{key?}}`, `{{#key?}}`, and inverted `{{^key}}` names. Absent,
  they render empty.
- **`sections`** — each section's name, whether it is inverted, and the names its
  body references.

Four rules follow from this, each of which is commonly guessed backwards:

**A regular section name is required.** `{{#items}}` absent does not render an
empty list — it fails the send. That is deliberate: a digest whose `items` the
caller forgot to pass would otherwise go out silently empty, which is worse than a
`400`. If absence is legitimate, write `{{#items?}}`.

**Names inside a section body never appear in `variables`.** They are expected to
resolve against the current item at render time, so the caller does not supply them
at the top level, and an unresolvable one renders **empty** rather than mailing a
literal `{{token}}` to a customer.

But "inside a section" is narrower than it looks, and the difference is the
sharpest thing in the grammar. A section only creates a per-item scope when its
value is an **array or an object**. An inverted `{{^key}}` section, and a regular
`{{#key}}` section given a boolean or other scalar, render their bodies against the
unchanged top level — so names in _those_ bodies are ordinary top-level lookups.

The send path treats the two cases differently, and correctly:

- **Under an iterating section**, an unresolved name renders empty and is not an
  error. Items legitimately differ in which optional fields they carry.
- **Under a scope-less section** (inverted, or scalar-valued), an unresolved name
  is a caller error and **fails the send** with that name in `missingVariables`.
  `{{^isPaidPlan}}<a href="{{upgradeUrl}}">` with no `upgradeUrl` supplied returns
  400 rather than mailing `<a href="">`.

One asymmetry to know: that second check is dynamic, so those names do **not**
appear in `/variables` — the analyzer cannot tell statically whether a section
will receive an array or a boolean. `/variables` is the static contract; the send
catches the rest. A test send with a realistic payload is still the only way to
prove a section body is right, and a typo inside an iterating body (`{{prcie}}`)
remains silent by design.

**Required wins over optional, and `#` wins over `^`.** If a name appears as both
`{{a}}` and `{{a?}}`, it is required. If it appears as both `{{^promo}}` and
`{{#promo}}`, the section is required and reported as non-inverted — a section is
only treated as an absence-branch when _every_ occurrence of it is inverted.

**Supplying a name satisfies it, whatever the value.** The check is "did the caller
pass this key", not "is it non-empty". `{"name": null}` passes validation and
renders an empty string. Callers cannot be forced to send meaningful content — only
to acknowledge the field.

## Conditional and repeating rendering

A section's value decides whether the body renders and how many times.

| Value                                    | `{{#key}}`                | `{{^key}}` |
| ---------------------------------------- | ------------------------- | ---------- |
| Non-empty array                          | renders once per item     | skipped    |
| Empty array `[]`                         | skipped                   | renders    |
| Object                                   | renders once, item scoped | skipped    |
| `true`, non-empty string, nonzero number | renders once              | skipped    |
| `false`, `""`, `0`, `null`, absent       | skipped                   | renders    |

Note `0` and `""` are falsy. `{{#count}}You have {{count}}{{/count}}` renders
nothing when the count is zero — usually what you want, but check it is.

**The empty-state pattern** is a `#`/`^` pair on the same name:

```html
{{#items}}
<tr>
  <td>{{name}}</td>
  <td>{{currency}}{{price}}</td>
</tr>
{{/items}} {{^items}}
<tr>
  <td colspan="2">Nothing to show yet.</td>
</tr>
{{/items}}
```

Because `{{#items}}` is required and `{{^items}}` is optional, that pair reports
`items` as **required** overall — the caller must pass the list (possibly `[]`), and
the empty case renders the fallback row.

**Scope falls through.** Inside a section, a name is looked up on the current item
first, then on each enclosing scope, out to the top level. So `{{currency}}` above
can live at the top level while `{{name}}` and `{{price}}` come from each item.
Only own properties resolve — `{{constructor}}`, `{{toString}}` and friends never
pick up JavaScript built-ins.

**Arrays of strings use `{{.}}`:**

```html
{{#tags}}<span class="tag">{{.}}</span>{{/tags}}
```

**A truthy scalar renders the body once without pushing scope**, which makes
`{{#isTrial}}…{{/isTrial}}` a plain boolean conditional whose body still sees every
top-level variable.

Sections nest (up to 64 levels; exceeding that is a parse error). Inner sections
resolve against the item they are nested in, falling back outward as above.

## Escaping, raw output, and the subject line

Values substituted into the **body** are HTML-escaped: `&`, `<`, `>`, `"`, and `'`
become entities. This is the default because template values routinely carry
user-typed content, and an email signed by your own domain is the last place you
want that content introducing tags.

**Escaping those five characters is the whole guarantee — it is not a
sanitizer.** Two gaps matter when you place a tag:

- **Quote every attribute.** `<a href="{{url}}">` is safe; `<a href={{url}}>` is
  not, because a space is not escaped. `url = "# onmouseover=alert(1)"` renders
  `<a href=# onmouseover=alert(1)>` — a handler injected through the _escaped_
  form.
- **Escaping is not a URL check.** `<a href="{{url}}">` with
  `url = "javascript:alert(1)"` passes through untouched; there is no scheme
  allowlist. If a URL can come from an end user, validate the scheme before you
  pass it in. (Inbox signatures go through `sanitize-signature.ts`, which strips
  `javascript:` and `vbscript:`; the template renderer applies no such filter.)

`{{{key}}}` opts a single value out, for HTML you produced yourself and trust — a
pre-rendered block, a sanitized rich-text field. Never wrap a value that originated
from an end user in triple braces.

The **subject** is a plain-text header, not HTML, so it is never escaped: `{{key}}`
and `{{{key}}}` are equivalent there, and a name like `O'Brien` arrives intact
rather than as `O&#39;Brien`. HTML-emitting filters are skipped in the subject, so
`{{note|nl2br}}` in a subject leaves the newlines alone instead of printing a
literal `<br>` at the recipient.

**Non-scalar values render empty.** If `{{items}}` holds an array or object, the
tag produces an empty string — not `[object Object]`, and not the list. Rendering a
collection requires a section. A blank spot where a list should be almost always
means a scalar tag was used on an array.

**Multi-line values collapse in HTML.** Use `{{key|nl2br}}`, or wrap the block:

```html
<div style="white-space: pre-line">{{message}}</div>
```

Filters run _after_ escaping, so `{{key|nl2br}}` is safe on user content: the value
is escaped first, then its newlines become `<br>`.

## Two behaviors specific to a send path

**`{{unsubscribe_url}}` behaves differently per path.** The send pipeline
substitutes a per-recipient unsubscribe URL into the rendered HTML, and appends a
minimal footer if the URL is not already present.

- On `POST /api/email-templates/{slug}/send`, the template renderer runs _first_
  and treats `{{unsubscribe_url}}` as an ordinary required variable — so a template
  containing it fails every send with `missingVariables: ["unsubscribe_url"]`.
  **Leave it out of templates sent this way** and let the footer auto-append.
- On sequence steps, the renderer does not enforce required names, so an unsupplied
  `{{unsubscribe_url}}` survives verbatim and the pipeline replaces it in place —
  which is how you control where the link sits in a drip email.

**Sequence sends do not validate required variables at all.** They interpolate
directly: any top-level name the enrollment did not supply renders as the literal
text `{{foo}}` _in the delivered email_. There is no `400` to catch it. So in a
template destined for a sequence step, mark everything not guaranteed as
`{{foo?}}`. Sequences do always provide `name` and `email` from the person record
(enrollment variables of the same name win), so `{{name}}` and `{{email}}` are safe
there.

## Creating the template

`POST /api/email-templates`, `application/json`, `Authorization: Bearer sk_…`:

```bash
curl -X POST "$SAASMAIL_URL/api/email-templates" \
  -H "Authorization: Bearer $SAASMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "order-receipt",
    "name": "Order receipt",
    "subject": "Your receipt from {{storeName}}",
    "bodyHtml": "<p>Thanks, {{firstName}}!</p>{{#items}}<p>{{name}} — {{price}}</p>{{/items}}{{^items}}<p>No items.</p>{{/items}}",
    "fromAddress": "noreply@yourdomain.com"
  }'
```

- `slug` must match `^[a-z0-9-]+$` and is the send-time identifier. It is unique
  and not rewritable by `PUT`; choose it deliberately.
- `fromAddress` scopes the template to an inbox and must be one the caller is
  allowed to send from. `null` makes the template global, which only admins may do
  — members get `403 "from_address is required for members"`.
- There is no `bodyText` field. Templates are HTML-only; the plain-text part is
  handled by the send pipeline.

Update with `PUT /api/email-templates/{slug}` (all fields optional). The template is
re-validated _as it will exist after the merge_, so editing only the subject can
still be rejected for a section left unbalanced across the pair.

### Verify, then test-send

```bash
curl -H "Authorization: Bearer $SAASMAIL_KEY" \
  "$SAASMAIL_URL/api/email-templates/order-receipt/variables"
# → { "variables": ["storeName","firstName","items"],
#     "optional": [],
#     "sections": [{"name":"items","inverted":false,"variables":["name","price"]}] }
```

Read that back against the caller you are writing. `sections[].variables` tells you
the shape of each item — here, `items` must be an array of objects with `name` and
`price`. Then send one to yourself:

```bash
curl -X POST "$SAASMAIL_URL/api/email-templates/order-receipt/send" \
  -H "Authorization: Bearer $SAASMAIL_KEY" -H "Content-Type: application/json" \
  -d '{"to":"you@example.com","fromAddress":"noreply@yourdomain.com",
       "variables":{"storeName":"Acme","firstName":"Ada",
                    "items":[{"name":"Widget","price":"$9"}]}}'
```

Exercise the empty case too (`"items": []`) — the inverted branch is the half
nobody tests.

The `variables` payload may nest objects and arrays up to **32** levels deep; deeper
is rejected with `400`. (Independent of the 64-level cap on section nesting: one
bounds the data you send, the other the template you write.)

## Failure modes

| Symptom                                     | Cause                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` on create/update naming a tag         | Unbalanced/mismatched section or unknown filter. Messages are exact: `Unclosed section {{#a}} — add a matching {{/a}}.`, `{{/b}} does not match the open section {{#a}}.`, `Unexpected {{/a}} — no section is open here.` |
| `400 "Missing required template variables"` | Caller omitted a name in `variables`. The body lists `missingVariables` and `requiredVariables` — reconcile against `/variables`.                                                                                         |
| Literal `{{key}}` in a delivered email      | A sequence step whose enrollment omitted that variable. Direct template sends can't do this; they `400` first.                                                                                                            |
| A blank where a list should be              | A scalar `{{items}}` used on an array. Use a section.                                                                                                                                                                     |
| A blank inside a repeated block             | A name the item does not have (often a typo). Only _iterating_ sections blank silently; under an inverted or boolean section the same miss fails the send.                                                                |
| Escaped markup visible to the recipient     | Value carries HTML but the tag is `{{key}}`. Use `{{{key}}}` — only if the value is trusted.                                                                                                                              |
| `400` naming a render limit                 | A section nested inside itself: the inner tag re-resolves to the same top-level value and re-iterates it, so work grows as N^depth. Restructure so the inner section uses a different name.                               |
| Sequence step silently never arrives        | Its template does not parse; the step is marked `failed` and never retried. Write-time validation prevents this for templates created through the API.                                                                    |

## Changing a live template

Adding a required tag to a template that is already in production breaks every
caller that has not been updated — their next send `400`s. Either deploy the caller
first, or introduce the name as `{{key?}}`, backfill the callers, and tighten it to
`{{key}}` afterward. Removing a tag is always safe; extra variables in a payload are
ignored.

## Worked examples

`references/examples.md` has four complete, copy-ready templates — a receipt with a
line-item table and empty state, a digest with nested sections, a trial-expiry notice
driven by boolean conditionals, and a sequence step written for the lax path — each
with the `/variables` contract it actually produces and a payload that satisfies it.
Read it when you want a working shape to adapt rather than assembling one from the
rules above.

## Source of truth

If any behavior here seems wrong, the code decides:

- `worker/src/lib/interpolate.ts` — grammar, rendering, `analyzeTemplate`
- `worker/src/routers/email-templates-router.ts` — CRUD, write-time validation, `/variables`
- `worker/src/lib/send-template.ts` — the strict send path
- `worker/src/lib/sequence-processor.ts` — the lax sequence path
- `worker/src/lib/send.ts` — unsubscribe URL substitution and footer
