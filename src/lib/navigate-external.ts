/**
 * Hand the browser to an address outside the SPA — an OAuth consent screen,
 * a payment provider, anything the router cannot own.
 *
 * This exists as its own module to be a seam. jsdom refuses cross-origin
 * navigation and `window.location` is not reliably patchable, so a component
 * that assigns `window.location.href` inline has a step no test can observe.
 * That blind spot shipped a Connect button that never reached Google: the
 * tests asserted an anchor's `href` and could say nothing about where the
 * click actually went. Route external navigation through here and a test can
 * `vi.mock("@/lib/navigate-external")` and assert the destination.
 */
export function navigateExternal(url: string): void {
  window.location.href = url;
}
