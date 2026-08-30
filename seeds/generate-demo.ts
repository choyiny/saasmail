/**
 * Generate seeds/demo.sql with realistic demo data for givefeedback.dev —
 * a SaaS that turns client feedback sessions into dev-ready tasks.
 *
 *   - 5 inboxes: onboarding@, projects@, marketing@ (automated senders),
 *     support@ and mahmoud@ (human inboxes, each with a signature)
 *   - 100 customer contacts (agencies, studios, product teams)
 *   - 600-900 inbound emails (varied length, varied subject, ~25% unread)
 *   - 80-150 sent replies
 *   - CC roster (~20% of emails) + 5 roster-change demo threads
 *   - Attachments on ~15% of inbound emails (real fake fixtures)
 *   - Branded email templates + drip sequences that tell the product story
 *
 * Run:  npx tsx seeds/generate-demo.ts
 * Then: yarn db:seed:dev
 */
import { createHash } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Reproducible RNG so re-runs give the same dataset.
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = makeRng(1759);
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}
function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  while (n > 0 && copy.length) {
    result.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
    n--;
  }
  return result;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function chance(p: number): boolean {
  return rand() < p;
}
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Inboxes — the five addresses givefeedback.dev sends and receives from.
//
//   onboarding@ · projects@ · marketing@  → automated / templated senders
//   support@ · mahmoud@                   → human inboxes, each carries a
//                                            personal signature.
//
// Signatures are authored WITHOUT inline styles on purpose: the product's
// signature sanitizer strips `style` attributes on save, so plain tags are
// what a real admin ends up with.
// ---------------------------------------------------------------------------
const SUPPORT_SIGNATURE =
  "<p><strong>GiveFeedback Support</strong></p>" +
  "<p>We usually reply within a few hours.<br/>" +
  '<a href="https://givefeedback.dev/docs">Docs</a> &middot; ' +
  '<a href="https://givefeedback.dev">givefeedback.dev</a></p>';

const MAHMOUD_SIGNATURE =
  "<p><strong>Mahmoud Halat</strong><br/>Founder, GiveFeedback</p>" +
  '<p><a href="https://givefeedback.dev">givefeedback.dev</a> &middot; ' +
  '<a href="https://spaceandstory.co">spaceandstory.co</a></p>';

interface Inbox {
  email: string;
  display: string;
  signature?: string;
}

const INBOXES: Inbox[] = [
  { email: "onboarding@givefeedback.dev", display: "GiveFeedback Onboarding" },
  { email: "projects@givefeedback.dev", display: "GiveFeedback Projects" },
  { email: "marketing@givefeedback.dev", display: "GiveFeedback Updates" },
  {
    email: "support@givefeedback.dev",
    display: "GiveFeedback Support",
    signature: SUPPORT_SIGNATURE,
  },
  {
    email: "mahmoud@givefeedback.dev",
    display: "Mahmoud Halat",
    signature: MAHMOUD_SIGNATURE,
  },
];

// Inboxes that receive inbound customer mail. onboarding@ is outbound-only —
// it only sends the branded welcome / first-steps templates, so nobody
// "emails onboarding@" and it's excluded from the inbound generator.
const INBOUND_INBOXES = INBOXES.filter(
  (i) => i.email !== "onboarding@givefeedback.dev",
);

// ---------------------------------------------------------------------------
// Name + domain pools (stay short — total combos are still huge)
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  "Alice",
  "Bob",
  "Carla",
  "Dan",
  "Eve",
  "Frank",
  "Grace",
  "Henry",
  "Iris",
  "Jack",
  "Kim",
  "Leo",
  "Maya",
  "Noah",
  "Olivia",
  "Pavel",
  "Quinn",
  "Rosa",
  "Sam",
  "Tara",
  "Uma",
  "Victor",
  "Wendy",
  "Xavier",
  "Yuki",
  "Zane",
  "Amir",
  "Bella",
  "Caleb",
  "Diana",
  "Emil",
  "Faye",
  "Gabriel",
  "Hana",
  "Idris",
  "Jana",
  "Karim",
  "Lena",
  "Marcus",
  "Nadia",
  "Owen",
  "Priya",
  "Rafael",
  "Sofia",
  "Tariq",
  "Vera",
  "Will",
  "Yara",
  "Zaid",
  "Anya",
  "Bruno",
  "Chloe",
  "Diego",
  "Elsa",
  "Felix",
  "Gemma",
  "Hugo",
  "Indra",
  "Julian",
  "Kira",
  "Lucas",
  "Mira",
  "Nico",
  "Omar",
  "Petra",
  "Reina",
  "Said",
  "Tina",
  "Ulrich",
  "Vivi",
  "Wei",
  "Xiu",
  "Yannis",
  "Zara",
];
const LAST_NAMES = [
  "Nguyen",
  "Martinez",
  "Schmidt",
  "Park",
  "Johansson",
  "Liu",
  "Okafor",
  "Wayne",
  "Chen",
  "Prince",
  "Novak",
  "Patel",
  "Tanaka",
  "Kowalski",
  "Singh",
  "Rossi",
  "Garcia",
  "Khan",
  "Müller",
  "Andersson",
  "Iyer",
  "Reyes",
  "Diaz",
  "Cohen",
  "Abadi",
  "Fischer",
  "Yamamoto",
  "O'Brien",
  "Walsh",
  "Cruz",
  "Brennan",
  "Yusupov",
  "Santos",
  "Petrov",
  "Nakamura",
  "Kim",
  "Bauer",
  "Volkov",
  "Hassan",
  "Ferreira",
  "Lindgren",
  "Mendez",
  "Sato",
];
// Customers of givefeedback.dev — agencies, studios, and product teams who
// embed the feedback widget on the sites they build for their clients.
const DOMAINS = [
  "pixelcraft.studio",
  "northlight.agency",
  "brightfold.co",
  "forgeworks.dev",
  "oakhouse.design",
  "tandemlabs.io",
  "meridian.studio",
  "driftwood.agency",
  "cascadeapp.co",
  "loomandlens.com",
  "hearthside.dev",
  "sablecreative.co",
  "novaworks.io",
  "quietwolf.studio",
  "makersyard.com",
  "verdant.design",
];

// ---------------------------------------------------------------------------
// CC pools — internal team uses our own domain, external collaborators
// pull from existing DOMAINS plus a couple of new business domains.
// ---------------------------------------------------------------------------
type CcEntry = { email: string; name?: string | null };

const INTERNAL_TEAM: CcEntry[] = [
  { email: "mahmoud@givefeedback.dev", name: "Mahmoud Halat" },
  { email: "support@givefeedback.dev", name: "GiveFeedback Support" },
  { email: "nadia@givefeedback.dev", name: "Nadia Reyes" },
  { email: "owen@givefeedback.dev", name: "Owen Walsh" },
  { email: "priya@givefeedback.dev", name: "Priya Iyer" },
];

const EXTERNAL_COLLABORATORS: CcEntry[] = [
  { email: "carla.martinez@pixelcraft.studio", name: "Carla Martinez" },
  { email: "bob.schmidt@northlight.agency", name: "Bob Schmidt" },
  { email: "rosa.garcia@brightfold.co", name: "Rosa Garcia" },
  { email: "henry.wayne@forgeworks.dev", name: "Henry Wayne" },
  { email: "kim.chen@tandemlabs.io", name: "Kim Chen" },
  { email: "olivia.prince@meridian.studio", name: "Olivia Prince" },
  { email: "tariq.khan@oakhouse.design", name: "Tariq Khan" },
  { email: "priya.singh@driftwood.agency", name: "Priya Singh" },
  { email: "marcus.cohen@cascadeapp.co", name: "Marcus Cohen" },
  { email: "yuki.sato@loomandlens.com", name: "Yuki Sato" },
];

// ---------------------------------------------------------------------------
// GROUP_THREADS — explicit multi-participant fixtures. Each one becomes a
// chain of inbound + outbound messages stamped with the same conversation_id.
//
// `from` = index into `externals` for an inbound message, or "us" for an
// outbound reply from our team. `roster` overrides who's CC'd on THIS
// specific message; default roster = all other externals + internalCcs.
// ---------------------------------------------------------------------------
type GroupExternal = { email: string; name: string };
type GroupMessage = {
  from: number | "us";
  text: string;
  daysAgo: number;
  roster?: number[]; // indexes into externals to CC on this message specifically
};
type GroupThread = {
  inbox: string;
  externals: GroupExternal[];
  internalCcs: string[]; // emails picked from INTERNAL_TEAM
  subject: string;
  messages: GroupMessage[];
};

