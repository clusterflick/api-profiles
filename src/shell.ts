import type { ProfileData } from "./profile";

/**
 * The site's `/profile-shell/` page: its layout, built with each deploy's
 * assets, in its not-found state (`noindex`, a generic title). A profile is
 * that page with its data in a script tag and its `<head>` describing it.
 */
export const SHELL_PATH = "/profile-shell/";

/**
 * As JSON in a script tag. `<` is escaped so a film title can never close the
 * tag; the browser's JSON.parse reads `<` back as `<`.
 */
export function toScriptJson(data: ProfileData) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function plural(count: number, one: string, many: string) {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/** What the `<head>` says about a found profile. */
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

function setText(text: string) {
  return {
    element(element: Element) {
      element.setInnerContent(text);
    },
  };
}

/**
 * The shell with this profile in it. Handles are `[a-z0-9_-]` and the counts
 * are numbers, so nothing a reader typed reaches an attribute; `setInnerContent`
 * escapes the title, and the data is escaped for its script tag.
 */
export function fillShell(
  shell: Response,
  data: ProfileData,
  status: 200 | 404,
  origin: string,
): Response {
  let rewriter = new HTMLRewriter().on("head", {
    element(head) {
      head.append(
        `<script type="application/json" id="profile-data">${toScriptJson(data)}</script>`,
        { html: true },
      );
    },
  });

  if (data.found) {
    const { title, description, url } = describeProfile(data, origin);
    const pageTitle = `${title} | Clusterflick`;
    rewriter = rewriter
      .on("title", setText(pageTitle))
      .on('meta[name="description"]', setAttribute("content", description))
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
      )
      .on('link[rel="canonical"]', setAttribute("href", url))
      // Making a profile public is the consent to its being found.
      .on('meta[name="robots"]', setAttribute("content", "index, follow"));
  } else {
    // The shell's own canonical names /profile-shell/, which isn't this page.
    rewriter = rewriter.on('link[rel="canonical"]', {
      element(element) {
        element.remove();
      },
    });
  }

  const headers = new Headers({
    "Content-Type": shell.headers.get("Content-Type") ?? "text/html",
    // Not kept anywhere, so switching a profile off takes effect at once.
    "Cache-Control": "no-store",
  });
  return rewriter.transform(new Response(shell.body, { status, headers }));
}
