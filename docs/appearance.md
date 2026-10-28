[saasmail](../README.md) › [Docs](README.md) › **Appearance and mail layouts**

# Appearance and mail layouts

Each user picks how saasmail looks. The choice is saved to their account, so it
follows them to every browser and phone they sign in on.

Open **Settings → Appearance** (or the theme switch in the account menu) to choose:

| Setting                       | Options                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Mail layout                   | **Default**, **Gmail-style**, **Outlook-style**                                      |
| Colour mode                   | Light, Dark, System (follows the device)                                             |
| Density                       | Comfortable, Compact                                                                 |
| Colour theme (Default layout) | Navy, Ink, Slate, Indigo, Forest, Claret, Paper — each with a light and dark version |

## The three layouts

- **Default** — saasmail's own design: a navy navigation rail and top band around
  one light work panel, with an indigo accent (emerald in dark mode). One
  timeline per customer, as described in [Inboxes and timelines](inboxes.md).
  Keyboard triage (`j`/`k`, `e` archive, `b` snooze, `s` star, `#` Trash, `r`
  reply, `/` search, `?` for the full list), a ⌘K command palette, and swipe
  actions on phones. **Mark all as read** and **Select all N** act on the whole
  folder and its filters on the server, not just the page you can see. The
  **All tabs** filter shows one of Primary, Promotions, Social or Updates.
- **Gmail-style** — for people who live in Gmail: a Compose button and folder list
  on the left, a full-width message list with stars and hover actions, the
  conversation opening in place of the list (or a reading pane right/below),
  Primary / Promotions / Social / Updates tabs, right-click menus, drag to
  folders, search operators (`from:`, `is:unread`, `has:attachment`, `in:`,
  `label:`…) with chips and suggestions, Gmail keyboard shortcuts including `g`
  and `*` sequences and `z` undo, and on phones the floating search bar,
  configurable swipes, selection mode and the Compose button.
- **Outlook-style** — for people who live in Outlook: the blue header, an app bar,
  a ribbon (New mail, Delete, Archive, Reply, Flag, Pin, Snooze…), a folder pane,
  the message list grouped by date with Focused / Other, expandable
  conversations, hover quick actions, right-click menus, drag to folders, Sweep,
  a reading pane (right, bottom or off), search refiners and query syntax
  (`from:`, `hasattachments:yes`, `isread:no`…), Outlook keyboard shortcuts and
  `Ctrl+Z` undo, and on phones Focused/Other, configurable swipes, action sheets
  and the round New mail button.

Tabs and Focused/Other use a category on each conversation: bulk mail (a
`List-Unsubscribe` header) is Promotions, social networks are Social, automated
senders (`no-reply@`, `notifications@`…) and mail only ever sent to a
notifications-style inbox are Updates, and everything else is Primary / Focused.
This is a guess from the mail itself. When it is wrong, correct it from the
conversation's menu: **Move to tab → Primary / Promotions / Social / Updates**
(default layout), **Move to Primary / …** (Gmail) or **Move to Focused / Other**
(Outlook). A correction is per sender and per user: all of that sender's mail goes
to the tab you picked, for you only, from then on. Group conversations follow
their headers and inbox and can't be corrected.

All three show the same mail and the same pages (templates, sequences, settings,
admin); only the layout and look change. Every layout has a light and a dark mode.

## Star, pin, archive and snooze

These work in every layout and are **per user**: archiving a conversation hides it
from your inbox, not your teammates'.

| Action  | Gmail name | Outlook name | What it does                                                     |
| ------- | ---------- | ------------ | ---------------------------------------------------------------- |
| Star    | Star       | Flag         | Marks the conversation; it shows under **Starred** / **Flagged** |
| Pin     | Pin        | Pin          | Keeps the conversation at the top of the inbox                   |
| Archive | Archive    | Archive      | Moves it out of the inbox. **New mail brings it back**           |
| Snooze  | Snooze     | Snooze       | Hides it until the chosen time, then it returns to the inbox     |

