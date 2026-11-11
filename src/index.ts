import { Firestore } from "./firestore";
import { getAccessToken } from "./google-auth";
import { loadProfile, type ProfileData } from "./profile";
import { matchRoute } from "./routes";
import { fillShell, SHELL_PATH } from "./shell";

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

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
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
    const db = new Firestore(env.FIREBASE_PROJECT_ID, () =>
      getAccessToken(env.FIREBASE_SERVICE_ACCOUNT),
    );
    const profile = await loadProfile(db, route.handle);
    return await respondWithShell(
      env,
      profile ?? { found: false, handle: route.handle },
      profile ? 200 : 404,
    );
  } catch (e) {
    return unavailable(e);
  }
}

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
