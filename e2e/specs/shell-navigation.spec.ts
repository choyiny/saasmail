// e2e/specs/shell-navigation.spec.ts
// Covers, in each layout (default, Gmail-style, Outlook-style): the
// navigation reaching the fork's own pages, the agent toggle and Ctrl+J,
// the sending-paused banner, the person view by its deep links, and the
// grouped inbox showing no star / pin / archive / snooze / trash controls
// or folders while those wait for a later release (docs/mailbox-state.md),
// without touching the state the /mail page keeps.
//
// Seed gives us Alice (p_alice) and Bob (p_bob) in support@ and marketing@,
// and Mailbox Fixture (p_mailbox) in support@.
import type { Page, Request } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

const LAYOUTS = ["default", "gmail", "outlook"] as const;
type Layout = (typeof LAYOUTS)[number];

/** The fork's pages and what each shows once it has loaded. */
const FORK_PAGES: Array<{ label: string; path: string; heading?: string }> = [
  { label: "Mail", path: "/mail" },
  { label: "Lists", path: "/lists", heading: "Lists" },
  { label: "Campaigns", path: "/campaigns", heading: "Campaigns" },
  {
    label: "Subscribe forms",
    path: "/subscribe-forms",
    heading: "Subscribe forms",
  },
  { label: "Automations", path: "/automations", heading: "Automations" },
  { label: "Audit log", path: "/admin/audit", heading: "Audit log" },
  { label: "Contact data", path: "/admin/contacts", heading: "Contact data" },
];

/** Names of the controls and folders that need the grouped mail state. */
const STATE_CONTROL =
  /^(Star|Starred|Unstar|Snooze|Snoozed|Archive|Unarchive|Trash|Move to Trash|Deleted Items|Delete forever|Empty Trash|Flag|Flagged|Unflag|Pin|Unpin)\b/;

/** Open the grouped inbox in a layout; `?ui=` sticks for the tab. */
async function openLayout(page: Page, layout: Layout) {
  await page.goto(`/?ui=${layout}`);
  await expect(page.locator("html")).toHaveAttribute("data-ui", layout);
}

/** Use the layout's own navigation to reach a page by its label. */
async function navigateTo(page: Page, layout: Layout, label: string) {
  if (layout === "default") {
    await page
      .getByTestId("portal-rail")
      .getByRole("link", { name: label, exact: true })
      .click();
  } else if (layout === "gmail") {
    await page.getByTestId("gmail-apps").click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  } else {
    await page.getByRole("button", { name: "App launcher" }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  }
}

/**
 * Records the grouped inbox's requests: none may reach the grouped mail
 * state, and the grouped list may only ask for all, inbox or sent.
 */
function watchRequests(page: Page) {
  const bad: string[] = [];
  let grouped = 0;
  const onRequest = (req: Request) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/mail-state")) bad.push(req.url());
    if (url.pathname.startsWith("/api/people/grouped")) {
      grouped++;
      const folder = url.searchParams.get("folder");
      if (folder !== null && folder !== "inbox" && folder !== "sent")
        bad.push(req.url());
      if (url.searchParams.has("starred") || url.searchParams.has("pinned"))
        bad.push(req.url());
    }
  };
  page.on("request", onRequest);
  return {
    check() {
      page.off("request", onRequest);
      expect(bad).toEqual([]);
      return grouped;
    },
  };
}

/**
 * The open conversation: the person's heading (default layout) or a
 * message header naming them (Gmail and Outlook show the thread).
 */
function personView(page: Page, name: string, email: string) {
  return page
    .getByRole("heading", { name, exact: true })
    .or(page.getByRole("article").filter({ hasText: email }))
    .first();
}

type ListedMessage = {
  ref: string;
  state?: {
    starredAt: number | null;
    archivedAt: number | null;
    trashedAt: number | null;
    snoozedUntil: number | null;
  };
};

