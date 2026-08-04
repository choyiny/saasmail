import { describe, it, expect } from "vitest";
import { interpolate } from "../lib/interpolate";

/**
 * The pre-rewrite implementation, frozen verbatim. The differential test below
 * asserts the new renderer agrees with this on every template shape that can
 * exist in a deployed instance today. Do not "fix" or modernise this copy —
 * its whole value is being the old behavior.
 */
const LEGACY_REGEX = /\{\{(\w+)\}\}/g;
function legacyInterpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(LEGACY_REGEX, (match, key) =>
    key in variables ? variables[key] : match,
  );
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NAMES = ["name", "email", "feature", "date", "time", "url", "x", "y"];
// HTML-free values only: where the two implementations intentionally diverge
// (values containing markup) is covered by the escaping tests, not here.
const VALUES = ["Alice", "", "hi there", "10:00 GMT", "Ada Lovelace", "42"];
const LITERALS = [
  "<p>",
  "</p>",
  " and ",
  "\n",
  "{{",
  "}}",
  "{{not-a-var}}",
  "{{ spaced }}",
  "text",
  "<br/>",
];

function randomTemplate(rand: () => number): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(rand() * 12);
  for (let i = 0; i < n; i++) {
    if (rand() < 0.5) {
      parts.push(LITERALS[Math.floor(rand() * LITERALS.length)]);
    } else {
      parts.push(`{{${NAMES[Math.floor(rand() * NAMES.length)]}}}`);
    }
  }
  return parts.join("");
}

function randomVariables(rand: () => number): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of NAMES) {
    // Some names deliberately left unsupplied so unmatched tags are exercised.
    if (rand() < 0.7) vars[name] = VALUES[Math.floor(rand() * VALUES.length)];
  }
  return vars;
}

