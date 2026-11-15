import { getProfileCache } from "./cache";
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