test.describe.serial("shell navigation", () => {
  test.beforeAll(() => truncateAndReseed());

  for (const layout of LAYOUTS) {
    test.describe(`${layout} layout`, () => {
      test("the navigation reaches each of the fork's pages", async ({
        page,
      }) => {
        const watch = watchRequests(page);
        await openLayout(page, layout);
        for (const p of FORK_PAGES) {
          await navigateTo(page, layout, p.label);
          await expect(page).toHaveURL(new RegExp(`${p.path}(\\?|#|$)`));
          if (p.heading) {
            await expect(
              page.getByRole("heading", { name: p.heading, exact: true }),
            ).toBeVisible();
          } else {
            // /mail: the fork's own mailbox with its folders.
            await expect(page.getByTestId("mail-folder-inbox")).toBeVisible();
          }
        }
        watch.check();
      });

      test("the agent toggle and Ctrl+J open the mail agent", async ({
        page,
      }) => {
        await page.route("**/api/agent/status", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              configured: false,
              provider: null,
              model: null,
            }),
          }),
        );
        await openLayout(page, layout);
        const toggle = page.getByRole("button", { name: /^Toggle mail agent/ });
        await expect(toggle).toHaveAttribute("aria-pressed", "false");

        await page.keyboard.press("Control+j");
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("agent-not-configured")).toBeVisible();

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByTestId("agent-not-configured")).toBeHidden();
      });

      test("the sending-paused banner shows while sending is paused", async ({
        page,
        api,
      }) => {
        const paused = await api.patch("/api/admin/settings", {
          data: { outboundPaused: true },
        });
        expect(paused.ok()).toBe(true);
        try {
          await openLayout(page, layout);
          await expect(page.getByTestId("sending-paused-banner")).toBeVisible();
        } finally {
          const resumed = await api.patch("/api/admin/settings", {
            data: { outboundPaused: false },
          });
          expect(resumed.ok()).toBe(true);
        }
      });

      test("a person opens by /inbox/:inbox/:personId and by /m/:emailId", async ({
        page,
      }) => {
        await openLayout(page, layout);
        await page.goto("/inbox/support%40e2e.test/p_alice");
        await expect(
          personView(page, "Alice Anderson", "alice@customers.test"),
        ).toBeVisible();

        await page.goto("/m/e_s_b1");
        await expect(page).toHaveURL(/\/inbox\/support(%40|@)e2e\.test\/p_bob/);
        await expect(
          personView(page, "Bob Brown", "bob@customers.test"),
        ).toBeVisible();
      });

      test("the grouped inbox offers no state controls or folders; /mail keeps them", async ({
        page,
        api,
      }) => {
        // State the /mail page sets, through its own API: archive one
        // message, star one, snooze one conversation, trash one.
        const archived = "received:e_s_a1";
        const starred = "received:e_s_a2";
        const snoozed = "received:e_s_b1";
        const trashed = "received:e_mailbox_1";
        const until = Math.floor(Date.now() / 1000) + 3600;
        expect(
          (
            await api.post("/api/messages/mailbox-state", {
              data: { refs: [archived], archived: true },
            })
          ).ok(),
        ).toBe(true);
        expect(
          (
            await api.post("/api/messages/user-state", {
              data: { refs: [starred], starred: true },
            })
          ).ok(),
        ).toBe(true);
        expect(
          (
            await api.post("/api/messages/snooze", {
              data: { refs: [snoozed], until },
            })
          ).ok(),
        ).toBe(true);
        expect(
          (
            await api.post("/api/messages/mailbox-state", {
              data: { refs: [trashed], trashed: true },
            })
          ).ok(),
        ).toBe(true);
        const set = await statesOf(api);
        expect(set.get(archived)?.archivedAt).not.toBeNull();
        expect(set.get(starred)?.starredAt).not.toBeNull();
        expect(set.get(snoozed)?.snoozedUntil).toBe(until);
        expect(set.get(trashed)?.trashedAt).not.toBeNull();

        const watch = watchRequests(page);
        await openLayout(page, layout);
        await expect(page.getByText("Alice Anderson").first()).toBeVisible();
        await expect(
          page.getByRole("link", { name: STATE_CONTROL }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: STATE_CONTROL }),
        ).toHaveCount(0);

        // A bookmarked state folder falls back to the inbox.
        for (const folder of [
          "starred",
          "snoozed",
          "archive",
          "trash",
          "flagged",
          "deleted",
        ]) {
          await page.goto(`/?folder=${folder}`);
          await expect(page.getByText("Alice Anderson").first()).toBeVisible();
        }

        // Open each of those people: their headers have none either.
        for (const person of [
          {
            id: "p_alice",
            name: "Alice Anderson",
            email: "alice@customers.test",
          },
          { id: "p_bob", name: "Bob Brown", email: "bob@customers.test" },
          {
            id: "p_mailbox",
            name: "Mailbox Fixture",
            email: "mailbox@customers.test",
          },
        ]) {
          await page.goto(`/inbox/support%40e2e.test/${person.id}`);
          await expect(
            personView(page, person.name, person.email),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: STATE_CONTROL }),
          ).toHaveCount(0);
        }
        expect(watch.check()).toBeGreaterThan(0);

        // The state /mail keeps is untouched by browsing the grouped inbox
        // (opening a conversation reads it, so "seen" may change).
        const after = await statesOf(api);
        expect(withoutSeen(after)).toEqual(withoutSeen(set));

        // /mail keeps its own folders and controls.
        await page.goto("/mail/support%40e2e.test/inbox");
        await expect(page.getByTestId("mail-folder-starred")).toBeVisible();
        await expect(page.getByTestId("mail-folder-archive")).toBeVisible();
        await expect(page.getByTestId("mail-folder-trash")).toBeVisible();

        // Leave the messages as the seed had them for the next layout.
        for (const [path, data] of [
          ["mailbox-state", { refs: [archived], archived: false }],
          ["user-state", { refs: [starred], starred: false }],
          ["snooze", { refs: [snoozed], until: null }],
          ["mailbox-state", { refs: [trashed], trashed: false }],
        ] as const) {
          expect((await api.post(`/api/messages/${path}`, { data })).ok()).toBe(
            true,
          );
        }
      });
    });
  }
});

function withoutSeen(states: Map<string, ListedMessage["state"]>) {
  return Object.fromEntries(
    [...states].map(([ref, state]) => {
      const { seen: _seen, ...rest } = (state ?? {}) as Record<string, unknown>;
      return [ref, rest];
    }),
  );
}

/** Every support message's state, from each folder it can sit in. */
async function statesOf(
  api: import("@playwright/test").APIRequestContext,
): Promise<Map<string, ListedMessage["state"]>> {
  const states = new Map<string, ListedMessage["state"]>();
  for (const folder of ["inbox", "sent", "archive", "trash", "snoozed"]) {
    const res = await api.get(
      `/api/messages?inbox=support%40e2e.test&folder=${folder}&limit=100`,
    );
    expect(res.ok()).toBe(true);
    for (const m of ((await res.json()) as { messages: ListedMessage[] })
      .messages) {
      if (!states.has(m.ref)) states.set(m.ref, m.state);
    }
  }
  return states;
}