describe("interpolate — differential against frozen legacy implementation", () => {
  it("agrees with the legacy renderer on 5000 random flat templates", () => {
    const rand = makeRandom(20260803);
    const mismatches: Array<{ template: string; vars: unknown }> = [];
    for (let i = 0; i < 5000; i++) {
      const template = randomTemplate(rand);
      const vars = randomVariables(rand);
      if (interpolate(template, vars) !== legacyInterpolate(template, vars)) {
        mismatches.push({ template, vars });
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/**
 * The seven templates seeded by `seeds/generate-demo.ts`, rendered with
 * plain-text values. Expected strings were generated from the pre-rewrite
 * implementation. These are what a real deployed instance sends.
 */
const CORPUS_VARS = {
  name: "Ada Lovelace",
  feature: "Scheduled sends",
  date: "Tuesday",
  time: "10:00 GMT",
};

/*
 * Expected strings were captured from the pre-rewrite implementation and are
 * pinned here as literals rather than recomputed from `legacyInterpolate`.
 * Comparing the renderer against a copy of itself would pass even if both were
 * wrong; a literal is an independent check.
 */
const CORPUS: Array<{
  slug: string;
  subject: string;
  body: string;
  expectedSubject: string;
  expectedBody: string;
}> = [
  {
    slug: "intro-followup",
    subject: "Following up on our chat",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>Wanted to follow up on what we discussed and see if you had a chance to think it over.</p>" +
      "<p>Happy to dive deeper into anything that caught your eye — or just answer questions.</p>" +
      "<p>Cheers,<br/>The team</p>",
    expectedSubject: "Following up on our chat",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>Wanted to follow up on what we discussed and see if you had a chance to think it over.</p>" +
      "<p>Happy to dive deeper into anything that caught your eye — or just answer questions.</p>" +
      "<p>Cheers,<br/>The team</p>",
  },
  {
    slug: "re-engagement",
    subject: "Long time no see, {{name}}",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>It's been a while! Things have moved a lot on our end and I thought you might be interested in what we've shipped recently.</p>" +
      "<p>If now's a better time to chat, just hit reply.</p>",
    expectedSubject: "Long time no see, Ada Lovelace",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>It's been a while! Things have moved a lot on our end and I thought you might be interested in what we've shipped recently.</p>" +
      "<p>If now's a better time to chat, just hit reply.</p>",
  },
  {
    slug: "pricing-info",
    subject: "Pricing details for {{name}}",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>Putting together the plan options we discussed. Three tiers depending on volume — happy to walk through which makes sense for your team.</p>" +
      "<p>Quick call this week?</p>",
    expectedSubject: "Pricing details for Ada Lovelace",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>Putting together the plan options we discussed. Three tiers depending on volume — happy to walk through which makes sense for your team.</p>" +
      "<p>Quick call this week?</p>",
  },
  {
    slug: "welcome-onboarding",
    subject: "Welcome to the team, {{name}}",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>Welcome aboard! We're thrilled to have you using the platform.</p>" +
      "<p>A few things to get you started:</p>" +
      "<ul><li>Set up your first inbox under Settings</li>" +
      "<li>Invite your team members</li>" +
      "<li>Connect your domain so DKIM/SPF check out</li></ul>" +
      "<p>Reply if anything trips you up.</p>",
    expectedSubject: "Welcome to the team, Ada Lovelace",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>Welcome aboard! We're thrilled to have you using the platform.</p>" +
      "<p>A few things to get you started:</p>" +
      "<ul><li>Set up your first inbox under Settings</li>" +
      "<li>Invite your team members</li>" +
      "<li>Connect your domain so DKIM/SPF check out</li></ul>" +
      "<p>Reply if anything trips you up.</p>",
  },
  {
    slug: "feature-launch",
    subject: "Just shipped: {{feature}}",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>Quick heads up — we just shipped {{feature}}. You'll see it in your dashboard now.</p>" +
      "<p>Full details on the changelog. Reply if you hit any issues.</p>",
    expectedSubject: "Just shipped: Scheduled sends",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>Quick heads up — we just shipped Scheduled sends. You'll see it in your dashboard now.</p>" +
      "<p>Full details on the changelog. Reply if you hit any issues.</p>",
  },
  {
    slug: "support-followup",
    subject: "Following up on your support request",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>Just checking in on the issue you flagged. Did our last reply resolve it on your end?</p>" +
      "<p>If you're still stuck, ping back and we'll dig in further.</p>",
    expectedSubject: "Following up on your support request",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>Just checking in on the issue you flagged. Did our last reply resolve it on your end?</p>" +
      "<p>If you're still stuck, ping back and we'll dig in further.</p>",
  },
  {
    slug: "meeting-confirm",
    subject: "Confirming our call on {{date}}",
    body:
      "<p>Hi {{name}},</p>" +
      "<p>Confirming our call on {{date}} at {{time}}. Calendar invite is on the way.</p>" +
      "<p>If anything changes, let me know — happy to reschedule.</p>",
    expectedSubject: "Confirming our call on Tuesday",
    expectedBody:
      "<p>Hi Ada Lovelace,</p>" +
      "<p>Confirming our call on Tuesday at 10:00 GMT. Calendar invite is on the way.</p>" +
      "<p>If anything changes, let me know — happy to reschedule.</p>",
  },
];

describe("interpolate — golden corpus from seeds/generate-demo.ts", () => {
  it.each(CORPUS)(
    "renders $slug byte-identically to the pinned pre-rewrite output",
    ({ subject, body, expectedSubject, expectedBody }) => {
      expect(interpolate(subject, CORPUS_VARS)).toBe(expectedSubject);
      expect(interpolate(body, CORPUS_VARS)).toBe(expectedBody);
    },
  );

  it("does not escape apostrophes in the template's own prose", () => {
    // The seeded bodies contain "It's" / "you'll" as literal text. Escaping the
    // output string rather than each substituted value would corrupt them.
    const rendered = interpolate(CORPUS[1].body, CORPUS_VARS);
    expect(rendered).toContain("It's been a while");
    expect(rendered).not.toContain("&#39;");
  });
});
