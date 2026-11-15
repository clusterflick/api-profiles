import { parseCardFileName } from "./card-content";

/**
 * The site's own check, after lowercasing. The rules refuse any other handle,
 * so a path that fails it can't name a profile and needs no Firestore read.
 */
export const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;

export type Route =
  | { kind: "redirect"; location: string; status: 301 | 302 }
  | { kind: "profile"; handle: string }
  /** The image a link to the profile previews with. */
  | { kind: "card"; handle: string; hash: string }
  /** `handle` only when the path held a valid one, for the page's owner check. */
  | { kind: "not-found"; handle?: string };

/**
 * What a path under /u asks for. Handles are lowercase everywhere, so any
 * other casing, or a missing trailing slash, is a permanent redirect to the
 * one address a profile has.
 */
export function matchRoute(url: URL): Route {
  const { pathname, search } = url;
  if (pathname === "/u") {
    return { kind: "redirect", location: `/u/${search}`, status: 301 };
  }
  // Temporary, so /u/ can become a directory of people later without
  // browsers having cached this.
  if (pathname === "/u/") {
    return { kind: "redirect", location: "/personalise/", status: 302 };
  }

  const match = pathname.match(/^\/u\/([^/]+)(\/?)(.*)$/);
  if (!match) return { kind: "not-found" };
  const [, segment, slash, rest] = match;
  const handle = segment.toLowerCase();

  // Only ever linked as the Worker writes it, so not redirected when cased
  // differently: anything else is simply not a card.
  if (rest !== "") {
    const hash = parseCardFileName(rest);
    return hash && handle === segment && HANDLE_PATTERN.test(handle)
      ? { kind: "card", handle, hash }
      : { kind: "not-found" };
  }

  if (!HANDLE_PATTERN.test(handle)) return { kind: "not-found" };
  if (handle !== segment || slash === "") {
    return {
      kind: "redirect",
      location: `/u/${handle}/${search}`,
      status: 301,
    };
  }
  return { kind: "profile", handle };
}
