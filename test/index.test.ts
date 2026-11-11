import { env } from "cloudflare:workers";
import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../src/google-auth";
import { handleRequest } from "../src/index";
import { RECENT_FILMS } from "../src/profile";
import {
  fakeUpstreams,
  publicReader,
  readProfileData,
  SERVICE_ACCOUNT,
  SERVICE_ACCOUNT_EMAIL,
  SERVICE_ACCOUNT_PUBLIC_KEY,
  type FakeOptions,
  type Store,
} from "./helpers";

const testEnv = { ...env, FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT };

let upstreams: ReturnType<typeof fakeUpstreams>;

function serve(options: FakeOptions = {}) {
  upstreams = fakeUpstreams(options);
  vi.spyOn(globalThis, "fetch").mockImplementation(upstreams.fetch);
}

const get = (path: string, init?: RequestInit) =>
  handleRequest(new Request(`https://clusterflick.com${path}`, init), testEnv);

const firestoreRequests = () =>
  upstreams.requests.filter(({ url }) =>
    url.includes("firestore.googleapis.com"),
  );

beforeEach(() => {
  clearAccessToken();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redirects", () => {
  it.each([
    ["/u", 301, "https://clusterflick.com/u/"],
    ["/u/", 302, "https://clusterflick.com/personalise/"],
    ["/u/Film-Fan", 301, "https://clusterflick.com/u/film-fan/"],
  ])(
    "%s → %i %s, without reading Firestore",
    async (path, status, location) => {
      serve();
      const response = await get(path);
      expect(response.status).toBe(status);
      expect(response.headers.get("Location")).toBe(location);
      expect(upstreams.requests).toEqual([]);
    },
  );
});

describe("a public profile", () => {
  const film = (n: number) => ({
    title: `Film ${n}`,
    year: "2001",
    posterPath: `/poster-${n}.jpg`,
    addedAt: 1_700_000_000_000 + n,
  });

  it("is the shell, with the profile in it and its head describing it", async () => {
    serve({
      store: publicReader("film-fan", "uid1", {
        seen: { "101": film(1), "102": { title: "No Year", addedAt: 5 } },
        watchlist: { "201": film(2) },
        favouriteVenues: { "venue-1": { name: "The Rio", addedAt: 1 } },
      }),
    });
    const response = await get("/u/film-fan/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("ETag")).toBeNull();

    const { html, data } = await readProfileData(response);
    expect(data).toEqual({
      found: true,
      handle: "film-fan",
      seen: {
        count: 2,
        films: [
          {
            id: "101",
            title: "Film 1",
            year: "2001",
            posterPath: "/poster-1.jpg",
          },
          { id: "102", title: "No Year" },
        ],
      },
      watchlist: {
        count: 1,
        films: [
          {
            id: "201",
            title: "Film 2",
            year: "2001",
            posterPath: "/poster-2.jpg",
          },
        ],
      },
    });
    expect(html).toContain("<title>film-fan's films | Clusterflick</title>");
    // Replaced in the RSC payload too, or the browser would put them back.
    expect(html).not.toContain("Profile Not Found");
    expect(html).not.toContain("No public profile at this address.");
    expect(html).toContain(
      '\\"children\\":\\"film-fan\'s films | Clusterflick\\"',
    );
    expect(html).toContain('<meta name="robots" content="index, follow"');
    expect(html).toContain(
      '<link rel="canonical" href="https://clusterflick.com/u/film-fan/"',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://clusterflick.com/u/film-fan/"',
    );
    expect(html).toContain(
      '<meta property="og:title" content="film-fan\'s films"',
    );
    expect(html).toContain(
      "film-fan has seen 2 films and has 1 film on their watchlist",
    );
    expect(html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      '<meta name="robots" content="index, follow"/>',
    ]);
    expect(html.match(/<link rel="canonical"[^>]*>/g)).toHaveLength(1);
    expect(html).not.toContain("uid1");
    expect(html).not.toContain("The Rio");
  });

  it("asks only for the fields it needs, never the reader's venues", async () => {
    serve({ store: publicReader("film-fan") });
    await get("/u/film-fan/");
    const batch = firestoreRequests().find(({ url }) =>
      url.endsWith(":batchGet"),
    );
    expect(JSON.parse(batch!.body!).mask.fieldPaths.sort()).toEqual(
      ["handle", "public", "publicProfile", "seen", "watchlist"].sort(),
    );
  });

  it(`sends the ${RECENT_FILMS} most recently added of each list, and the count`, async () => {
    const seen = Object.fromEntries(
      Array.from({ length: 30 }, (_, n) => [String(n), film(n)]),
    );
    serve({ store: publicReader("film-fan", "uid1", { seen }) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.seen.count).toBe(30);
    expect(data.seen.films.map(({ id }: { id: string }) => id)).toEqual(
      Array.from({ length: RECENT_FILMS }, (_, n) => String(29 - n)),
    );
  });

  it("escapes a title that would close the script tag", async () => {
    const title = "</script><script>alert(1)</script>";
    serve({
      store: publicReader("film-fan", "uid1", {
        seen: { "1": { title, addedAt: 1 } },
      }),
    });
    const { html, data } = await readProfileData(await get("/u/film-fan/"));
    expect(html).not.toContain("<script>alert(1)");
    expect(data.seen.films[0].title).toBe(title);
  });

  it("answers HEAD as GET", async () => {
    serve({ store: publicReader("film-fan") });
    expect((await get("/u/film-fan/", { method: "HEAD" })).status).toBe(200);
  });
});

describe("not found", () => {
  const reader = publicReader("film-fan");
  const without = (key: string): Store =>
    Object.fromEntries(Object.entries(reader).filter(([k]) => k !== key));

  const cases: [string, Store][] = [
    ["an unknown handle", {}],
    [
      "a private profile",
      {
        ...reader,
        "users/uid1/meta/profile": { handle: "film-fan", public: false },
      },
    ],
    ["a revoked capability", { ...reader, "users/uid1/meta/capabilities": {} }],
    ["no capabilities document", without("users/uid1/meta/capabilities")],
    [
      "a handle whose profile names another",
      {
        ...reader,
        "users/uid1/meta/profile": { handle: "someone", public: true },
      },
    ],
    ["a handle whose profile is gone", without("users/uid1/meta/profile")],
    ["a handle with no uid", { ...reader, "handles/film-fan": {} }],
    [
      "a handle with a uid that isn't one",
      { ...reader, "handles/film-fan": { uid: "../x" } },
    ],
  ];

  it.each(cases)(
    "%s is the not-found shell, identical in every case",
    async (_, store) => {
      serve({ store });
      const response = await get("/u/film-fan/");
      expect(response.status).toBe(404);
      const { html, data } = await readProfileData(response);
      expect(data).toEqual({ found: false, handle: "film-fan" });

      serve({});
      const unknown = await readProfileData(await get("/u/film-fan/"));
      expect(html).toBe(unknown.html);
    },
  );

  it("is noindex, with the shell's title and no canonical", async () => {
    serve({});
    const { html } = await readProfileData(await get("/u/film-fan/"));
    expect(html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      '<meta name="robots" content="noindex"/>',
    ]);
    expect(html).toContain("<title>Profile Not Found | Clusterflick</title>");
    expect(html).not.toContain('rel="canonical"');
  });

  it.each(["/u/ab/", "/u/film-fan/seen/", "/u/film.fan/"])(
    "%s is not found without reading Firestore, and names no handle",
    async (path) => {
      serve({ store: publicReader("film-fan") });
      const response = await get(path);
      expect(response.status).toBe(404);
      expect((await readProfileData(response)).data).toEqual({ found: false });
      expect(firestoreRequests()).toEqual([]);
    },
  );
});

