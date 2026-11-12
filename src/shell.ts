import type { ProfileData, Sections } from "./profile";

/**
 * The site's `/profile-shell/` page: its layout, built with each deploy's
 * assets, in its not-found state. A profile is that page with its data in a
 * script tag and its `<head>` describing it.
 */
export const SHELL_PATH = "/profile-shell/";

/**
 * The shell's title and description, as the site sets them
 * (`PROFILE_SHELL_TITLE` and `PROFILE_SHELL_DESCRIPTION` in
 * src/lib/user-profile/page-data.ts). They appear twice: in the `<head>`, and
 * in the page's inline RSC payload, which Next renders the `<head>` from again
 * after hydration. Both are replaced, or the browser would put the shell's
 * title back. Plain text, so they read the same in HTML and in the payload.
 */
export const SHELL_TITLE = "Profile Not Found | Clusterflick";
export const SHELL_DESCRIPTION = "No public profile at this address.";

/**
 * As JSON in a script tag. A found profile's documents are spliced in as the
 * text Firestore sent, already JSON, rather than parsed and serialised again.
 * `<` is escaped so a film title can never close the tag; the browser's
 * JSON.parse reads the escape back as `<`.
 */
export function toScriptJson(data: ProfileData) {
  const json = data.found
    ? `{"found":true,"handle":${JSON.stringify(data.handle)},${
        data.displayName === undefined
          ? ""
          : `"displayName":${JSON.stringify(data.displayName)},`
      }"links":${JSON.stringify(data.links)},"sections":${JSON.stringify(data.sections)},"documents":${data.documents}}`
    : JSON.stringify(data);
  return json.replace(/</g, "\\u003c");
}

/**
 * What the profile is said to hold, by the sections shown, so a description
 * never promises a list the page leaves out. The stats count as what the
 * reader has seen, being drawn from it.
 */
function describeContents(who: string, sections: Sections) {
  const seen = sections.seen || sections.seenStats;
  if (seen && sections.watchlist) {
    return `The films ${who} has seen and wants to see`;
  }
  if (seen) return `The films ${who} has seen`;
  if (sections.watchlist) return `The films ${who} wants to see`;
  return `${who}'s profile`;
}

/**
 * What the `<head>` says about a found profile. Made of the handle
 * (`[a-z0-9_-]`), the display name (stripped of everything HTML and JSON give
 * meaning to, and of a leading `$`, by `readDisplayName`) and fixed words, so
 * it needs no escaping in an attribute, in text, or inside the RSC payload's
 * JSON strings. With a name, the handle is beside it, so the address is never
 * hidden behind a name anyone could choose. No counts: the Worker doesn't
 * decode the lists, which is where they'd come from.
 */
export function describeProfile(
  handle: string,
  displayName: string | undefined,
  sections: Sections,
  origin: string,
) {
  return {
    title: displayName ? `${displayName} (@${handle})` : `${handle}'s films`,
    description: `${describeContents(
      displayName ? `${displayName} (@${handle})` : handle,
      sections,
    )}, on Clusterflick: every film showing in London.`,
    url: `${origin}/u/${handle}/`,
  };
}

function setAttribute(name: string, value: string) {
  return {
    element(element: Element) {
      element.setAttribute(name, value);
    },
  };
}

/**
 * The shell with this profile in it.
 *
 * `robots` and the canonical link are added here, not in the shell: Next
 * would render a `noindex` from the shell's payload again in the browser,
 * beside this `index, follow`. Tags added outside React's tree, it leaves be.
 */
export async function fillShell(
  shell: Response,
  data: ProfileData,
  status: 200 | 404,
  origin: string,
): Promise<Response> {
  let html = await shell.text();
  let head = `<script type="application/json" id="profile-data">${toScriptJson(data)}</script>`;
  let rewriter = new HTMLRewriter();

  if (data.found) {
    const { title, description, url } = describeProfile(
      data.handle,
      data.displayName,
      data.sections,
      origin,
    );
    if (!html.includes(SHELL_TITLE) || !html.includes(SHELL_DESCRIPTION)) {
      // The page still works; its title and description are the shell's.
      console.error("The shell's title or description has changed");
    }
    html = html
      .replaceAll(SHELL_TITLE, `${title} | Clusterflick`)
      .replaceAll(SHELL_DESCRIPTION, description);
    // Making a profile public is the consent to its being found.
    head += `<meta name="robots" content="index, follow"/><link rel="canonical" href="${url}"/>`;
    // For link previews, which read the HTML as sent and run no JavaScript.
    rewriter = rewriter
      .on('meta[property="og:title"]', setAttribute("content", title))
      .on(
        'meta[property="og:description"]',
        setAttribute("content", description),
      )
      .on('meta[property="og:url"]', setAttribute("content", url))
      .on('meta[name="twitter:title"]', setAttribute("content", title))
      .on(
        'meta[name="twitter:description"]',
        setAttribute("content", description),
      );
  } else {
    head += `<meta name="robots" content="noindex"/>`;
  }

  rewriter = rewriter.on("head", {
    element(element) {
      element.append(head, { html: true });
    },
  });

  const headers = new Headers({
    "Content-Type": shell.headers.get("Content-Type") ?? "text/html",
    // Not kept anywhere, so switching a profile off takes effect at once.
    "Cache-Control": "no-store",
  });
  return rewriter.transform(new Response(html, { status, headers }));
}
