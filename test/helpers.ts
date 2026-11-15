import { env } from "cloudflare:workers";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWTPayload,
} from "jose";

export const PROJECT_ID = "clusterflick-com";
export const SITE_ORIGIN = "https://clusterflick.com";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;

/** The service account made up in vitest.config.ts, and its public key. */
const testEnv = env as unknown as {
  FIREBASE_SERVICE_ACCOUNT: string;
  PURGE_SECRET: string;
  TEST_SERVICE_ACCOUNT_PUBLIC_JWK: string;
};
export const SERVICE_ACCOUNT = testEnv.FIREBASE_SERVICE_ACCOUNT;
export const SERVICE_ACCOUNT_EMAIL = JSON.parse(SERVICE_ACCOUNT).client_email;
export const SERVICE_ACCOUNT_PUBLIC_KEY = await importJWK(
  JSON.parse(testEnv.TEST_SERVICE_ACCOUNT_PUBLIC_JWK),
  "RS256",
);
export const PURGE_SECRET = testEnv.PURGE_SECRET;

/**
 * The shell as the site builds it, cut down to what the Worker touches: the
 * `<head>`, and the inline RSC payload that repeats its title and description.
 */
export const SHELL_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charSet="utf-8"/>
<title>Profile Not Found | Clusterflick</title>
<meta name="description" content="No public profile at this address."/>
<meta property="og:title" content="Clusterflick – Every film showing in London"/>
<meta property="og:description" content="Every film showing in London"/>
<meta property="og:url" content="https://clusterflick.com/"/>
<meta property="og:image" content="https://clusterflick.com/images/og-image.png"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:image:alt" content="Clusterflick"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="https://clusterflick.com/images/og-image.png"/>
<meta name="twitter:title" content="Clusterflick – Every film showing in London"/>
<meta name="twitter:description" content="Every film showing in London"/>
</head><body><main id="profile"></main>
<script>self.__next_f.push([1,"[[\\"$\\",\\"title\\",\\"0\\",{\\"children\\":\\"Profile Not Found | Clusterflick\\"}],[\\"$\\",\\"meta\\",\\"1\\",{\\"name\\":\\"description\\",\\"content\\":\\"No public profile at this address.\\"}]]"])</script>
</body></html>`;

/** A JavaScript value as a Firestore REST value, as the SDK would store it. */
export function encodeValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  return {
    mapValue: { fields: encodeFields(value as Record<string, unknown>) },
  };
}

function encodeFields(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeValue(value)]),
  );
}

export type Store = Record<string, Record<string, unknown>>;

export type FakeOptions = {
  store?: Store;
  /** Answers Google's token endpoint gives instead of a token. */
  tokenStatus?: number;
  firestoreStatus?: number;
  shellStatus?: number;
};

/**
 * Stands in for every upstream the Worker calls: Google's token endpoint,
 * Firestore's REST API over `store` (document path → data), and the site.
 * Records each request so tests can see what was asked.
 */
export function fakeUpstreams({
  store = {},
  tokenStatus = 200,
  firestoreStatus = 200,
  shellStatus = 200,
}: FakeOptions = {}) {
  const requests: { url: string; body?: string }[] = [];

  const toDocument = (path: string, fields?: string[]) => {
    const data = store[path];
    const kept = fields
      ? Object.fromEntries(
          Object.entries(data).filter(([k]) => fields.includes(k)),
        )
      : data;
    return { name: `${ROOT}/${path}`, fields: encodeFields(kept) };
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.text() : undefined;
    requests.push({ url: request.url, body });
    const url = new URL(request.url);

    if (url.href === "https://oauth2.googleapis.com/token") {
      if (tokenStatus !== 200)
        return new Response("denied", { status: tokenStatus });
      return Response.json({
        access_token: "access-token",
        expires_in: 3599,
        token_type: "Bearer",
      });
    }
    if (url.hostname === "firestore.googleapis.com") {
      if (firestoreStatus !== 200) {
        return new Response("unavailable", { status: firestoreStatus });
      }
      const name = decodeURIComponent(url.pathname.replace(/^\/v1\//, ""));
      if (name === `${ROOT}:batchGet`) {
        const { documents, mask } = JSON.parse(body!) as {
          documents: string[];
          mask: { fieldPaths: string[] };
        };
        return Response.json(
          documents
            .map((full) => full.slice(ROOT.length + 1))
            .reverse() // Firestore promises no order.
            .map((path) =>
              store[path]
                ? { found: toDocument(path, mask.fieldPaths), readTime: "now" }
                : { missing: `${ROOT}/${path}`, readTime: "now" },
            ),
        );
      }
      const path = name.slice(ROOT.length + 1);
      if (!store[path]) {
        return Response.json(
          { error: { code: 404, status: "NOT_FOUND" } },
          { status: 404 },
        );
      }
      return Response.json(toDocument(path));
    }
    if (url.href === `${SITE_ORIGIN}/profile-shell/`) {
      if (shellStatus !== 200)
        return new Response("Not found", { status: shellStatus });
      return new Response(SHELL_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ETag: '"shell"',
        },
      });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  };

  return { fetch, requests };
}

/** A reader with a public profile at `handle`, as the site writes one. */
export function publicReader(
  handle: string,
  uid = "uid1",
  lists: Record<string, unknown> = {},
): Store {
  return {
    [`handles/${handle}`]: { uid },
    [`users/${uid}/meta/profile`]: { handle, public: true },
    [`users/${uid}/meta/capabilities`]: { publicProfile: { grantedAt: 1 } },
    [`users/${uid}`]: { seen: {}, watchlist: {}, ...lists },
  };
}

/** The data the Worker put in the page. */
export async function readProfileData(response: Response) {
  const html = await response.text();
  const json = html.match(
    /<script type="application\/json" id="profile-data">(.*?)<\/script>/s,
  )?.[1];
  return { html, data: json === undefined ? undefined : JSON.parse(json) };
}

/**
 * Firebase ID tokens for the purge, as api-tmdb-search's tests make them: a
 * key of our own standing in for Google's, which `handlePurge` is given.
 */
const firebaseKeys = await generateKeyPair("RS256");
export const FIREBASE_TEST_KEYS = createLocalJWKSet({
  keys: [
    {
      ...(await exportJWK(firebaseKeys.publicKey)),
      kid: "firebase-test-key",
      alg: "RS256",
    },
  ],
});

export function signFirebaseToken(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: "uid1",
    iat: now - 60,
    exp: now + 3600,
    auth_time: now - 60,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "firebase-test-key" })
    .sign(firebaseKeys.privateKey);
}