const GROUP_THREADS: GroupThread[] = [
  // 1) Support bug — Safari click capture (dev + PM + designer)
  {
    inbox: "support@givefeedback.dev",
    externals: [
      { email: "elena.varga@pixelcraft.studio", name: "Elena Varga" },
      { email: "tomas.reiner@pixelcraft.studio", name: "Tomas Reiner" },
      { email: "fiona.boyle@pixelcraft.studio", name: "Fiona Boyle" },
    ],
    internalCcs: ["mahmoud@givefeedback.dev", "nadia@givefeedback.dev"],
    subject: "Clicks not captured in Safari replays",
    messages: [
      {
        from: 0,
        text: "Our client records their feedback in Safari and the replays are missing every click — voice and screen are fine, but the cursor never lands anywhere. Chrome sessions look perfect. Looping in Tomas, who set up the embed.",
        daysAgo: 12,
      },
      {
        from: 1,
        text: "Embed is the standard one-line tag in our root layout, nothing custom. It reproduces on Safari 17.0 and 17.1, both desktop and iPad. Happy to share a session ID.",
        daysAgo: 12,
      },
      {
        from: "us",
        text: "Thanks both — this looks like Safari dropping pointer events when the recorder runs inside a cross-origin iframe. Pulling a fix now. Quick check: is the widget embedded directly on the page, or inside an iframe'd preview?",
        daysAgo: 11,
      },
      {
        from: 1,
        text: "Directly on the page for production, but our client reviews inside a staging preview that is iframed. That would explain why our own tests passed.",
        daysAgo: 11,
      },
      {
        from: "us",
        text: "That's the one. We're shipping a patch that captures pointer events on the parent frame for Safari. Should land in tomorrow's widget release — no code change needed on your end, just a hard refresh.",
        daysAgo: 9,
      },
      {
        from: 2,
        text: "Hi all — Fiona from the design side, just looped in. Once this is fixed, will the older sessions that missed clicks get them back, or only new recordings?",
        daysAgo: 9,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "Only new recordings, unfortunately — the click data was never captured for the old ones. Everything from the patched release forward will be complete.",
        daysAgo: 8,
        roster: [0, 1, 2],
      },
      {
        from: 0,
        text: "Confirmed the new release captures clicks in the iframe'd preview now. Thanks for the quick turnaround — closing this on our side.",
        daysAgo: 7,
        roster: [0, 1, 2],
      },
    ],
  },
  // 2) Sales — agency team rollout + white-label
  {
    inbox: "mahmoud@givefeedback.dev",
    externals: [
      { email: "harriet.cole@northlight.agency", name: "Harriet Cole" },
      { email: "darius.weiss@northlight.agency", name: "Darius Weiss" },
    ],
    internalCcs: ["nadia@givefeedback.dev"],
    subject: "Rolling GiveFeedback out across our client sites",
    messages: [
      {
        from: 0,
        text: "We run about 30 active client sites and want GiveFeedback on all of them. Two questions before we commit: is pricing per-project or per-seat, and can the widget be lightly white-labeled so it reads as ours to the client? Darius runs our ops.",
        daysAgo: 14,
      },
      {
        from: "us",
        text: "Great to hear it, Harriet. Pricing is per-project with unlimited viewers, so 30 sites is 30 projects regardless of how many of your people log in. White-label (your logo + accent on the widget) is on the Studio plan.",
        daysAgo: 14,
      },
      {
        from: 1,
        text: "Ops question: when we hand a project off to a client at the end of an engagement, can we transfer ownership without losing the session history?",
        daysAgo: 13,
      },
      {
        from: "us",
        text: "Yes — projects can be transferred to another account and the full session + task history goes with them. We can also keep a read-only archive on your side if you want continuity.",
        daysAgo: 13,
      },
      {
        from: 0,
        text: "That's exactly what we needed. Adding Darius to finalize — he'll set up the billing and the first ten projects this week.",
        daysAgo: 11,
        roster: [0, 1],
      },
      {
        from: "us",
        text: "Perfect. I'll send the Studio plan link and a short white-label setup guide. Ping me directly if anything's unclear during the first rollout.",
        daysAgo: 11,
        roster: [0, 1],
      },
      {
        from: 1,
        text: "First ten projects are live and the logo swap looks clean. We'll bring the rest over next sprint.",
        daysAgo: 8,
        roster: [0, 1],
      },
    ],
  },
  // 3) Support feature request — task export to Linear
  {
    inbox: "support@givefeedback.dev",
    externals: [
      { email: "rajiv.kapur@tandemlabs.io", name: "Rajiv Kapur" },
      { email: "sienna.holt@tandemlabs.io", name: "Sienna Holt" },
      { email: "noor.haddad@tandemlabs.io", name: "Noor Haddad" },
    ],
    internalCcs: ["owen@givefeedback.dev"],
    subject: "Push extracted tasks into Linear",
    messages: [
      {
        from: 0,
        text: "The task extraction is genuinely great, but copy-pasting each one into Linear is where we lose the time we just saved. Any way to push a session's tasks straight into a Linear team? Sienna and Noor from engineering are CC'd.",
        daysAgo: 18,
      },
      {
        from: "us",
        text: "This is our most-requested integration and it's in build now. First version maps each extracted task to a Linear issue with the replay link, timestamp, and effort estimate in the description. Which fields matter most for your triage?",
        daysAgo: 18,
      },
      {
        from: 1,
        text: "Effort estimate mapped to Linear's estimate points would be huge, and the replay link in the description is a must. If you can set the team and a default label, that covers 90% of our flow.",
        daysAgo: 17,
      },
      {
        from: "us",
        text: "All three are in scope: team + default label are configurable per project, and we'll map effort to estimate points. Rolling out behind a flag next week — want early access?",
        daysAgo: 17,
      },
      {
        from: 2,
        text: "Noor here, I own our Linear workspace. Will this use a personal API token or a proper OAuth app? Security won't approve a shared personal token.",
        daysAgo: 16,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "OAuth app — you'll authorize GiveFeedback from Linear's integrations page, no tokens to paste. Scoped to issue creation only.",
        daysAgo: 15,
        roster: [0, 1, 2],
      },
      {
        from: 0,
        text: "That clears it with our security team. Sign us up for early access.",
        daysAgo: 13,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "You're on the early-access list — the flag is live on your account now. Let us know how the first sync goes.",
        daysAgo: 12,
        roster: [0, 1, 2],
      },
    ],
  },
  // 4) Partnership — Webflow marketplace app
  {
    inbox: "mahmoud@givefeedback.dev",
    externals: [
      { email: "priya.singh@driftwood.agency", name: "Priya Singh" },
      { email: "kenji.yamada@driftwood.agency", name: "Kenji Yamada" },
    ],
    internalCcs: ["nadia@givefeedback.dev"],
    subject: "Webflow marketplace integration",
    messages: [
      {
        from: 0,
        text: "We ship a couple of Webflow apps and think GiveFeedback would be a natural marketplace listing — one-click install of the widget on any Webflow site. Would you be open to co-building it? Kenji is our lead dev on the Webflow side.",
        daysAgo: 19,
      },
      {
        from: "us",
        text: "Love this. A Webflow one-click install would remove the only friction our agency users hit. What does the integration surface look like on your end — a designer extension, a site-settings injection, or both?",
        daysAgo: 18,
      },
      {
        from: 1,
        text: "Site-settings injection is the clean path: we drop the widget script into the custom-code head field and pass the project key. No per-page work for the user. We'd need a stable embed URL and a way to mint project keys via API.",
        daysAgo: 18,
      },
      {
        from: "us",
        text: "We can expose a project-provisioning endpoint for you so the app creates a project and returns the key in one call. Embed URL is already stable. Want to scope a v1 on a call next week?",
        daysAgo: 17,
      },
      {
        from: 0,
        text: "Yes — Tuesday or Wednesday works. If v1 lands well, we'd feature it in our next Webflow newsletter (~9k designers).",
        daysAgo: 16,
        roster: [0, 1],
      },
      {
        from: "us",
        text: "Wednesday it is. I'll bring our API docs and a sandbox key so Kenji can start wiring the provisioning call the same day.",
        daysAgo: 16,
        roster: [0, 1],
      },
      {
        from: 1,
        text: "Provisioning call works against the sandbox — got a project + key back on the first try. We'll have a rough install flow to demo by Friday.",
        daysAgo: 13,
        roster: [0, 1],
      },
    ],
  },
  // 5) Support bug — recordings truncated + retention
  {
    inbox: "support@givefeedback.dev",
    externals: [
      { email: "alec.briggs@cascadeapp.co", name: "Alec Briggs" },
      { email: "irina.popov@cascadeapp.co", name: "Irina Popov" },
      { email: "mateo.santos@cascadeapp.co", name: "Mateo Santos" },
    ],
    internalCcs: ["mahmoud@givefeedback.dev"],
    subject: "Recordings cut off at three minutes",
    messages: [
      {
        from: 0,
        text: "Our client's longer walkthroughs keep getting truncated around the three-minute mark — the transcript stops mid-sentence and the replay ends. It's happened on our two most active projects this week. We're losing the most detailed feedback.",
        daysAgo: 5,
      },
      {
        from: "us",
        text: "Sorry about that — three minutes is the default per-session cap on the Starter plan, and it should warn the recorder before it hits, not cut silently. Two things: we're raising the cap to fifteen minutes on your plan today, and we're fixing the missing warning.",
        daysAgo: 5,
      },
      {
        from: 1,
        text: "Thanks. Adding Mateo, who manages the projects — he'll confirm once the longer recordings come through.",
        daysAgo: 5,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "Cap is raised on your account now. The two truncated sessions can't be recovered past the cut, but everything recorded from here will run the full length.",
        daysAgo: 4,
        roster: [0, 1, 2],
      },
      {
        from: 2,
        text: "Confirmed — just captured a nine-minute session end to end, transcript and replay both complete. One follow-up: how long are replays retained before the links expire?",
        daysAgo: 4,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "Replays are kept for 90 days on your plan, and you can export any session's video + tasks before then. We're adding a per-project retention setting next month for teams that need longer.",
        daysAgo: 3,
        roster: [0, 1, 2],
      },
      {
        from: 0,
        text: "That works for us. Appreciate the fast fix — resolved on our end.",
        daysAgo: 2,
      },
    ],
  },
  // 6) Support — studio getting the widget onto client sites (install help)
  {
    inbox: "support@givefeedback.dev",
    externals: [
      { email: "jana.kowalski@meridian.studio", name: "Jana Kowalski" },
      { email: "ravi.menon@meridian.studio", name: "Ravi Menon" },
      { email: "lucia.fernandez@meridian.studio", name: "Lucia Fernandez" },
    ],
    internalCcs: ["priya@givefeedback.dev"],
    subject: "Getting the widget onto all our client sites",
    messages: [
      {
        from: 0,
        text: "Just signed up and excited to roll this out. We build in a mix of Next.js and Webflow. Looping in Ravi (engineering) and Lucia (client ops) so we can get the widget live everywhere this week.",
        daysAgo: 11,
      },
      {
        from: "us",
        text: "Welcome aboard! Quick map: Next.js sites get the one-line script tag in the root layout; Webflow sites get it in the site-wide custom-code head field. One project per site keeps sessions cleanly separated. Happy to review your first install.",
        daysAgo: 11,
      },
      {
        from: 1,
        text: "For the Next.js App Router — root layout as a normal script tag, or do we need the next/script component with a strategy?",
        daysAgo: 10,
      },
      {
        from: "us",
        text: 'next/script with strategy="afterInteractive" in the root layout is ideal — it loads on every route without blocking render. Drop the project key as a data attribute and you\'re set.',
        daysAgo: 10,
      },
      {
        from: 2,
        text: "Client-ops side: we want clients leaving feedback but not poking around the dashboard. What's the cleanest way to bring a client in?",
        daysAgo: 9,
      },
      {
        from: "us",
        text: "Clients don't need an account at all — they just record on the site via the widget. For reviewing sessions, send them a per-session viewer link; it's read-only and doesn't consume a seat.",
        daysAgo: 9,
      },
      {
        from: 0,
        text: "That's simpler than we expected. First three sites are live and recording. Thanks for the hand-holding.",
        daysAgo: 8,
      },
    ],
  },
  // 7) Support — tuning AI task extraction (multi-person feedback)
  {
    inbox: "support@givefeedback.dev",
    externals: [
      { email: "deepa.rao@oakhouse.design", name: "Deepa Rao" },
      { email: "hugo.lefevre@oakhouse.design", name: "Hugo Lefevre" },
      { email: "anika.osei@oakhouse.design", name: "Anika Osei" },
      { email: "petr.zelinka@oakhouse.design", name: "Petr Zelinka" },
    ],
    internalCcs: ["nadia@givefeedback.dev", "owen@givefeedback.dev"],
    subject: "Tuning task extraction for our sessions",
    messages: [
      {
        from: 0,
        text: "We've run about 40 sessions and the task extraction is strong, but it under-splits: when a client asks for three related changes in one breath, it often lands as a single task. We'd rather have three granular tasks. Sharing team feedback below.",
        daysAgo: 16,
      },
      {
        from: 1,
        text: 'Adding to that — it sometimes turns a passing comment ("oh and I like this color") into a task. A little more precision on what counts as a request would cut the noise.',
        daysAgo: 16,
      },
      {
        from: "us",
        text: "Really useful — both are on our radar. Granularity: we're adding a per-project setting for how aggressively to split multi-part requests. Precision: the next model pass ignores affirmations and only extracts actionable asks. Want to try the new extraction on a few past sessions?",
        daysAgo: 15,
      },
      {
        from: 2,
        text: "Anika, design lead — yes please. Can we re-run extraction on an existing session without losing the tasks we've already triaged?",
        daysAgo: 15,
      },
      {
        from: "us",
        text: "Re-running creates a fresh task set side-by-side so your triaged ones stay put — you keep whichever you prefer. Turned it on for your account; try it on a session and tell us if the split feels right.",
        daysAgo: 14,
      },
      {
        from: 3,
        text: "Petr from engineering — when the granularity setting ships, can it be set via API? We provision projects programmatically and don't want to click through each one.",
        daysAgo: 13,
        roster: [0, 1, 2, 3],
      },
      {
        from: "us",
        text: "Yes — it'll be a field on the project-update endpoint, so you can set it at provision time. Shipping with the same release.",
        daysAgo: 13,
        roster: [0, 1, 2, 3],
      },
      {
        from: 0,
        text: "Re-ran three sessions and the granular split is exactly right. The noise from affirmations is gone too. Great work — we'll keep sending notes as we scale up.",
        daysAgo: 9,
      },
    ],
  },
  // 8) Sales — reseller terms across a joint agency eval
  {
    inbox: "mahmoud@givefeedback.dev",
    externals: [
      { email: "priya.rendon@makersyard.com", name: "Priya Rendon" },
      { email: "olu.adebayo@makersyard.com", name: "Olu Adebayo" },
      { email: "tariq.khan@oakhouse.design", name: "Tariq Khan" },
    ],
    internalCcs: ["nadia@givefeedback.dev"],
    subject: "Reseller terms for our retainer clients",
    messages: [
      {
        from: 0,
        text: "We bundle a fixed toolset into every monthly retainer and want GiveFeedback in it. Looking for reseller terms — we'd own the client relationship and billing. Olu handles our tooling; Tariq at a partner studio is evaluating alongside us.",
        daysAgo: 21,
      },
      {
        from: "us",
        text: "Happy to set this up. Reseller works two ways with us: you pay wholesale and bill your client directly, or we bill and pay you a referral share. For bundled retainers most agencies pick wholesale. What's the deciding factor for you?",
        daysAgo: 21,
      },
      {
        from: 1,
        text: "Wholesale, so it's invisible in the retainer. Two things matter: a single monthly invoice across all client projects, and being able to add or remove projects mid-month without a support ticket each time.",
        daysAgo: 20,
      },
      {
        from: "us",
        text: "Both supported — one consolidated monthly invoice, and project add/remove is self-serve from the reseller dashboard with proration. Sending the wholesale rate card now.",
        daysAgo: 20,
      },
      {
        from: 2,
        text: "Tariq here. If our studio joins the same reseller account later, can our projects be kept separate for our own client reporting?",
        daysAgo: 19,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "Yes — sub-accounts under one reseller keep projects and reporting separate while rolling up to a single invoice. That covers a multi-studio setup cleanly.",
        daysAgo: 18,
        roster: [0, 1, 2],
      },
      {
        from: 0,
        text: "Rate card looks good. We'll start with eight projects this month and grow from there. Sending the signed reseller agreement today.",
        daysAgo: 14,
      },
      {
        from: "us",
        text: "Received and countersigned — your reseller dashboard is provisioned. Add the eight projects whenever you're ready.",
        daysAgo: 12,
      },
    ],
  },
  // 9) Partnership — co-marketing webinar
  {
    inbox: "mahmoud@givefeedback.dev",
    externals: [
      { email: "wren.callahan@tandemlabs.io", name: "Wren Callahan" },
      { email: "soren.bakke@forgeworks.dev", name: "Soren Bakke" },
    ],
    internalCcs: ["nadia@givefeedback.dev", "priya@givefeedback.dev"],
    subject: "Joint webinar — feedback ops for agencies",
    messages: [
      {
        from: 0,
        text: "Floating a co-marketing idea: a joint webinar on 'cutting client feedback rounds from days to hours' — us, GiveFeedback, and Soren's studio sharing real workflows. Soren's interested and CC'd.",
        daysAgo: 19,
      },
      {
        from: 1,
        text: "We're in if it's a panel with live audience Q&A rather than alternating slide decks — easier to keep candid and easier to recruit speakers for.",
        daysAgo: 18,
      },
      {
        from: "us",
        text: "Panel format is perfect. Proposal: four panelists (one per company plus a moderator), 30 min discussion, 20 min Q&A. We'll bring anonymized before/after data on feedback-round times. Mid-November?",
        daysAgo: 18,
      },
      {
        from: 0,
        text: "Mid-November works. Wren can moderate — I've MC'd a few of these and it frees the company panelists to be candid.",
        daysAgo: 17,
      },
      {
        from: "us",
        text: "Sold. We'll draft the run-of-show and stand up the registration page with all three logos and per-company UTM tags so everyone can track their own signups.",
        daysAgo: 16,
      },
      {
        from: 1,
        text: "We'll promote it to our list (~11k designers and agency owners). Unified landing page is fine as long as we each get our UTM.",
        daysAgo: 15,
        roster: [0, 1],
      },
      {
        from: "us",
        text: "Done — UTMs are set per company. Draft run-of-show is in your inbox for review. Looking forward to it.",
        daysAgo: 15,
        roster: [0, 1],
      },
    ],
  },
  // 10) Projects — a studio's team working incoming feedback on a shared project
  {
    inbox: "projects@givefeedback.dev",
    externals: [
      { email: "yuki.sato@loomandlens.com", name: "Yuki Sato" },
      { email: "bo.westwood@loomandlens.com", name: "Bo Westwood" },
      { email: "clara.jung@loomandlens.com", name: "Clara Jung" },
    ],
    internalCcs: ["owen@givefeedback.dev"],
    subject: "Feedback rolling in on the Harbor redesign",
    messages: [
      {
        from: 0,
        text: "The Harbor redesign project got six new sessions overnight after we sent the client the staging link. Bo, can you extract tasks from the last three? I'll take the first three. Also flagging a question for GiveFeedback below.",
        daysAgo: 8,
      },
      {
        from: 1,
        text: "On it. Two of mine had the client jumping between pages mid-sentence — the replay timeline makes it easy to follow, but is there a way to jump the transcript to a specific click?",
        daysAgo: 8,
      },
      {
        from: "us",
        text: "Yes — clicking any event on the replay timeline scrubs both the video and the transcript to that moment. There's also a keyboard step-through (left/right arrows) once a session is focused. That's usually faster for click-heavy sessions.",
        daysAgo: 7,
      },
      {
        from: 2,
        text: "Clara from the client-facing side, just joining. When we mark tasks done, does the client see status if we've shared the session link with them?",
        daysAgo: 7,
        roster: [0, 1, 2],
      },
      {
        from: "us",
        text: "The read-only viewer link shows the session and its extracted tasks but not your internal status changes — clients see the feedback, not your task board. If you want to share progress, the project summary export is the cleaner artifact.",
        daysAgo: 6,
        roster: [0, 1, 2],
      },
      {
        from: 0,
        text: "All six sessions are triaged and the tasks are in our sprint. The timeline-scrub tip saved us a ton of time — thanks. Muting this thread now that we're rolling.",
        daysAgo: 5,
        roster: [0, 1, 2],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// conversation_id — same algorithm as worker/src/lib/conversation-id.ts.
// Computed for the seed because we can't await crypto.subtle here in a
// synchronous code path; node:crypto's createHash is the equivalent.
// ---------------------------------------------------------------------------
const INTERNAL_DOMAIN = "givefeedback.dev";

function computeConversationIdSync(
  inbox: string,
  externals: string[],
): string | null {
  const norm = Array.from(
    new Set(externals.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ).sort();
  if (norm.length < 2) return null;
  const key = `${inbox.trim().toLowerCase()}::${norm.join("|")}`;
  const hex = createHash("sha256").update(key).digest("hex");
  return `c_${hex.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Email content libraries — keyed by inbox so subjects/bodies match the
// channel's character.
// ---------------------------------------------------------------------------
type Snippet = { subject: string; body: string };

// support@ — bug reports, feature requests, and enhancement asks about the
// widget, the recorder, task extraction, and the dashboard.
const SUPPORT_SNIPPETS: Snippet[] = [
  {
    subject: "Widget isn't capturing clicks in Safari",
    body: "Voice and screen record fine, but click events don't show up in the replay on Safari 17. Chrome is perfect. Anything we can toggle?",
  },
  {
    subject: "Feature request: push extracted tasks to Jira",
    body: "The AI tasks are great but we live in Jira. Any way to send a session's tasks straight into a Jira project instead of copy-pasting?",
  },
  {
    subject: "Recording cuts off after ~3 minutes",
    body: "Longer client sessions get truncated around the three-minute mark. The transcript stops and the replay ends early. Repro on two projects.",
  },
  {
    subject: "Can we self-host the widget script?",
    body: "Our client's CSP blocks third-party scripts. Is there a self-hosted bundle or at least an SRI hash we can pin for app.givefeedback.dev/widget.js?",
  },
  {
    subject: "AI missed half the tasks in a session",
    body: "The transcript captured everything, but task extraction only pulled 2 of the 5 changes the client asked for. Session ID in the next message.",
  },
  {
    subject: "Re: Widget isn't capturing clicks in Safari",
    body: "Still reproduces on Safari 17.1 after clearing the cache. Attached a screen recording of the missing clicks.",
  },
  {
    subject: "Feedback button clashes with our cookie banner",
    body: "The widget sits under our cookie consent banner at the bottom-right. Can we move it or bump its z-index from the embed config?",
  },
  {
    subject: "Transcription garbled for Spanish clients",
    body: "Half our clients record in Spanish and the transcript comes back as broken English. Is there a language setting per project?",
  },
  {
    subject: "Enhancement: invite a client as a viewer",
    body: "We'd love to share a single session replay with a client read-only, without giving them a full seat on the dashboard. Possible today?",
  },
  {
    subject: "Replay links 404 after 30 days",
    body: "Older session replays return a 404. Looks like a retention window — can we extend it, at least on the paid plan?",
  },
  {
    subject: 'Effort estimates always come back "M"',
    body: "Every extracted task is tagged medium effort regardless of size. Is there a way to tune or turn off the estimate?",
  },
  {
    subject: "Enhancement: hotkey to start a recording",
    body: "Our power users would love a keyboard shortcut to trigger the recorder instead of hunting for the button each time.",
  },
];

// mahmoud@ — Mahmoud's inbox: sales inquiries, partnership pitches, and the
// occasional investor / random note.
const MAHMOUD_SNIPPETS: Snippet[] = [
  {
    subject: "GiveFeedback for our agency (20 designers)",
    body: "We run client work for ~30 sites and are evaluating GiveFeedback for all of them. Do you offer team pricing and any client-facing white-labeling?",
  },
  {
    subject: "Partnership — Webflow marketplace app?",
    body: "We maintain a few Webflow apps and think GiveFeedback would be a natural listing. Open to co-building an integration?",
  },
  {
    subject: "Podcast invite — the founder story",
    body: "I host a small SaaS podcast and loved the widget. Would you come on to talk about going from Loom-chaos to structured feedback?",
  },
  {
    subject: "Saw the Show HN — are you raising?",
    body: "Congrats on the launch. I invest at pre-seed in dev-tools and would love 20 minutes if you're taking angel money.",
  },
  {
    subject: "Reselling GiveFeedback in our retainers",
    body: "We bundle tools into monthly retainers for clients. Is there a reseller or referral arrangement we could set up?",
  },
  {
    subject: "Integration idea: Figma comments → tasks",
    body: "We live in Figma. A bridge that turns design comments into the same task format you extract from sessions would be huge. Worth exploring together?",
  },
  {
    subject: "Founding-agency discount?",
    body: "We've been recommending GiveFeedback to every studio we know. Any chance of an early-adopter rate before we roll it out team-wide?",
  },
  {
    subject: "Quick question before we commit annually",
    body: "We're ready to go annual but want to confirm session limits are per-project, not per-account. Can you clarify before we sign?",
  },
  {
    subject: "Guest post on modern client feedback",
    body: "I write for a design ops newsletter. Would you co-author a piece on cutting feedback rounds from days to hours? Your data would carry it.",
  },
  {
    subject: "Speaking slot at our design meetup?",
    body: "We run a 200-person design meetup in Lisbon next month. Would you give a lightning talk on the feedback-to-tasks workflow?",
  },
];

// projects@ — light inbound: replies to transactional feedback notifications.
const PROJECTS_SNIPPETS: Snippet[] = [
  {
    subject: "Re: New feedback on your project",
    body: "Got the notification — where do I turn this session into tasks? I see the replay but not the extract button.",
  },
  {
    subject: "Can I mute notifications for one project?",
    body: "One of our busier projects is sending a lot of these. Is there a per-project notification toggle?",
  },
  {
    subject: "Re: You got your first feedback 🎉",
    body: "This is amazing. The replay plus the extracted tasks are exactly what we needed to skip the usual back-and-forth.",
  },
  {
    subject: "Review link opened the wrong project",
    body: "The 'Review session' button in the last email took me to a different project's session. Might be a mismatched link.",
  },
  {
    subject: "Daily digest instead of per-session emails?",
    body: "Could these be batched into one daily summary? We get several a day once a client gets going.",
  },
];

// marketing@ — light inbound: replies to the monthly product update.
const MARKETING_SNIPPETS: Snippet[] = [
  {
    subject: "Re: What's new this month — love the Jira export",
    body: "Been waiting for this one. Wired it up in five minutes and our devs are thrilled. Thanks for shipping it.",
  },
  {
    subject: "Unsubscribe please",
    body: "Enjoy the product but I'm getting too much email. Please take me off the monthly updates.",
  },
  {
    subject: "When's the public API coming?",
    body: "Saw the API teased at the bottom of the update. Any timeline? We'd like to pull sessions into our own dashboard.",
  },
  {
    subject: "Re: Monthly update — small request",
    body: "Could the changelog include a screenshot or two per feature? Hard to picture some of them from text alone.",
  },
  {
    subject: "Best product update email I get",
    body: "Just wanted to say these are actually worth reading. Short, specific, no fluff. Keep them coming.",
  },
];

const INBOX_SNIPPETS: Record<string, Snippet[]> = {
  "support@givefeedback.dev": SUPPORT_SNIPPETS,
  "mahmoud@givefeedback.dev": MAHMOUD_SNIPPETS,
  "projects@givefeedback.dev": PROJECTS_SNIPPETS,
  "marketing@givefeedback.dev": MARKETING_SNIPPETS,
};

// Extra sentences used to give "medium" and "long" emails a natural range of
// lengths. inflateBody appends these WITHOUT repeating, so a body never
// contains the same sentence twice — the pool is large enough to cover the
// longest target on its own.
const FILLER_LINES = [
  "For context, this has been on our radar for a couple of weeks now.",
  "Happy to hop on a quick call if that's easier than going back and forth over email.",
  "I've looped in a teammate in case they have more detail than I do.",
  "Below is a little more detail on where we're coming from.",
  "We're flexible on timing on our end, so just let us know what works for you.",
  "Just so you have the full picture, here's how this fits into what we're building.",
  "Happy to share more specifics or a quick example if that would help.",
  "There's no real urgency on our side, but I wanted to get it in front of you.",
  "Let me know the best way to take this forward from here.",
  "Totally open to doing this differently if we're thinking about it the wrong way.",
  "No huge rush, but it would help to have a rough sense of timing.",
  "Let me know if you need anything else from our side.",
  "A couple of people on our team have brought this up too, so it's not just me.",
  "Thanks in advance — we really appreciate how responsive you've been.",
  "For what it's worth, we've been genuinely impressed with the product so far.",
];

function inflateBody(body: string, targetWords: number): string {
  const lines = [body];
  let words = body.split(/\s+/).filter(Boolean).length;
  // Draw filler sentences without replacement so nothing repeats. Stop once
  // we hit the target or run out of distinct filler.
  const pool = [...FILLER_LINES];
  while (words < targetWords && pool.length > 0) {
    const line = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    lines.push(line);
    words += line.split(/\s+/).filter(Boolean).length;
  }
  return lines.join("\n\n");
}

function bodyHtml(text: string): string {
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${sqlEscape(p)}</p>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Build people
// ---------------------------------------------------------------------------
interface Person {
  id: string;
  email: string;
  name: string;
  inboxes: string[]; // recipients they email
  createdOffsetDays: number;
}

function buildPeople(count: number): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  let i = 0;
  while (out.length < count) {
    const fn = pick(FIRST_NAMES);
    const ln = pick(LAST_NAMES);
    const dom = pick(DOMAINS);
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i % 5 === 0 ? "" : ""}@${dom}`;
    if (seen.has(email)) {
      i++;
      continue;
    }
    seen.add(email);
    const inboxCount = chance(0.5) ? 1 : chance(0.6) ? 2 : chance(0.7) ? 3 : 4;
    const inboxes = pickN(INBOUND_INBOXES, inboxCount).map((i) => i.email);
    out.push({
      id: `p_${out.length.toString().padStart(3, "0")}`,
      email,
      name: `${fn} ${ln}`,
      inboxes,
      createdOffsetDays: randInt(1, 60),
    });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build emails per person, per inbox
// ---------------------------------------------------------------------------
interface Email {
  id: string;
  personId: string;
  recipient: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  isRead: 0 | 1;
  receivedOffsetSec: number;
  cc?: CcEntry[];
  conversationId?: string | null;
}

interface SentReply {
  id: string;
  personId: string;
  fromAddress: string;
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo: string | null;
  sentOffsetSec: number;
  cc?: CcEntry[];
  conversationId?: string | null;
}

// ---------------------------------------------------------------------------
// CC roster helpers
// ---------------------------------------------------------------------------
function pickCcRoster(): CcEntry[] {
  // Choose 1-3 CCs. Most common: mix of one internal + one or two external.
  // Sometimes all-external or all-internal.
  const flavorRoll = rand();
  const total = randInt(1, 3);
  if (flavorRoll < 0.6) {
    // Mix: 1 internal + (total-1) external (with at least 1 external).
    const internalCount = Math.max(1, Math.min(1, total - 1));
    const externalCount = total - internalCount;
    return [
      ...pickN(INTERNAL_TEAM, internalCount),
      ...pickN(EXTERNAL_COLLABORATORS, externalCount),
    ];
  } else if (flavorRoll < 0.85) {
    // All external.
    return pickN(EXTERNAL_COLLABORATORS, total);
  } else {
    // All internal.
    return pickN(INTERNAL_TEAM, Math.min(total, INTERNAL_TEAM.length));
  }
}

function ccToJson(cc: CcEntry[]): string {
  // Build JSON, then encode for SQL: single quotes inside JSON values
  // (e.g. "Lin O'Brien") need to become '' in the SQL string literal.
  const json = JSON.stringify(
    cc.map((c) => ({ email: c.email, name: c.name ?? null })),
  );
  return `'${sqlEscape(json)}'`;
}

// ---------------------------------------------------------------------------
// Attachments — small fake fixture files we ship in seeds/attachments/ and
// upload to R2 via seeds/upload-attachments.sh.
// ---------------------------------------------------------------------------
interface AttachmentFixture {
  filename: string;
  contentType: string;
}

const ATTACHMENT_FIXTURES: AttachmentFixture[] = [
  { filename: "invoice.pdf", contentType: "application/pdf" },
  { filename: "screenshot.png", contentType: "image/png" },
  { filename: "Q3-budget.csv", contentType: "text/csv" },
  { filename: "meeting-notes.txt", contentType: "text/plain" },
  {
    filename: "roadmap.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  { filename: "logs.txt", contentType: "text/plain" },
];

interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
}

function fixtureSize(filename: string): number {
  // Resolve relative to this file regardless of cwd.
  const dir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
  return statSync(join(dir, "attachments", filename)).size;
}

function buildEmails(people: Person[]): {
  emails: Email[];
  sent: SentReply[];
  attachments: Attachment[];
  rosterChangePeopleIds: string[];
} {
  const emails: Email[] = [];
  const sent: SentReply[] = [];
  const attachments: Attachment[] = [];
  let eId = 0;
  let sId = 0;
  let aId = 0;

  // Pre-compute the 5 roster-change demo people: the FIRST 5 people whose
  // total inbound count would be >= 3. We don't know inbound counts yet
  // because they're determined inside this function, so we do a dry pass
  // using the same RNG-free heuristic: a person is eligible if they have
  // any inbox where the thread length >= 3. To keep this deterministic
  // without disturbing the main RNG sequence we instead pick people whose
  // inbox roster makes 3+ inbound likely (sum of inbox count >= 1 plus
  // we'll re-check after generation). Simpler approach: do generation
  // first, then assign roster changes to the first 5 eligible people in a
  // post-pass that overwrites cc on their longest thread (so the rest of
  // the RNG stream is preserved).

  // Track threads as we generate, so the roster-change post-pass can find
  // the longest thread per person without rescanning emails twice.
  // threadIndex: personId -> inbox -> [emailId, emailId, ...]
  const threads: Map<string, Map<string, string[]>> = new Map();

  for (const p of people) {
    for (const inbox of p.inboxes) {
      // Thread length: most people send once or twice, some have a short
      // back-and-forth, a few run longer. The hand-written GROUP_THREADS
      // carry the genuinely long, coherent conversations.
      const r = rand();
      const threadLen =
        r < 0.6 ? randInt(1, 2) : r < 0.9 ? randInt(3, 5) : randInt(6, 9);
      const snippets = INBOX_SNIPPETS[inbox] ?? SUPPORT_SNIPPETS;
      // Give each message in the thread a DISTINCT snippet (shuffled, drawn
      // without replacement) so a thread never repeats the same body. The
      // first message sets the subject; replies reuse "Re: <subject>".
      const ordered = pickN(snippets, snippets.length);
      const base = ordered[0];
      // marketing@ is a monthly blast: replies come in (kudos, unsubscribes)
      // but we don't CC anyone, attach anything, or reply back from it.
      const isAutomated = inbox === "marketing@givefeedback.dev";
      const threadIds: string[] = [];

      for (let i = 0; i < threadLen; i++) {
        // Spread emails across the time the person has existed (max 60 days back).
        const maxOffsetDays = p.createdOffsetDays;
        const offsetDays =
          (maxOffsetDays * (threadLen - i)) / threadLen + rand() * 0.5;
        const offsetSec = Math.floor(offsetDays * 86400) + randInt(0, 86399);

        const isFirst = i === 0;
        const subject = isFirst ? base.subject : `Re: ${base.subject}`;
        // Distinct snippet per message (wraps only on unusually long threads).
        const snippet = ordered[i % ordered.length];
        // Length distribution: most messages are just the snippet (real
        // support/sales mail is short), some get a sentence or two, a few run
        // longer. Targets stay within the distinct-filler budget so bodies
        // never repeat a sentence, and stay short enough to read naturally.
        const lengthRoll = rand();
        const targetWords = isAutomated
          ? randInt(12, 30)
          : lengthRoll < 0.5
            ? randInt(15, 35)
            : lengthRoll < 0.9
              ? randInt(45, 80)
              : randInt(85, 125);
        const text = inflateBody(snippet.body, targetWords);

        // Read state: very recent emails skew unread.
        const isRecent = offsetDays < 3;
        const isRead: 0 | 1 = isRecent
          ? chance(0.5)
            ? 0
            : 1
          : chance(0.85)
            ? 1
            : 0;

        // ~20% chance this email has CCs (skip the automated marketing@
        // blast — those are broadcast replies, not conversations).
        const cc = !isAutomated && chance(0.2) ? pickCcRoster() : undefined;

        const emailId = `e_${eId.toString().padStart(4, "0")}`;
        emails.push({
          id: emailId,
          personId: p.id,
          recipient: inbox,
          subject,
          bodyHtml: bodyHtml(text),
          bodyText: text,
          isRead,
          receivedOffsetSec: offsetSec,
          cc,
        });
        threadIds.push(emailId);
        eId++;

        // ~15% chance of 1-2 attachments on inbound emails (skip automated).
        if (!isAutomated && chance(0.15)) {
          const attachCount = chance(0.7) ? 1 : 2;
          const fixtures = pickN(ATTACHMENT_FIXTURES, attachCount);
          for (const fix of fixtures) {
            const attId = `a_${aId.toString().padStart(4, "0")}`;
            attachments.push({
              id: attId,
              emailId,
              filename: fix.filename,
              contentType: fix.contentType,
              size: fixtureSize(fix.filename),
              r2Key: `attachments/${emailId}/${attId}/${fix.filename}`,
            });
            aId++;
          }
        }
      }

      if (!threads.has(p.id)) threads.set(p.id, new Map());
      threads.get(p.id)!.set(inbox, threadIds);

      // Sometimes seed a reply from us back to them (~30% of threads).
      if (!isAutomated && chance(0.3)) {
        const replyOffsetSec = randInt(1800, 86400 * 2);
        const lastEmail = emails[emails.length - 1];
        const replyText = inflateBody(
          "Thanks for reaching out — I've looped in the right person on our side. Will follow up shortly with a more concrete answer.",
          randInt(30, 80),
        );
        // Sent replies also get CCs ~20% of the time.
        const sentCc = chance(0.2) ? pickCcRoster() : undefined;
        sent.push({
          id: `s_${sId.toString().padStart(4, "0")}`,
          personId: p.id,
          fromAddress: inbox,
          to: p.email,
          subject: `Re: ${base.subject}`,
          bodyHtml: bodyHtml(replyText),
          bodyText: replyText,
          inReplyTo: lastEmail.id,
          sentOffsetSec: Math.max(
            lastEmail.receivedOffsetSec - replyOffsetSec,
            60,
          ),
          cc: sentCc,
        });
        sId++;
      }
    }
  }

  // ---- Roster-change demo --------------------------------------------------
  // Pick first 5 people in id order whose total inbound count >= 3, then
  // overwrite cc on a single thread per person (the longest one with len >= 3)
  // to demonstrate add/drop roster changes between consecutive messages.
  const inboundCounts = new Map<string, number>();
  for (const e of emails) {
    inboundCounts.set(e.personId, (inboundCounts.get(e.personId) ?? 0) + 1);
  }
  const rosterChangePeopleIds: string[] = [];
  for (const p of people) {
    if (rosterChangePeopleIds.length >= 5) break;
    if ((inboundCounts.get(p.id) ?? 0) < 3) continue;
    const inboxThreads = threads.get(p.id);
    if (!inboxThreads) continue;
    // Find the longest thread for this person with len >= 3.
    let bestInbox: string | null = null;
    let bestLen = 0;
    for (const [inbox, ids] of inboxThreads) {
      if (ids.length >= 3 && ids.length > bestLen) {
        bestInbox = inbox;
        bestLen = ids.length;
      }
    }
    if (!bestInbox) continue;
    const ids = inboxThreads.get(bestInbox)!;
    // Build a small roster change pattern: external1 alone, then add
    // internal1, then drop internal1 (back to external1), and so on.
    const ext1 = EXTERNAL_COLLABORATORS[0];
    const ext2 = EXTERNAL_COLLABORATORS[1];
    const int1 = INTERNAL_TEAM[0];
    const int2 = INTERNAL_TEAM[1];
    const rosters: CcEntry[][] = [
      [ext1],
      [ext1, int1],
      [ext1],
      [ext1, ext2, int1],
      [ext1, ext2, int1, int2],
      [ext1, ext2, int2],
      [ext2, int2],
      [int2],
    ];
    for (let i = 0; i < ids.length; i++) {
      const target = emails.find((e) => e.id === ids[i]);
      if (!target) continue;
      target.cc = rosters[i % rosters.length];
    }
    rosterChangePeopleIds.push(p.id);
  }

  return { emails, sent, attachments, rosterChangePeopleIds };
}

// ---------------------------------------------------------------------------
// Build group threads — produces extra people, emails, and sent replies
// that share a conversation_id per thread. IDs are namespaced so they
// don't collide with the main 1-on-1 generator.
// ---------------------------------------------------------------------------
interface GroupBuildResult {
  groupPeople: Person[];
  groupEmails: Email[];
  groupSent: SentReply[];
  threadConversationIds: string[];
  groupMessageCounts: number[];
}

function buildGroupThreads(
  startEmailIdx: number,
  startSentIdx: number,
): GroupBuildResult {
  const groupPeople: Person[] = [];
  const groupEmails: Email[] = [];
  const groupSent: SentReply[] = [];
  const threadConversationIds: string[] = [];
  const groupMessageCounts: number[] = [];

  // Allocate one Person per unique external email across all GROUP_THREADS,
  // numbered p_g00, p_g01, ... in the order they're first encountered.
  const personByEmail = new Map<string, Person>();
  let pgIdx = 0;
  for (const t of GROUP_THREADS) {
    for (const ext of t.externals) {
      const key = ext.email.toLowerCase();
      if (personByEmail.has(key)) continue;
      const id = `p_g${pgIdx.toString().padStart(2, "0")}`;
      pgIdx++;
      const person: Person = {
        id,
        email: ext.email,
        name: ext.name,
        inboxes: [t.inbox],
        createdOffsetDays: 30,
      };
      personByEmail.set(key, person);
      groupPeople.push(person);
    }
  }

  let eId = startEmailIdx;
  let sId = startSentIdx;

  for (const t of GROUP_THREADS) {
    const externalEmails = t.externals.map((e) => e.email);
    const conversationId = computeConversationIdSync(t.inbox, externalEmails);
    if (!conversationId) {
      throw new Error(
        `GROUP_THREAD with inbox=${t.inbox} produced null conversation_id (need >= 2 externals)`,
      );
    }
    threadConversationIds.push(conversationId);
    groupMessageCounts.push(t.messages.length);

    // Track the most-recent external sender for outbound `to` selection.
    let lastExternalIdx = 0;

    for (let mi = 0; mi < t.messages.length; mi++) {
      const m = t.messages[mi];

      // Determine the roster (external indexes) for this message: defaults to
      // "all externals other than the sender (if external)".
      const allExtIdx = t.externals.map((_, idx) => idx);
      let messageExtRoster: number[];
      if (m.roster) {
        messageExtRoster = m.roster;
      } else if (m.from === "us") {
        messageExtRoster = allExtIdx;
      } else {
        messageExtRoster = allExtIdx.filter((idx) => idx !== m.from);
      }

      // Internal CCs roster: same on every message (no per-message override).
      const internalRoster = t.internalCcs;

      // Build cc entries — exclude the sender and exclude the outbound `to`
      // recipient (computed below for outbound).
      const buildCc = (excludeEmails: Set<string>): CcEntry[] => {
        const cc: CcEntry[] = [];
        for (const idx of messageExtRoster) {
          const ext = t.externals[idx];
          if (excludeEmails.has(ext.email.toLowerCase())) continue;
          cc.push({ email: ext.email, name: ext.name });
        }
        for (const intEmail of internalRoster) {
          if (excludeEmails.has(intEmail.toLowerCase())) continue;
          const intMember = INTERNAL_TEAM.find((i) => i.email === intEmail);
          cc.push({
            email: intEmail,
            name: intMember?.name ?? null,
          });
        }
        return cc;
      };

      // Time spread — same as 1-on-1 path: derive offset from daysAgo with
      // a small reproducible jitter from `rand`.
      const offsetSec = Math.floor(m.daysAgo * 86400) + randInt(0, 86399);

      // sqlEscape happens at render time everywhere else, so keep the raw
      // subject here and let the chunked-INSERT loop escape it.
      const rawSubject = mi === 0 ? t.subject : `Re: ${t.subject}`;

      if (m.from === "us") {
        // Outbound. `to` = most-recent external sender's email; cc = all
        // others (other externals + internalCcs).
        const toExt = t.externals[lastExternalIdx];
        const cc = buildCc(new Set([toExt.email.toLowerCase()]));
        const text = m.text;
        groupSent.push({
          id: `s_${sId.toString().padStart(4, "0")}`,
          personId: personByEmail.get(toExt.email.toLowerCase())!.id,
          fromAddress: t.inbox,
          to: toExt.email,
          subject: rawSubject,
          bodyHtml: bodyHtml(text),
          bodyText: text,
          inReplyTo: null,
          sentOffsetSec: offsetSec,
          cc: cc.length > 0 ? cc : undefined,
          conversationId,
        });
        sId++;
      } else {
        // Inbound. sender = externals[m.from], recipient = inbox, cc = all
        // other externals on roster + internal ccs.
        const sender = t.externals[m.from];
        const senderPerson = personByEmail.get(sender.email.toLowerCase())!;
        lastExternalIdx = m.from;
        const cc = buildCc(
          new Set([sender.email.toLowerCase(), t.inbox.toLowerCase()]),
        );
        const isRecent = m.daysAgo < 3;
        const isRead: 0 | 1 = isRecent
          ? chance(0.5)
            ? 0
            : 1
          : chance(0.85)
            ? 1
            : 0;
        const text = m.text;
        groupEmails.push({
          id: `e_${eId.toString().padStart(4, "0")}`,
          personId: senderPerson.id,
          recipient: t.inbox,
          subject: rawSubject,
          bodyHtml: bodyHtml(text),
          bodyText: text,
          isRead,
          receivedOffsetSec: offsetSec,
          cc: cc.length > 0 ? cc : undefined,
          conversationId,
        });
        eId++;
      }
    }
  }

  return {
    groupPeople,
    groupEmails,
    groupSent,
    threadConversationIds,
    groupMessageCounts,
  };
}

// ---------------------------------------------------------------------------
// Email templates + sequences
// ---------------------------------------------------------------------------
// Branded email templates the operator picks from in the reply composer +
// sequence builder. These carry the full GiveFeedback look (Inter, the lime
// #BFFF00 accent, the footer) so the demo shows real transactional email, not
// bare <p> tags. Variables follow the {{name}} convention the interpolate
// helper expects. The little brand helpers below keep the markup DRY.
// ---------------------------------------------------------------------------
const BRAND_MARK =
  '<p style="margin: 0 0 16px 0; font-size: 14px; font-weight: 800; letter-spacing: -0.3px; text-transform: uppercase; color: #0A0A0A;">✦ GIVEFEEDBACK</p>';

const BRAND_BODY_OPEN = (padY: number) =>
  `<div style="background-color: #F2F0ED; font-family: Inter, system-ui, sans-serif; font-size: 15px; line-height: 1.75; color: #0A0A0A; padding: ${padY}px 28px; text-align: left;">`;

const BRAND_BODY_CLOSE = "</div>";

const BRAND_PREHEADER = (text: string) =>
  `<span style="display:none;max-height:0;overflow:hidden;">${text}</span>`;

const BRAND_CTA = (href: string, label: string) =>
  `<p style="margin: 0 0 28px 0; text-align: center;"><a rel="noopener noreferrer" href="${href}" target="_blank" style="color: #0A0A0A; background-color: #BFFF00; border-radius: 8px; display: inline-block; padding: 10px 24px; text-decoration: none; font-weight: 700; font-size: 14px;">${label}</a></p>`;

const BRAND_MANAGE_NOTE =
  '<p style="margin: 0; color: rgba(10,10,10,0.35); font-size: 12px; text-align: center;"><a href="https://app.givefeedback.dev/dashboard/settings/notifications" target="_blank" style="color: rgba(10,10,10,0.35); text-decoration: underline;">Manage notifications</a></p>';

const BRAND_FOOTER =
  '<div style="background-color: #E8E6E3; font-family: Inter, system-ui, sans-serif; font-size: 12px; color: rgba(10,10,10,0.35); padding: 14px 28px; text-align: center;">' +
  '<p style="margin: 0;">© 2026 givefeedback.dev · <a rel="noopener noreferrer" href="https://givefeedback.dev" target="_blank" style="color: rgba(10,10,10,0.5); text-decoration: none;">givefeedback.dev</a></p>' +
  "</div>";

const BRAND_UNSUB_FOOTER =
  '<div style="background-color: #E8E6E3; font-family: Inter, system-ui, sans-serif; font-size: 12px; color: rgba(10,10,10,0.35); padding: 14px 28px; text-align: center;">' +
  '<p style="margin: 0 0 4px 0;"><a rel="noopener noreferrer" href="https://app.givefeedback.dev/unsubscribe" target="_blank" style="color: rgba(10,10,10,0.5); text-decoration: underline;">Unsubscribe</a> from product updates</p>' +
  '<p style="margin: 0;">© 2026 givefeedback.dev · <a rel="noopener noreferrer" href="https://givefeedback.dev" target="_blank" style="color: rgba(10,10,10,0.5); text-decoration: none;">givefeedback.dev</a></p>' +
  "</div>";

interface TemplateSeed {
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  fromAddress: string | null;
}

const TEMPLATES: TemplateSeed[] = [
  // onboarding@ — the signup welcome (verbatim brand HTML).
  {
    slug: "signup-welcome",
    name: "Onboarding · Welcome & first steps",
    subject: "Welcome to GiveFeedback, {{name}}",
    bodyHtml:
      BRAND_PREHEADER(
        "Paste one script tag. Your clients record. AI extracts the tasks.",
      ) +
      BRAND_BODY_OPEN(40) +
      BRAND_MARK +
      `<p style="margin: 0 0 18px 0;">Hey {{name}},</p>` +
      `<p style="margin: 0 0 18px 0;">Thanks for signing up. I'm Mahmoud, the founder of GiveFeedback.</p>` +
      `<p style="margin: 0 0 18px 0;">I built this because I was tired of spending two hours every sprint translating vague client emails and Loom videos into dev tickets. Same scattered feedback on every project. So I built the tool I wished existed.</p>` +
      `<p style="margin: 0 0 18px 0;">Here's how it works:</p>` +
      `<table style="margin: 0 0 24px 0; border-spacing: 0; border-collapse: collapse;">` +
      `<tr><td style="padding: 8px 12px 8px 0; vertical-align: top; color: #0A0A0A; font-weight: 700;">1.</td><td style="padding: 8px 0;"><strong>Add the widget</strong><span style="color: rgba(10,10,10,0.6);"> - paste one script tag onto your site. Works with React, Next.js, WordPress, anything.</span></td></tr>` +
      `<tr><td style="padding: 8px 12px 8px 0; vertical-align: top; color: #0A0A0A; font-weight: 700;">2.</td><td style="padding: 8px 0;"><strong>Your client records feedback</strong><span style="color: rgba(10,10,10,0.6);"> - they talk and click right on your site. We capture voice, screen, and clicks together.</span></td></tr>` +
      `<tr><td style="padding: 8px 12px 8px 0; vertical-align: top; color: #0A0A0A; font-weight: 700;">3.</td><td style="padding: 8px 0;"><strong>Get dev-ready tasks</strong><span style="color: rgba(10,10,10,0.6);"> - AI turns their session into structured tasks with replays, timestamps, and effort estimates.</span></td></tr>` +
      `</table>` +
      `<p style="margin: 0 0 18px 0;">Early teams are cutting feedback rounds from 5 days down to a few hours. That's the part I'm most proud of.</p>` +
      `<p style="margin: 0 0 6px 0; text-align: center; color: rgba(10,10,10,0.5); font-size: 13px;">Grab your embed code. Takes about 60 seconds.</p>` +
      BRAND_CTA(
        "https://app.givefeedback.dev/dashboard",
        "Go to your dashboard →",
      ) +
      `<p style="margin: 0 0 4px 0;">Mahmoud</p>` +
      `<p style="margin: 0; color: rgba(10,10,10,0.4); font-size: 13px;">Founder, givefeedback.dev · <a rel="noopener noreferrer" href="https://spaceandstory.co" target="_blank" style="color: rgba(10,10,10,0.5); text-decoration: none;">spaceandstory.co</a></p>` +
      BRAND_BODY_CLOSE +
      BRAND_FOOTER,
    fromAddress: "onboarding@givefeedback.dev",
  },
  // onboarding@ — nudge toward the first captured session.
  {
    slug: "first-steps",
    name: "Onboarding · Capture your first session",
    subject: "One tag away from your first session, {{name}}",
    bodyHtml:
      BRAND_PREHEADER(
        "Add the widget, send your client the link, watch the tasks appear.",
      ) +
      BRAND_BODY_OPEN(32) +
      BRAND_MARK +
      `<p style="margin: 0 0 16px 0;">Hi {{name}},</p>` +
      `<p style="margin: 0 0 18px 0;">You're set up — here's the fastest path to your first batch of dev-ready tasks:</p>` +
      `<table style="margin: 0 0 24px 0; border-spacing: 0; border-collapse: collapse;">` +
      `<tr><td style="padding: 8px 12px 8px 0; vertical-align: top; color: #0A0A0A; font-weight: 700;">1.</td><td style="padding: 8px 0;"><strong>Paste your embed tag</strong><span style="color: rgba(10,10,10,0.6);"> - one line in your site's &lt;head&gt;. It loads on every page automatically.</span></td></tr>` +
      `<tr><td style="padding: 8px 12px 8px 0; vertical-align: top; color: #0A0A0A; font-weight: 700;">2.</td><td style="padding: 8px 0;"><strong>Send your client the link</strong><span style="color: rgba(10,10,10,0.6);"> - they record right on the site. No login, no download.</span></td></tr>` +
      `<tr><td style="padding: 8px 12px 8px 0; vertical-align: top; color: #0A0A0A; font-weight: 700;">3.</td><td style="padding: 8px 0;"><strong>Open the session</strong><span style="color: rgba(10,10,10,0.6);"> - the AI has already turned it into tasks with replays and estimates.</span></td></tr>` +
      `</table>` +
      `<p style="margin: 0 0 18px 0;">Stuck on the install? Just reply — a real person (often me) reads every one.</p>` +
      BRAND_CTA(
        "https://app.givefeedback.dev/dashboard",
        "Grab your embed code →",
      ) +
      `<p style="margin: 0 0 4px 0;">Mahmoud</p>` +
      `<p style="margin: 0; color: rgba(10,10,10,0.4); font-size: 13px;">Founder, givefeedback.dev</p>` +
      BRAND_BODY_CLOSE +
      BRAND_FOOTER,
    fromAddress: "onboarding@givefeedback.dev",
  },
  // projects@ — the very first feedback notification (verbatim brand HTML, celebratory framing).
  {
    slug: "first-feedback",
    name: "Projects · First feedback 🎉",
    subject: "You just got your first feedback on {{project}} 🎉",
    bodyHtml:
      BRAND_PREHEADER(
        "Your first {{session_type}} session on {{project}} is in.",
      ) +
      BRAND_BODY_OPEN(32) +
      BRAND_MARK +
      `<p style="margin: 0 0 16px 0;">🎉 Your very first feedback just landed on <strong>{{project}}</strong>. Here's what your client left as a {{session_type}} session.</p>` +
      `<div style="border-left: 3px solid #BFFF00; padding-left: 14px; margin: 0 0 20px 0; color: rgba(10,10,10,0.75);">{{feedback_text}}{{transcript_preview}}</div>` +
      `<p style="margin: 0 0 20px 0; color: rgba(10,10,10,0.6);">Open the session to watch the full recording and let AI extract the tasks.</p>` +
      BRAND_CTA(
        "https://app.givefeedback.dev/dashboard/projects/{{project_id}}/sessions/{{session_id}}",
        "Review session →",
      ) +
      BRAND_MANAGE_NOTE +
      BRAND_BODY_CLOSE +
      BRAND_FOOTER,
    fromAddress: "projects@givefeedback.dev",
  },
  // projects@ — every subsequent feedback notification (verbatim brand HTML).
  {
    slug: "new-feedback",
    name: "Projects · New feedback notification",
    subject: "New {{session_type}} feedback on {{project}}",
    bodyHtml:
      BRAND_PREHEADER("New {{session_type}} feedback on {{project}}") +
      BRAND_BODY_OPEN(32) +
      BRAND_MARK +
      `<p style="margin: 0 0 16px 0;">Someone just left {{session_type}} feedback on <strong>{{project}}</strong>.</p>` +
      `<div style="border-left: 3px solid #BFFF00; padding-left: 14px; margin: 0 0 20px 0; color: rgba(10,10,10,0.75);">{{feedback_text}}{{transcript_preview}}</div>` +
      `<p style="margin: 0 0 20px 0; color: rgba(10,10,10,0.6);">Open the session to see the full recording and let AI extract the tasks.</p>` +
      BRAND_CTA(
        "https://app.givefeedback.dev/dashboard/projects/{{project_id}}/sessions/{{session_id}}",
        "Review session →",
      ) +
      BRAND_MANAGE_NOTE +
      BRAND_BODY_CLOSE +
      BRAND_FOOTER,
    fromAddress: "projects@givefeedback.dev",
  },
  // projects@ — weekly summary of activity on a project.
  {
    slug: "weekly-digest",
    name: "Projects · Weekly digest",
    subject: "Your week on {{project}}",
    bodyHtml:
      BRAND_PREHEADER(
        "A quick recap of this week's sessions and tasks on {{project}}.",
      ) +
      BRAND_BODY_OPEN(32) +
      BRAND_MARK +
      `<p style="margin: 0 0 16px 0;">Hi {{name}},</p>` +
      `<p style="margin: 0 0 18px 0;">Here's what happened on <strong>{{project}}</strong> this week — new sessions came in and the AI turned them into tasks waiting for you.</p>` +
      `<p style="margin: 0 0 20px 0; color: rgba(10,10,10,0.6);">Open the project to review the replays and move the tasks into your sprint.</p>` +
      BRAND_CTA(
        "https://app.givefeedback.dev/dashboard",
        "Open {{project}} →",
      ) +
      BRAND_MANAGE_NOTE +
      BRAND_BODY_CLOSE +
      BRAND_FOOTER,
    fromAddress: "projects@givefeedback.dev",
  },
  // marketing@ — the monthly product update.
  {
    slug: "monthly-update",
    name: "Marketing · Monthly product update",
    subject: "What's new at GiveFeedback: {{feature}}",
    bodyHtml:
      BRAND_PREHEADER("This month: {{feature}} — plus what's next.") +
      BRAND_BODY_OPEN(32) +
      BRAND_MARK +
      `<p style="margin: 0 0 16px 0;">Hi {{name}},</p>` +
      `<p style="margin: 0 0 18px 0;">Big one this month: <strong>{{feature}}</strong>. It's live in your dashboard now — no setup needed.</p>` +
      `<p style="margin: 0 0 18px 0;">We ship based on what you tell us, so keep the requests coming. Every one is read by a human.</p>` +
      BRAND_CTA("https://app.givefeedback.dev/dashboard", "See what's new →") +
      `<p style="margin: 0 0 4px 0;">Mahmoud</p>` +
      `<p style="margin: 0; color: rgba(10,10,10,0.4); font-size: 13px;">Founder, givefeedback.dev</p>` +
      BRAND_BODY_CLOSE +
      BRAND_UNSUB_FOOTER,
    fromAddress: "marketing@givefeedback.dev",
  },
  // support@ — check-in after a ticket reply.
  {
    slug: "support-followup",
    name: "Support · Follow-up",
    subject: "Following up on your GiveFeedback ticket",
    bodyHtml:
      BRAND_PREHEADER("Just checking the issue you flagged is fully sorted.") +
      BRAND_BODY_OPEN(32) +
      BRAND_MARK +
      `<p style="margin: 0 0 16px 0;">Hi {{name}},</p>` +
      `<p style="margin: 0 0 18px 0;">Circling back on the issue you flagged — did our last reply sort it out on your end?</p>` +
      `<p style="margin: 0 0 18px 0;">If you're still stuck, just reply and we'll dig back in. If it's resolved, no need to do anything.</p>` +
      `<p style="margin: 0;">Thanks for helping us make GiveFeedback better.</p>` +
      BRAND_BODY_CLOSE +
      BRAND_FOOTER,
    fromAddress: "support@givefeedback.dev",
  },
];

interface SequenceSeed {
  id: string;
  name: string;
  steps: Array<{ order: number; templateSlug: string; delayHours: number }>;
}

// Three sequences cover the use cases the UI exposes — a short onboarding,
// a longer activation nurture, and a 2-step win-back. Together they exercise
// multi-step rendering, mid-flight enrollment cancel, and the "completed"
// branch.
const SEQUENCES: SequenceSeed[] = [
  {
    id: "seq_onboarding_v1",
    name: "Onboarding · New signup",
    steps: [
      { order: 1, templateSlug: "signup-welcome", delayHours: 0 },
      { order: 2, templateSlug: "first-steps", delayHours: 48 }, // day 2
      { order: 3, templateSlug: "support-followup", delayHours: 168 }, // day 7
    ],
  },
  {
    id: "seq_activation_v1",
    name: "Activation · Get to first feedback",
    steps: [
      { order: 1, templateSlug: "signup-welcome", delayHours: 0 },
      { order: 2, templateSlug: "first-steps", delayHours: 72 }, // day 3
      { order: 3, templateSlug: "monthly-update", delayHours: 168 }, // day 7
      { order: 4, templateSlug: "support-followup", delayHours: 336 }, // day 14
    ],
  },
  {
    id: "seq_winback_v1",
    name: "Win-back · Inactive projects",
    steps: [
      { order: 1, templateSlug: "monthly-update", delayHours: 0 },
      { order: 2, templateSlug: "support-followup", delayHours: 120 }, // day 5
    ],
  },
];

// ---------------------------------------------------------------------------
// Sequence enrollments — pick a handful of seeded people and generate
// enrollment + sequence_emails rows that cover every status the UI
// branches on (active mid-flight, completed, cancelled, freshly
// enrolled with all-pending). Each enrollment's `fromAddress` is one
// of the person's known inboxes so the demo looks coherent.
// ---------------------------------------------------------------------------
interface EnrollmentSeed {
  id: string;
  sequenceId: string;
  personId: string;
  status: "active" | "completed" | "cancelled";
  variables: Record<string, string>;
  fromAddress: string;
  enrolledOffsetSec: number; // seconds before "now"
  cancelledOffsetSec: number | null;
}

interface SequenceEmailSeed {
  id: string;
  enrollmentId: string;
  stepOrder: number;
  templateSlug: string;
  scheduledOffsetSec: number; // signed: positive = past (sent/cancelled), negative = future
  status: "pending" | "queued" | "sent" | "cancelled" | "failed";
  sentOffsetSec: number | null;
}

function buildSequenceData(people: Person[]): {
  enrollments: EnrollmentSeed[];
  sequenceEmails: SequenceEmailSeed[];
} {
  const enrollments: EnrollmentSeed[] = [];
  const sequenceEmails: SequenceEmailSeed[] = [];
  let enrId = 0;
  let seId = 0;
  const HOUR = 3600;

  // Find a person who has at least one inbox in our INBOXES list. We
  // need a real fromAddress for the enrollment, and we prefer the
  // person's own correspondence inbox for realism.
  function pickPersonWithInbox(predicate: (p: Person) => boolean): Person {
    const pool = people.filter((p) => p.inboxes.length > 0 && predicate(p));
    if (pool.length === 0) {
      // Fall back to anyone with an inbox.
      return people.find((p) => p.inboxes.length > 0)!;
    }
    return pick(pool);
  }

  function emit(
    seq: SequenceSeed,
    person: Person,
    status: EnrollmentSeed["status"],
    enrolledOffsetSec: number,
    cancelledOffsetSec: number | null,
  ) {
    const fromAddress = pick(person.inboxes);
    const id = `enr_${enrId.toString().padStart(3, "0")}`;
    enrId++;
    enrollments.push({
      id,
      sequenceId: seq.id,
      personId: person.id,
      status,
      variables: {
        name: person.name,
        email: person.email,
        feature: "one-click task export to Linear & Jira",
        project: "Client Portal Redesign",
        date: "Friday",
        time: "11:00 AM PT",
      },
      fromAddress,
      enrolledOffsetSec,
      cancelledOffsetSec,
    });

    // For each step, compute when it would have been scheduled and
    // pick a status consistent with the enrollment's lifecycle.
    for (const step of seq.steps) {
      const stepOffsetSec = enrolledOffsetSec - step.delayHours * HOUR;
      // stepOffsetSec > 0 means scheduled time is in the past; <= 0 means future.
      let stepStatus: SequenceEmailSeed["status"];
      let sentOffsetSec: number | null = null;
      if (status === "completed") {
        stepStatus = "sent";
        sentOffsetSec = Math.max(stepOffsetSec, 1);
      } else if (status === "cancelled") {
        // Sent if the step was due before the enrollment was cancelled.
        if (
          cancelledOffsetSec !== null &&
          stepOffsetSec >= cancelledOffsetSec
        ) {
          stepStatus = "sent";
          sentOffsetSec = Math.max(stepOffsetSec, cancelledOffsetSec + 60);
        } else {
          stepStatus = "cancelled";
        }
      } else {
        // Active. Sent for past-scheduled steps, pending for future.
        if (stepOffsetSec > 0) {
          stepStatus = "sent";
          sentOffsetSec = stepOffsetSec;
        } else {
          stepStatus = "pending";
        }
      }
      sequenceEmails.push({
        id: `se_${seId.toString().padStart(3, "0")}`,
        enrollmentId: id,
        stepOrder: step.order,
        templateSlug: step.templateSlug,
        scheduledOffsetSec: stepOffsetSec,
        status: stepStatus,
        sentOffsetSec,
      });
      seId++;
    }
  }

  // 1. Active outreach mid-flight — enrolled 5 days ago. Steps 1+2 sent,
  //    steps 3+4 still pending (due day 7 / day 14).
  emit(
    SEQUENCES[0],
    pickPersonWithInbox(() => true),
    "active",
    5 * 86400,
    null,
  );

  // 2. Active onboarding — enrolled 3 days ago. Step 1 sent, step 2 sent,
  //    step 3 pending (due day 7).
  emit(
    SEQUENCES[1],
    pickPersonWithInbox((p) =>
      p.inboxes.includes("onboarding@givefeedback.dev"),
    ),
    "active",
    3 * 86400,
    null,
  );

  // 3. Active reactivation, only the first email sent — enrolled 2 days
  //    ago. Step 2 (day 5) still pending.
  emit(
    SEQUENCES[2],
    pickPersonWithInbox(() => true),
    "active",
    2 * 86400,
    null,
  );

  // 4. Freshly enrolled, just minutes ago — step 1 sent, rest pending.
  emit(
    SEQUENCES[0],
    pickPersonWithInbox(() => true),
    "active",
    600, // 10 minutes ago
    null,
  );

  // 5. Completed reactivation — enrolled 14 days ago, 2-step sequence
  //    fully delivered.
  emit(
    SEQUENCES[2],
    pickPersonWithInbox(() => true),
    "completed",
    14 * 86400,
    null,
  );

  // 6. Completed onboarding — enrolled 30 days ago, all 3 steps sent.
  emit(
    SEQUENCES[1],
    pickPersonWithInbox(() => true),
    "completed",
    30 * 86400,
    null,
  );

  // 7. Cancelled outreach mid-flight — enrolled 8 days ago, cancelled
  //    on day 4 (so steps 1+2 sent, steps 3+4 cancelled).
  emit(
    SEQUENCES[0],
    pickPersonWithInbox(() => true),
    "cancelled",
    8 * 86400,
    4 * 86400,
  );

  // 8. Cancelled before any send — enrolled 1 hour ago, cancelled
  //    almost immediately. Step 1's scheduledAt happens to land before
  //    the cancel by a few seconds, so it shows as sent; rest cancelled.
  //    Demonstrates the "user changed their mind" path.
  emit(
    SEQUENCES[1],
    pickPersonWithInbox(() => true),
    "cancelled",
    3600,
    1800,
  );

  return { enrollments, sequenceEmails };
}

// ---------------------------------------------------------------------------
// Template-driven sends — the automated inboxes (onboarding@, projects@,
// marketing@) actually send their branded templates to customers, so the
// "Sent" view shows real interpolated branded email, not generic acks.
// In demo mode the sequence processor is skipped, so we materialize these
// sends directly here rather than relying on enrollment processing.
// ---------------------------------------------------------------------------
const PROJECT_NAMES = [
  "Harbor Redesign",
  "Client Portal",
  "Acme Marketing Site",
  "Northwind Storefront",
  "Orbit Dashboard",
  "Wildflower Landing",
  "Summit Booking Flow",
  "Lumen Docs Site",
];
const SESSION_TYPES = ["voice", "screen", "voice + screen"];
const FEEDBACK_QUOTES = [
  "The checkout button disappears below the fold on mobile — took me a while to find it.",
  "Love the new hero, but the contact form throws an error when I submit without a phone number.",
  "Can we make the pricing table stack on tablet? It overflows sideways right now.",
  "The nav is great on desktop, but the hamburger menu doesn't close after I pick a link.",
  "Images on the case-study page are really slow to load — it felt laggy scrolling through.",
  "Small thing: the footer links are the same color as the background in dark mode.",
];
const MARKETING_FEATURES = [
  "one-click task export to Linear & Jira",
  "Spanish and French transcription",
  "15-minute recordings on every plan",
  "shareable read-only session links",
];

function buildTemplateSends(people: Person[]): SentReply[] {
  const sends: SentReply[] = [];
  let idx = 0;
  const nextId = () => `st_${(idx++).toString().padStart(3, "0")}`;
  const DAY = 86400;

  const tpl = (slug: string): TemplateSeed =>
    TEMPLATES.find((t) => t.slug === slug)!;

  const renderVars = (str: string, vars: Record<string, string>) =>
    str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

  function emit(
    template: TemplateSeed,
    person: Person,
    vars: Record<string, string>,
    offsetSec: number,
  ) {
    const html = renderVars(template.bodyHtml, vars);
    sends.push({
      id: nextId(),
      personId: person.id,
      // Automated templates always carry a fromAddress (one of the inboxes).
      fromAddress: template.fromAddress!,
      to: person.email,
      subject: renderVars(template.subject, vars),
      // sent_emails.body_html is inserted raw (not escaped at render time),
      // so escape the interpolated HTML here.
      bodyHtml: sqlEscape(html),
      // No text version on purpose: with an empty text fallback the chat
      // renderer shows the branded HTML instead of a stripped-text bubble.
      bodyText: "",
      inReplyTo: null,
      sentOffsetSec: Math.max(Math.floor(offsetSec), 60),
      cc: undefined,
      conversationId: null,
    });
  }

  function pickRecipients(count: number, inbox: string): Person[] {
    const preferred = people.filter((p) => p.inboxes.includes(inbox));
    const pool = preferred.length >= count ? preferred : people;
    return pickN(pool, Math.min(count, pool.length));
  }

  // onboarding@ — welcome, then first-steps a couple days later.
  for (const p of pickRecipients(20, "onboarding@givefeedback.dev")) {
    const welcomeAt = Math.max(p.createdOffsetDays, 2) * DAY - randInt(0, DAY);
    emit(tpl("signup-welcome"), p, { name: p.name }, welcomeAt);
    emit(
      tpl("first-steps"),
      p,
      { name: p.name },
      Math.max(welcomeAt - 2 * DAY, DAY),
    );
  }

  // projects@ — the celebratory first feedback, plus some later ones.
  const projectPeople = pickRecipients(24, "projects@givefeedback.dev");
  for (let i = 0; i < projectPeople.length; i++) {
    const p = projectPeople[i];
    const project = pick(PROJECT_NAMES);
    const baseVars = {
      name: p.name,
      project,
      project_id: `prj_${(1000 + i).toString(36)}`,
      transcript_preview: "",
    };
    emit(
      tpl("first-feedback"),
      p,
      {
        ...baseVars,
        session_type: pick(SESSION_TYPES),
        feedback_text: pick(FEEDBACK_QUOTES),
        session_id: `ses_${(2000 + i).toString(36)}a`,
      },
      randInt(20, 40) * DAY,
    );
    if (i % 2 === 0) {
      emit(
        tpl("new-feedback"),
        p,
        {
          ...baseVars,
          session_type: pick(SESSION_TYPES),
          feedback_text: pick(FEEDBACK_QUOTES),
          session_id: `ses_${(2000 + i).toString(36)}b`,
        },
        randInt(2, 15) * DAY,
      );
    }
  }

  // marketing@ — one monthly blast, same feature to everyone.
  const feature = pick(MARKETING_FEATURES);
  for (const p of pickRecipients(28, "marketing@givefeedback.dev")) {
    emit(
      tpl("monthly-update"),
      p,
      { name: p.name, feature },
      randInt(3, 20) * DAY,
    );
  }

  return sends;
}

// ---------------------------------------------------------------------------
// Render SQL
// ---------------------------------------------------------------------------
interface RenderResult {
  sql: string;
  attachments: Attachment[];
  rosterChangePeopleIds: string[];
  groupConversationIds: string[];
  groupMessageCounts: number[];
  groupPersonIds: string[];
  stats: {
    people: number;
    emails: number;
    sent: number;
    attachments: number;
    groupPeople: number;
    groupThreads: number;
    groupMessages: number;
    templates: number;
    sequences: number;
    enrollments: number;
    sequenceEmails: number;
  };
}

function renderSql(): RenderResult {
  const people = buildPeople(100);
  const { emails, sent, attachments, rosterChangePeopleIds } =
    buildEmails(people);

  // Append group threads after the 1-on-1 generation. Pass the next
  // available email/sent indexes so id namespaces stay disjoint.
  const startEmailIdx = emails.length;
  const startSentIdx = sent.length;
  const group = buildGroupThreads(startEmailIdx, startSentIdx);
  // Merge group rows into the main arrays so the chunked INSERTs cover them.
  const allPeople = [...people, ...group.groupPeople];
  for (const e of group.groupEmails) emails.push(e);
  for (const s of group.groupSent) sent.push(s);

  // Automated inboxes actually send their branded templates to customers.
  for (const s of buildTemplateSends(people)) sent.push(s);

  // Unread hygiene: keep the unread count small (< 30) and confined to the
  // most recent messages, so unread badges only show up on the first page
  // and deeper history reads as fully triaged. Mark everything read, then
  // re-open just the newest few inbound messages per inbox.
  const PER_INBOX_UNREAD = 5;
  for (const e of emails) e.isRead = 1;
  const byInbox = new Map<string, Email[]>();
  for (const e of emails) {
    const list = byInbox.get(e.recipient) ?? [];
    list.push(e);
    byInbox.set(e.recipient, list);
  }
  for (const list of byInbox.values()) {
    list
      .sort((a, b) => a.receivedOffsetSec - b.receivedOffsetSec)
      .slice(0, PER_INBOX_UNREAD)
      .forEach((e) => (e.isRead = 0));
  }

  // Sequence/enrollment data is built over the full person list so we
  // can pick people who match real inboxes — keeps the demo coherent.
  const seqData = buildSequenceData(allPeople);

  const lines: string[] = [];

  lines.push(
    "-- AUTO-GENERATED by seeds/generate-demo.ts. Do not edit by hand.",
  );
  lines.push("-- Run: yarn db:seed:dev (after re-running the generator).");
  lines.push(
    `-- Stats: ${allPeople.length} people, ${emails.length} emails, ${sent.length} sent replies, ${attachments.length} attachments.`,
  );
  lines.push(
    `-- Group threads: ${GROUP_THREADS.length} (${group.groupMessageCounts.join(" + ")} = ${group.groupEmails.length + group.groupSent.length} messages).`,
  );
  lines.push("");
  lines.push("DELETE FROM sequence_emails;");
  lines.push("DELETE FROM sequence_enrollments;");
  lines.push("DELETE FROM sequences;");
  lines.push("DELETE FROM api_keys;");
  lines.push("DELETE FROM email_templates;");
  lines.push("DELETE FROM invitations;");
  lines.push("DELETE FROM attachments;");
  lines.push("DELETE FROM sent_emails;");
  lines.push("DELETE FROM emails;");
  lines.push("DELETE FROM people;");
  lines.push("DELETE FROM inbox_permissions;");
  lines.push("DELETE FROM sender_identities;");
  lines.push("");

  // Inboxes — support@ and mahmoud@ carry a signature; the rest don't.
  lines.push(
    "INSERT OR REPLACE INTO sender_identities (email, display_name, display_mode, signature_html, created_at, updated_at) VALUES",
  );
  lines.push(
    INBOXES.map(
      (i) =>
        `  ('${i.email}', '${sqlEscape(i.display)}', 'chat', ${i.signature ? `'${sqlEscape(i.signature)}'` : "NULL"}, CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER))`,
    ).join(",\n") + ";",
  );
  lines.push("");

  // People (1-on-1 generator + group-thread externals).
  lines.push(
    "INSERT OR REPLACE INTO people (id, email, name, last_email_at, unread_count, total_count, created_at, updated_at) VALUES",
  );
  lines.push(
    allPeople
      .map(
        (p) =>
          `  ('${p.id}', '${sqlEscape(p.email)}', '${sqlEscape(p.name)}', 0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * ${p.createdOffsetDays}), CAST(strftime('%s','now') AS INTEGER))`,
      )
      .join(",\n") + ";",
  );
  lines.push("");

  // Emails — chunk inserts so we don't blow past SQLite's statement limit.
  // Keep chunks small enough that a single multi-row INSERT stays well under
  // remote D1's per-statement size cap — the branded template sends carry
  // multi-KB HTML bodies, so 50 rows/statement overflows it.
  const CHUNK = 20;
  for (let off = 0; off < emails.length; off += CHUNK) {
    const chunk = emails.slice(off, off + CHUNK);
    lines.push(
      "INSERT OR REPLACE INTO emails (id, person_id, recipient, subject, body_html, body_text, raw_headers, message_id, spf, dkim, dmarc, is_read, received_at, created_at, cc, conversation_id) VALUES",
    );
    lines.push(
      chunk
        .map(
          (e) =>
            `  ('${e.id}', '${e.personId}', '${e.recipient}', '${sqlEscape(e.subject)}', '${e.bodyHtml}', '${sqlEscape(e.bodyText)}', '{}', '<${e.id}@givefeedback.dev>', 'pass', 'pass', 'pass', ${e.isRead}, (CAST(strftime('%s','now') AS INTEGER) - ${e.receivedOffsetSec}), (CAST(strftime('%s','now') AS INTEGER) - ${e.receivedOffsetSec}), ${e.cc ? ccToJson(e.cc) : "NULL"}, ${e.conversationId ? `'${e.conversationId}'` : "NULL"})`,
        )
        .join(",\n") + ";",
    );
    lines.push("");
  }

  // Sent replies
  if (sent.length > 0) {
    for (let off = 0; off < sent.length; off += CHUNK) {
      const chunk = sent.slice(off, off + CHUNK);
      lines.push(
        "INSERT OR REPLACE INTO sent_emails (id, person_id, to_address, from_address, subject, body_html, body_text, in_reply_to, status, sent_at, created_at, cc, conversation_id) VALUES",
      );
      lines.push(
        chunk
          .map(
            (s) =>
              `  ('${s.id}', '${s.personId}', '${sqlEscape(s.to)}', '${s.fromAddress}', '${sqlEscape(s.subject)}', '${s.bodyHtml}', '${sqlEscape(s.bodyText)}', ${s.inReplyTo ? `'${s.inReplyTo}'` : "NULL"}, 'sent', (CAST(strftime('%s','now') AS INTEGER) - ${s.sentOffsetSec}), (CAST(strftime('%s','now') AS INTEGER) - ${s.sentOffsetSec}), ${s.cc ? ccToJson(s.cc) : "NULL"}, ${s.conversationId ? `'${s.conversationId}'` : "NULL"})`,
          )
          .join(",\n") + ";",
      );
      lines.push("");
    }
  }

  // Attachments
  if (attachments.length > 0) {
    for (let off = 0; off < attachments.length; off += CHUNK) {
      const chunk = attachments.slice(off, off + CHUNK);
      lines.push(
        "INSERT OR REPLACE INTO attachments (id, email_id, filename, content_type, size, r2_key, content_id, created_at) VALUES",
      );
      lines.push(
        chunk
          .map(
            (a) =>
              `  ('${a.id}', '${a.emailId}', '${sqlEscape(a.filename)}', '${sqlEscape(a.contentType)}', ${a.size}, '${sqlEscape(a.r2Key)}', NULL, CAST(strftime('%s','now') AS INTEGER))`,
          )
          .join(",\n") + ";",
      );
      lines.push("");
    }
  }

  // Email templates — small admin-curated library used in compose +
  // sequences. Slugs are stable so the sequence step references work.
  if (TEMPLATES.length > 0) {
    lines.push(
      "INSERT OR REPLACE INTO email_templates (id, slug, name, subject, body_html, from_address, created_at, updated_at) VALUES",
    );
    lines.push(
      TEMPLATES.map(
        (t, i) =>
          `  ('tpl_${i.toString().padStart(2, "0")}', '${sqlEscape(t.slug)}', '${sqlEscape(t.name)}', '${sqlEscape(t.subject)}', '${sqlEscape(t.bodyHtml)}', ${t.fromAddress ? `'${t.fromAddress}'` : "NULL"}, CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER))`,
      ).join(",\n") + ";",
    );
    lines.push("");
  }

  // Sequences — `steps` is stored as JSON in a TEXT column.
  if (SEQUENCES.length > 0) {
    lines.push(
      "INSERT OR REPLACE INTO sequences (id, name, steps, created_at, updated_at) VALUES",
    );
    lines.push(
      SEQUENCES.map(
        (s) =>
          `  ('${s.id}', '${sqlEscape(s.name)}', '${sqlEscape(JSON.stringify(s.steps))}', CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER))`,
      ).join(",\n") + ";",
    );
    lines.push("");
  }

  // Sequence enrollments — variables stored as JSON. Negative offsets
  // would land in the future (used for upcoming pending steps).
  if (seqData.enrollments.length > 0) {
    lines.push(
      "INSERT OR REPLACE INTO sequence_enrollments (id, sequence_id, person_id, status, variables, from_address, enrolled_at, cancelled_at) VALUES",
    );
    lines.push(
      seqData.enrollments
        .map(
          (e) =>
            `  ('${e.id}', '${e.sequenceId}', '${e.personId}', '${e.status}', '${sqlEscape(JSON.stringify(e.variables))}', '${e.fromAddress}', (CAST(strftime('%s','now') AS INTEGER) - ${e.enrolledOffsetSec}), ${e.cancelledOffsetSec === null ? "NULL" : `(CAST(strftime('%s','now') AS INTEGER) - ${e.cancelledOffsetSec})`})`,
        )
        .join(",\n") + ";",
    );
    lines.push("");
  }

  // Sequence emails — one per step per enrollment.
  if (seqData.sequenceEmails.length > 0) {
    lines.push(
      "INSERT OR REPLACE INTO sequence_emails (id, enrollment_id, step_order, template_slug, scheduled_at, status, sent_at, sent_email_id) VALUES",
    );
    lines.push(
      seqData.sequenceEmails
        .map(
          (e) =>
            `  ('${e.id}', '${e.enrollmentId}', ${e.stepOrder}, '${sqlEscape(e.templateSlug)}', (CAST(strftime('%s','now') AS INTEGER) - ${e.scheduledOffsetSec}), '${e.status}', ${e.sentOffsetSec === null ? "NULL" : `(CAST(strftime('%s','now') AS INTEGER) - ${e.sentOffsetSec})`}, NULL)`,
        )
        .join(",\n") + ";",
    );
    lines.push("");
  }

  // Recompute aggregate columns on people from the emails we just inserted.
  lines.push("UPDATE people SET");
  lines.push(
    "  last_email_at = COALESCE((SELECT MAX(received_at) FROM emails WHERE person_id = people.id), last_email_at),",
  );
  lines.push(
    "  unread_count  = COALESCE((SELECT SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) FROM emails WHERE person_id = people.id), 0),",
  );
  lines.push(
    "  total_count   = COALESCE((SELECT COUNT(*) FROM emails WHERE person_id = people.id), 0);",
  );
  lines.push("");

  return {
    sql: lines.join("\n"),
    attachments,
    rosterChangePeopleIds,
    groupConversationIds: group.threadConversationIds,
    groupMessageCounts: group.groupMessageCounts,
    groupPersonIds: group.groupPeople.map((p) => p.id),
    stats: {
      people: allPeople.length,
      emails: emails.length,
      sent: sent.length,
      attachments: attachments.length,
      groupPeople: group.groupPeople.length,
      groupThreads: GROUP_THREADS.length,
      groupMessages: group.groupEmails.length + group.groupSent.length,
      templates: TEMPLATES.length,
      sequences: SEQUENCES.length,
      enrollments: seqData.enrollments.length,
      sequenceEmails: seqData.sequenceEmails.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Render the upload script — a bash script that pushes every distinct
// (r2_key, filename) pair to the local R2 bucket bound in wrangler.jsonc.
// ---------------------------------------------------------------------------
function renderUploadScript(attachments: Attachment[]): string {
  const lines: string[] = [];
  lines.push("#!/usr/bin/env bash");
  lines.push("# AUTO-GENERATED by seeds/generate-demo.ts. Do not edit.");
  lines.push("# Uploads demo attachments to the local R2 bucket.");
  lines.push("set -e");
  lines.push("");
  lines.push("BUCKET=saasmail-attachments");
  lines.push('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  lines.push("");
  // Dedupe by r2_key — same key shouldn't be uploaded twice. r2_keys are
  // already unique per (email, attachment) pair so this is just defensive.
  const seen = new Set<string>();
  for (const a of attachments) {
    if (seen.has(a.r2Key)) continue;
    seen.add(a.r2Key);
    // We're calling wrangler from the repo root, so file=seeds/attachments/...
    lines.push(
      `npx wrangler r2 object put "$BUCKET/${a.r2Key}" --file="$SCRIPT_DIR/attachments/${a.filename}" --local`,
    );
  }
  lines.push("");
  lines.push('echo "Uploaded ${#}: $(echo $0)"');
  lines.push("");
  return lines.join("\n");
}

const result = renderSql();
const dir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
const sqlTarget = join(dir, "demo.sql");
writeFileSync(sqlTarget, result.sql);
const uploadTarget = join(dir, "upload-attachments.sh");
writeFileSync(uploadTarget, renderUploadScript(result.attachments));
console.log(
  `Wrote ${result.sql.length.toLocaleString()} chars to ${sqlTarget}`,
);
console.log(`Wrote upload script to ${uploadTarget}`);
console.log(
  `Stats: ${result.stats.people} people, ${result.stats.emails} emails, ${result.stats.sent} sent, ${result.stats.attachments} attachments`,
);
console.log(
  `Group threads: ${result.stats.groupThreads} (${result.groupMessageCounts.join(" + ")} = ${result.stats.groupMessages} messages)`,
);
console.log(
  `Templates: ${result.stats.templates} · Sequences: ${result.stats.sequences} (${result.stats.enrollments} enrollments, ${result.stats.sequenceEmails} scheduled emails)`,
);
console.log(
  `Group person ids: ${result.groupPersonIds[0]} .. ${result.groupPersonIds[result.groupPersonIds.length - 1]} (${result.stats.groupPeople} total)`,
);
console.log(
  `Roster-change demo people: ${result.rosterChangePeopleIds.join(", ")}`,
);
