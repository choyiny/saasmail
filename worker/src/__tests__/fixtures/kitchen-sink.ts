/**
 * One document using every block type, shared by the compile tests and by the
 * golden regenerator (`scripts/regen-block-golden.mts`).
 *
 * Deliberately exercises the awkward cases alongside the simple ones: an
 * aligned paragraph, an image that is both linked and captioned, an ordered
 * list with inline markup, a quote with an attribution, and a `{{variable}}`
 * in three positions — body text, a button label, and inside a URL.
 */
export const KITCHEN_SINK = [
  { id: "h1", type: "heading", data: { level: 1, html: "Monthly digest" } },
  {
    id: "p1",
    type: "paragraph",
    data: {
      html: 'Hi {{first_name}}, here is <b>what changed</b> this month. <a href="https://example.com/changelog">Full changelog</a>.',
    },
  },
  { id: "s1", type: "separator", data: {} },
  {
    id: "h2",
    type: "heading",
    data: { level: 2, html: "Highlights" },
    align: "left",
  },
  {
    id: "l1",
    type: "list",
    data: {
      ordered: true,
      items: [
        "Faster imports",
        "A <b>new</b> editor",
        'Read the <a href="https://example.com/post">post</a>',
      ],
    },
  },
  {
    id: "i1",
    type: "image",
    data: {
      src: "https://cdn.example.com/digest.png",
      alt: "A chart of monthly sends",
      width: "480px",
      href: "https://example.com/stats",
      caption: "Sends per week, last quarter",
    },
  },
  {
    id: "q1",
    type: "quote",
    data: {
      html: "It finally looks like a real newsletter.",
      caption: "A user",
    },
  },
  {
    id: "b1",
    type: "button",
    data: { label: "Open {{plan}}", href: "https://example.com/go/{{token}}" },
  },
  {
    id: "p2",
    type: "paragraph",
    data: {
      html: 'No longer interested? <a href="{{unsubscribe_url}}">Unsubscribe</a>.',
    },
    align: "center",
  },
];