Folders: **Inbox**, **Starred**, **Snoozed**, **Sent** (conversations you have
written to), **Drafts**, **Sequenced**, **Archive**, **Trash** (Gmail) / **Deleted
Items** (Outlook), and one entry per inbox address (a "label" in the Gmail layout,
a folder in the Outlook layout).

## Trash

**Delete** moves a conversation to your Trash, with an **Undo** button. Like
archive, Trash is per user: the conversation disappears from all your other
folders but not from your teammates', and new mail from that conversation brings it
back to your inbox.

Inside Trash:

- **Restore** puts the conversation back where it was.
- **Delete forever** (admins only) removes the person and **all of their mail, for
  everyone** on the workspace. It asks first and can't be undone.
- **Empty Trash** (admins only) does Delete forever for every person in your
  Trash, after asking.
- Group conversations (several outside participants) can't be deleted forever.
  They can only be restored, or left in Trash; Empty Trash leaves them there and
  says how many it skipped.

## Undo Send

Every Send button (new mail, reply, reply all, forward and the chat quick reply)
holds the message for a few seconds with a **Sending… Undo** notice. The composer
closes at once. **Undo** reopens it with everything you wrote, attachments
included; if the send fails, it reopens with the error. The draft is kept until
the message has really gone.

Choose the delay under **Settings → Sending** (default layout), in the Gmail
layout's quick settings, or in the Outlook layout's settings: Off, 5, 10, 20 or 30
seconds (5 by default). The message waits in your browser, so keep the tab open
until it has gone; closing the tab during the delay asks first.

## Settings follow your account

Your layout settings are saved to your account, not to one browser, so they are
the same on every computer and phone you sign in on: in the default layout the
rail being collapsed, the width of the conversation list, the inbox sort and
"Hide signatures in chat"; in the Gmail and Outlook layouts the reading pane,
density, inbox type, tabs, swipe actions, favorites and collapsed folders. The
Undo Send delay is shared by all three layouts. Values a browser had saved before
this change are moved into your account the first time you open saasmail there.

Two things stay on each device: whether you dismissed the push-notification prompt,
and recent searches.

## Previewing a layout

Add `?ui=gmail`, `?ui=outlook` or `?ui=default` to any URL to try a layout in that
browser tab without changing your saved choice. Picking a layout in Settings clears
the preview.

## API

| Endpoint                                                         | Use                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/user/preferences`                                      | `{ uiTheme, colorMode, density }` for the signed-in user                                                                                                                                                                             |
| `PATCH /api/user/preferences`                                    | Change any of them                                                                                                                                                                                                                   |
| `PATCH /api/mail-state`                                          | Star, pin, archive, snooze or trash up to 100 rows: `{ items: [{ type: "person" \| "group", id }], starred?, pinned?, archived?, snoozedUntil?, trashed? }` (unix seconds; `null` wakes)                                             |
| `GET /api/people/grouped?folder=&category=&from=&hasAttachment=` | `all` (default, ignores the state above), `inbox`, `starred`, `snoozed`, `archive`, `sent`, `trash`. Rows carry `starred`, `pinned`, `archivedAt`, `snoozedUntil`, `trashedAt`, `hasSent`, `latestSubject`, `snippet` and `category` |
| `GET /api/people/grouped/ids`                                    | Every row matching the same filters (up to 5000), for whole-folder actions such as Mark all as read, Select all N and Empty Trash                                                                                                    |
| `PUT /api/people/category`                                       | `{ senders: [email], category }` moves senders to a tab for the signed-in user; `category: null` removes the correction                                                                                                              |

The state lives in two tables, `user_preferences` and `mail_item_states`
(migration `0048`).

## For contributors

Colours, fonts, radii and shadows are CSS variables in `src/index.css`, keyed off
`data-ui` and `data-mode` on `<html>`. Components use the semantic Tailwind names
(`bg-card`, `text-text-secondary`, `bg-accent` …), never hex values, so a page works
in every layout and mode. The Gmail and Outlook layouts live in `src/themes/gmail/`
and `src/themes/outlook/`; `src/themes/types.ts` is the contract a layout implements.
