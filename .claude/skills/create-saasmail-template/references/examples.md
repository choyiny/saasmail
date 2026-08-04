# Worked template examples

Four complete templates, each with the `/variables` contract it produces and a
payload that satisfies it. Every contract below was produced by running the
template through `analyzeTemplate`, so it is what the API will actually report.

Adapt these rather than assembling markup from the rules — the shapes here cover
most of what templates need to do.

## Contents

- [1. Order receipt — line items with an empty state](#1-order-receipt)
- [2. Weekly digest — nested sections](#2-weekly-digest)
- [3. Trial expiry — boolean conditionals and optional values](#3-trial-expiry)
- [4. Sequence step — the lax-path rules](#4-sequence-step)

---

## 1. Order receipt

The core pattern: a repeating table plus the inverted branch for an empty list.
`currency` lives at the top level and is visible inside the loop through scope
fallthrough.

**Subject**

```
Your receipt from {{storeName}}
```

**Body**

```html
<p>Thanks for your order, {{firstName}}.</p>

<table width="100%" cellpadding="8" cellspacing="0">
  {{#items}}
  <tr>
    <td>{{name}}</td>
    <td align="right">{{currency}}{{price}}</td>
  </tr>
  {{/items}} {{^items}}
  <tr>
    <td colspan="2">This order had no billable items.</td>
  </tr>
  {{/items}}
  <tr>
    <td><strong>Total</strong></td>
    <td align="right"><strong>{{currency}}{{total}}</strong></td>
  </tr>
</table>

{{#note?}}
<div style="white-space: pre-line; color: #666">{{note}}</div>
{{/note}}
```

**Contract**

```json
{
  "variables": ["storeName", "firstName", "items", "currency", "total"],
  "optional": ["note"],
  "sections": [
    {
      "name": "items",
      "inverted": false,
      "variables": ["name", "currency", "price"]
    },
    { "name": "note", "inverted": false, "variables": ["note"] }
  ]
}
```

`currency` appears in both lists: required at the top level (the totals row uses it
outside any section) and listed under `items` because the loop body references it
too. A name in `sections[].variables` is not automatically item-scoped — it is
simply a name that body mentions, wherever it ends up resolving.

**Payload**

```json
{
  "storeName": "Acme",
  "firstName": "Ada",
  "currency": "$",
  "total": "18.00",
  "items": [
    { "name": "Widget", "price": "9.00" },
    { "name": "Sprocket", "price": "9.00" }
  ],
  "note": "Ships Tuesday.\nTracking follows."
}
```

Send it once with `"items": []` too — that is the branch nobody exercises.

The `?` is a property of the opening tag, not part of the name, so `{{#note?}}`
closes with `{{/note}}`. (A stray `{{/note?}}` also parses, since only the name is
matched, but it reads as though optionality were something you close — write
`{{/note}}`.)

## 2. Weekly digest

Nested sections. Each inner name resolves against its own item first, then falls
back outward — `{{siteName}}` is top-level yet readable from two levels deep.

**Subject**

```
{{siteName}} — what happened this week
```

**Body**

```html
<h1>This week on {{siteName}}</h1>

{{#categories}}
<h2>{{title}}</h2>
{{#posts}}
<p><a href="{{url}}">{{headline}}</a> — {{author}}</p>
{{/posts}} {{^posts}}
<p>Nothing new in {{title}} this week.</p>
{{/posts}} {{/categories}} {{^categories}}
<p>A quiet week — nothing to report.</p>
{{/categories}}
```

**Contract**

```json
{
  "variables": ["siteName", "categories"],
  "optional": [],
  "sections": [
    {
      "name": "categories",
      "inverted": false,
      "variables": ["title", "posts", "url", "headline", "author"]
    }
  ]
}
```

`sections[].variables` is flattened across every depth beneath the section, so
`url`/`headline`/`author` appear there even though they belong to `posts` items,
not to a category. Use it as a checklist of names the payload should provide
_somewhere_ under that section, not as a per-item schema.

`posts` produces no top-level section entry of its own and is never required — it
lives inside `categories`. A category object without a `posts` key simply takes the
`{{^posts}}` branch.

**Payload**

```json
{
  "siteName": "Acme Blog",
  "categories": [
    {
      "title": "Engineering",
      "posts": [
        {
          "url": "https://acme.dev/a",
          "headline": "Shipping faster",
          "author": "Ada"
        }
      ]
    },
    { "title": "Design", "posts": [] }
  ]
}
```

## 3. Trial expiry

Booleans as sections, and values the caller may legitimately not have.

**Subject**

```
{{firstName}}, your trial ends in {{daysLeft}} days
```

**Body**

```html
<p>Hi {{firstName}},</p>

{{#isPaidPlan}}
<p>You are already on {{planName}} — nothing to do.</p>
{{/isPaidPlan}} {{^isPaidPlan}}
<p>Your trial ends in {{daysLeft}} days.</p>
<p><a href="{{upgradeUrl}}">Choose a plan</a></p>
{{/isPaidPlan}} {{#discountCode?}}
<p>Use code <strong>{{discountCode}}</strong> for 20% off.</p>
{{/discountCode}}
```

**Contract**

```json
{
  "variables": ["firstName", "daysLeft", "isPaidPlan"],
  "optional": ["discountCode"],
  "sections": [
    {
      "name": "isPaidPlan",
      "inverted": false,
      "variables": ["planName", "daysLeft", "upgradeUrl"]
    },
    { "name": "discountCode", "inverted": false, "variables": ["discountCode"] }
  ]
}
```

Two things worth noticing, both of which contradict a reasonable guess.

**`isPaidPlan` is required**, even though the `{{^isPaidPlan}}` half exists to handle
its absence. A name inverted in one place and regular in another is required —
required always wins. If you want the "no such key" case to be legal, every
occurrence must be inverted, or the regular one must be written `{{#isPaidPlan?}}`.

**`upgradeUrl` is absent from every list, yet the send still fails without it.**
It sits inside `{{^isPaidPlan}}`, and an inverted section pushes no per-item
scope — so the name is really a top-level lookup. The analyzer cannot see that
statically (it does not know what value `isPaidPlan` will receive), so
`/variables` omits it; the renderer _can_ see it, so a send that omits it returns
`{"missingVariables": ["upgradeUrl"]}` instead of mailing `<a href="">`.

Take the lesson, not the list: **`/variables` is the static contract, and it is a
lower bound.** A section body can require more than it advertises. That is why the
workflow ends with a test send rather than with reading `/variables`.

`planName` behaves the same way — `{{#isPaidPlan}}` given `true` is scalar, so it
pushes no scope either, and omitting `planName` fails the send. Had `isPaidPlan`
been an array of objects, the identical template would treat `planName` as a
per-item field and render it empty without complaint. If you want the blank to be
deliberate rather than an error, mark it optional (`{{planName?}}`) or guard it
with an inner section:

```html
{{#isPaidPlan}}
<p>
  You are already on{{#planName}} {{planName}}{{/planName}} — nothing to do.
</p>
{{/isPaidPlan}}
```

**Payload**

```json
{
  "firstName": "Ada",
  "daysLeft": 3,
  "upgradeUrl": "https://acme.dev/upgrade",
  "isPaidPlan": false
}
```

`daysLeft: 0` would render "ends in 0 days" from a `{{daysLeft}}` tag — but a
`{{#daysLeft}}` section would treat `0` as falsy and skip. Numbers that can be zero
are a classic section bug.

## 4. Sequence step

Templates used as sequence steps render under different rules: no required-variable
validation, so an unsupplied top-level name is mailed to the recipient as the
literal text `{{name}}`. Write defensively.

**Subject**

```
Welcome to {{productName?}}
```

**Body**

```html
<p>Hi {{name}},</p>
<p>Thanks for signing up with {{email}}.</p>

{{#firstProjectUrl?}}
<p><a href="{{firstProjectUrl}}">Pick up where you left off</a></p>
{{/firstProjectUrl}}

<p style="font-size: 12px; color: #666">
  <a href="{{unsubscribe_url}}">Unsubscribe</a>
</p>
```

**Contract**

```json
{
  "variables": ["name", "email", "unsubscribe_url"],
  "optional": ["productName", "firstProjectUrl"],
  "sections": [
    {
      "name": "firstProjectUrl",
      "inverted": false,
      "variables": ["firstProjectUrl"]
    }
  ]
}
```

Read that as a warning label, not a contract: on the sequence path nothing enforces
`variables`, which is precisely why this template can get away with a bare
`{{unsubscribe_url}}` that would fail every direct send.

Rules this template is obeying:

- **`{{name}}` and `{{email}}` need no `?`.** Sequence sends always merge them in
  from the person record before rendering (enrollment variables of the same name
  override them).
- **Everything else carries `?`.** `productName` and `firstProjectUrl` come from the
  enrollment's `variables`, which nothing validates — without `?` an enrollment that
  omitted them would mail `{{productName}}` verbatim.
- **`{{unsubscribe_url}}` is used bare, and only here.** On the sequence path the
  renderer leaves the unresolved tag in place and the send pipeline swaps in the
  per-recipient URL, which is how you control where the link sits. Put that same tag
  in a template sent through `POST /api/email-templates/{slug}/send` and every send
  fails with `missingVariables: ["unsubscribe_url"]` — there, omit it entirely and
  let the footer auto-append.

A template used on _both_ paths cannot mention `{{unsubscribe_url}}`. Keep the
sequence version separate, or drop the tag and accept the appended footer.
