import type { ProfileData } from "./profile";

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
 * As JSON in a script tag. `<` is escaped so a film title can never close the
 * tag; the browser's JSON.parse reads the escape back as `<`.
 */
export function toScriptJson(data: ProfileData) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function plural(count: number, one: string, many: string) {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/**
 * What the `<head>` says about a found profile. Made only of the handle
 * (`[a-z0-9_-]`), numbers and fixed words, so it needs no escaping in an
 * attribute, in text, or inside the RSC payload's JSON strings.
 */
export function describeProfile(
  data: Extract<ProfileData, { found: true }>,
  origin: string,
) {
  const title = `${data.handle}'s films`;
  const description =
    `${data.handle} has seen ${plural(data.seen.count, "film", "films")} ` +
    `and has ${plural(data.watchlist.count, "film", "films")} on their ` +
    `watchlist, on Clusterflick: every film showing in London.`;
  return { title, description, url: `${origin}/u/${data.handle}/` };
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
    const { title, description, url } = describeProfile(data, origin);
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
