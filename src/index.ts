import { getProfileCache } from "./cache";
import { cardFileName } from "./card-content";
import type { ProfileData } from "./profile";
import { handlePurge, PURGE_PATH } from "./purge";
import { matchRoute } from "./routes";
import { fillShell, SHELL_PATH } from "./shell";

export { ProfileCache, UidIndex } from "./cache";

/**
 * Not a 404: that would tell the visitor, and search engines, that the profile
 * doesn't exist. Nothing is kept, so the next request tries again.
 */
function unavailable(e: unknown) {
  console.error("Profile unavailable", e);
  return new Response(
    "This profile can't be shown right now. Try again soon.",
    {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "60",
      },
    },
  );
}

async function respondWithShell(
  env: Env,
  data: ProfileData,
  status: 200 | 404,
) {
  const shell = await fetch(new URL(SHELL_PATH, env.SITE_ORIGIN));
  if (!shell.ok) {
    throw new Error(`Shell page answered ${shell.status}`);
  }
  // The canonical address is the site's, wherever the request came in.
  return fillShell(shell, data, status, env.SITE_ORIGIN);
}

/** One IP viewing more uncached profiles a minute than `MISS_LIMIT` allows. */
function limited() {
  return new Response("Too many profiles at once. Try again in a minute.", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
}

/**
 * How long a card may be kept by whoever fetched it. Short, so a profile made
 * private stops showing in a browser's copy within the cache's own five
 * minutes; a site that has stored its own preview can't be reached either way.
 */
const CARD_MAX_AGE = 5 * 60;

/** The image a link to the profile previews with (`ProfileCache.card`). */
async function respondWithCard(
  env: Env,
  url: URL,
  handle: string,
  hash: string,
  ip: string,
): Promise<Response> {
  const result = await getProfileCache(env, handle).card(handle, ip, hash);
  // Logs only, for the same reasons as a view.
  console.log(
    JSON.stringify({ event: "profile-card", handle, state: result.state }),
  );
  switch (result.state) {
    case "hit":
    case "rendered":
      return new Response(result.jpeg, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": `public, max-age=${CARD_MAX_AGE}`,
        },
      });
    case "redirect":
      // To the card for the favourites as they are now, so a preview made
      // before they changed still finds one.
      return new Response(null, {
        status: 302,
        headers: {
          // Absolute, as the page's `og:image` is: a site fetching a preview
          // may not resolve a relative one.
          Location: new URL(
            `/u/${handle}/${cardFileName(result.hash)}`,
            url,
          ).toString(),
          "Cache-Control": "no-store",
        },
      });
    case "none":
      // One answer for unknown, private, revoked or posterless, as for a view.
      return new Response("Not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    case "limited":
      return limited();
    case "unavailable":
      return unavailable("The card couldn't be drawn");
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/profiles/")) {
    if (url.pathname === PURGE_PATH) return handlePurge(request, env);
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const route = matchRoute(url);
  if (route.kind === "redirect") {
    return new Response(null, {
      status: route.status,
      headers: { Location: new URL(route.location, url).toString() },
    });
  }

  try {
    if (route.kind === "not-found") {
      return await respondWithShell(env, { found: false }, 404);
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (route.kind === "card") {
      return await respondWithCard(env, url, route.handle, route.hash, ip);
    }
    const cached = await getProfileCache(env, route.handle).load(
      route.handle,
      ip,
    );
    // Logs only: a header saying a copy was cached would tell a visitor
    // someone else had just viewed it, and could tell a private profile's
    // not-found from a missing one's.
    console.log(
      JSON.stringify({
        event: "profile-view",
        handle: route.handle,
        state: cached.state,
        ...("ageMs" in cached && { ageMs: cached.ageMs }),
      }),
    );
    if (!("data" in cached)) {
      return cached.state === "limited"
        ? limited()
        : unavailable("Firestore couldn't be read, with no copy to serve");
    }
    return await respondWithShell(
      env,
      cached.data,
      cached.data.found ? 200 : 404,
    );
  } catch (e) {
    return unavailable(e);
  }
}

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