describe("failures are not 404s", () => {
  it.each<[string, FakeOptions]>([
    ["the token exchange fails", { tokenStatus: 400 }],
    ["Firestore fails", { firestoreStatus: 500 }],
    ["the shell can't be fetched", { shellStatus: 404 }],
  ])("%s → 503", async (_, options) => {
    serve({ store: publicReader("film-fan"), ...options });
    const response = await get("/u/film-fan/");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("a malformed key is a 503", async () => {
    serve({ store: publicReader("film-fan") });
    const response = await handleRequest(
      new Request("https://clusterflick.com/u/film-fan/"),
      { ...testEnv, FIREBASE_SERVICE_ACCOUNT: "not json" },
    );
    expect(response.status).toBe(503);
  });

  it("refuses other methods", async () => {
    serve();
    const response = await get("/u/film-fan/", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("the access token", () => {
  const tokenRequests = () =>
    upstreams.requests.filter(({ url }) =>
      url.startsWith("https://oauth2.googleapis.com"),
    );

  it("is a JWT signed with the service account's key, for Firestore", async () => {
    serve({ store: publicReader("film-fan") });
    await get("/u/film-fan/");
    const assertion = new URLSearchParams(tokenRequests()[0].body).get(
      "assertion",
    )!;
    const { payload, protectedHeader } = await jwtVerify(
      assertion,
      SERVICE_ACCOUNT_PUBLIC_KEY,
      {
        issuer: SERVICE_ACCOUNT_EMAIL,
        audience: "https://oauth2.googleapis.com/token",
      },
    );
    expect(payload.scope).toBe("https://www.googleapis.com/auth/datastore");
    expect(protectedHeader.kid).toBe("test-key");
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  it("is reused between requests", async () => {
    serve({ store: publicReader("film-fan") });
    await get("/u/film-fan/");
    await get("/u/film-fan/");
    expect(tokenRequests()).toHaveLength(1);
  });

  it("is asked for again after a failed exchange", async () => {
    serve({ store: publicReader("film-fan"), tokenStatus: 500 });
    expect((await get("/u/film-fan/")).status).toBe(503);
    serve({ store: publicReader("film-fan") });
    expect((await get("/u/film-fan/")).status).toBe(200);
  });
});
