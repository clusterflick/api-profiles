import {
  AuthError,
  getBearerToken,
  verifyFirebaseToken,
} from "@clusterflick/accounts/auth";
import { isUid } from "@clusterflick/accounts/firestore";
import { getProfileCache, getUidIndex } from "./cache";
import { HANDLE_PATTERN } from "./routes";

export const PURGE_PATH = "/api/profiles/purge";

/** A rename names two: the handle given up and the one taken. */
const MAX_HANDLES = 2;
const MAX_BODY_BYTES = 1024;

function json(body: unknown, status: number, headers: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

const error = (message: string, status: number, headers?: HeadersInit) =>
  json({ error: message }, status, headers);

/** Equal in constant time, so a wrong secret says nothing of the right one. */
async function isSecret(given: string, secret: string) {
  const digest = (text: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

type PurgeBody = { uid?: string; handles: string[] };

async function parseBody(request: Request): Promise<PurgeBody | string> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return "Body too large";
  if (text === "") return { handles: [] };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "Body must be JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Body must be an object";
  }
  const { uid, handles = [] } = body as { uid?: unknown; handles?: unknown };
  if (
    !Array.isArray(handles) ||
    handles.length > MAX_HANDLES ||
    !handles.every((h) => typeof h === "string" && HANDLE_PATTERN.test(h))
  ) {
    return `handles must be up to ${MAX_HANDLES} valid handles`;
  }
  if (uid !== undefined && !isUid(uid)) {
    return "uid must be a uid";
  }
  return { ...(uid !== undefined && { uid }), handles };
}

/**
 * `POST /api/profiles/purge`: drops the cached copies of a reader's profile,
 * so their next view reads Firestore. Called after every write a profile
 * shows.
 *
 * The site calls it with the reader's Firebase ID token and purges their own
 * copies, found by uid in `UidIndex`; `handles` adds copies the index can't
 * know, which a profile save names: the handle given up, and one just taken
 * that a visitor may have found empty. The scripts, which run as the service
 * account and have no ID token, call it with `PURGE_SECRET` and name the
 * reader's `uid`.
 *
 * A purge only ever makes the next view read Firestore, so the worst a
 * caller can do is cost reads: the per-reader limit caps that.
 */
export async function handlePurge(
  request: Request,
  env: Env,
  keys?: Parameters<typeof verifyFirebaseToken>[2],
): Promise<Response> {
  if (request.method !== "POST") {
    return error("Method not allowed", 405, { Allow: "POST" });
  }
  const token = getBearerToken(request);
  if (!token) return error("Sign in required", 401);

  const body = await parseBody(request);
  if (typeof body === "string") return error(body, 400);

  let uid: string | undefined;
  let via: "secret" | "reader";
  if (await isSecret(token, env.PURGE_SECRET)) {
    via = "secret";
    uid = body.uid;
    if (!uid && body.handles.length === 0) {
      return error("Name a uid or handles", 400);
    }
  } else {
    via = "reader";
    if (body.uid !== undefined) return error("uid is only for scripts", 400);
    try {
      uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID, keys);
    } catch (e) {
      if (e instanceof AuthError) return error(e.message, e.status);
      throw e;
    }
    const { success } = await env.PURGE_LIMIT.limit({ key: uid });
    if (!success) {
      return error("Too many requests", 429, { "Retry-After": "60" });
    }
  }

  const indexed = uid ? await getUidIndex(env, uid).handles() : [];
  const handles = [...new Set([...indexed, ...body.handles])];
  await Promise.all(
    handles.map((handle) => getProfileCache(env, handle).purge()),
  );
  console.log(JSON.stringify({ event: "profile-purge", via, handles }));
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
