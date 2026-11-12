import { env } from "cloudflare:workers";
import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../src/google-auth";
import { handleRequest } from "../src/index";
import { decodeFields, type Fields } from "../src/firestore";
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

  /** The documents the page was sent, decoded, by the last part of their names. */
  function readDocuments(documents: unknown) {
    return Object.fromEntries(
      (documents as { found?: { name: string; fields?: Fields } }[]).flatMap(
        ({ found }) =>
          found
            ? [
                [
                  found.name.split("/").slice(-2).join("/"),
                  decodeFields(found.fields),
                ],
              ]
            : [],
      ),
    );
  }

  it("is the shell, with the profile in it and its head describing it", async () => {
    serve({
      store: {
        ...publicReader("film-fan", "uid1", {
          seen: { "101": film(1), "102": { title: "No Year", addedAt: 5 } },
          watchlist: { "201": film(2) },
          favouriteVenues: { "venue-1": { name: "The Rio", addedAt: 1 } },
        }),
        "users/uid1/meta/films": {
          films: {
            "101": { genres: ["18"], directors: ["9"], cast: [], runtime: 101 },
          },
          people: { "9": "Agnès Varda" },
        },
      },
    });
    const response = await get("/u/film-fan/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("ETag")).toBeNull();

    const { html, data } = await readProfileData(response);
    expect(data.found).toBe(true);
    expect(data.handle).toBe("film-fan");
    expect(readDocuments(data.documents)).toEqual({
      // The uid is taken out of the names.
      "users/-": {
        seen: { "101": film(1), "102": { title: "No Year", addedAt: 5 } },
        watchlist: { "201": film(2) },
        favouriteVenues: { "venue-1": { name: "The Rio", addedAt: 1 } },
      },
      "meta/films": {
        films: {
          "101": { genres: ["18"], directors: ["9"], cast: [], runtime: 101 },
        },
        people: { "9": "Agnès Varda" },
      },
    });
    expect(html).toContain("<title>film-fan's films | Clusterflick</title>");
    // Replaced in the RSC payload too, or the browser would put them back.
    expect(html).not.toContain("Profile Not Found");
    expect(html).not.toContain("No public profile at this address.");
    expect(html).toContain(
      '\\"children\\":\\"film-fan\'s films | Clusterflick\\"',
    );
    expect(html).toContain(
      '<link rel="canonical" href="https://clusterflick.com/u/film-fan/"',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://clusterflick.com/u/film-fan/"',
    );
    expect(html).toContain(
      '<meta property="og:title" content="film-fan\'s films"',
    );
    expect(html).toContain("The films film-fan has seen and wants to see");
    expect(html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      '<meta name="robots" content="index, follow"/>',
    ]);
    expect(html.match(/<link rel="canonical"[^>]*>/g)).toHaveLength(1);
    expect(html).not.toContain("uid1");
  });

  it("asks only for the published fields", async () => {
    serve({ store: publicReader("film-fan") });
    await get("/u/film-fan/");
    const masks = firestoreRequests()
      .filter(({ url }) => url.endsWith(":batchGet"))
      .map(({ body }) => JSON.parse(body!).mask.fieldPaths.sort());
    expect(masks).toEqual([
      ["handle", "public", "publicProfile", "sections"],
      ["favouriteVenues", "films", "people", "seen", "watchlist"],
    ]);
  });

  it("shows every section of a profile made public before they could be chosen", async () => {
    serve({ store: publicReader("film-fan") });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.sections).toEqual({
      watchlist: true,
      seen: true,
      seenStats: true,
      favouriteVenues: true,
    });
  });

  it("sends every film, however long the list", async () => {
    const seen = Object.fromEntries(
      Array.from({ length: 3000 }, (_, n) => [String(n), film(n)]),
    );
    serve({ store: publicReader("film-fan", "uid1", { seen }) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(
      Object.keys(readDocuments(data.documents)["users/-"].seen as object),
    ).toHaveLength(3000);
  });

  it("sends a reader with no film details yet as missing, not as an error", async () => {
    serve({ store: publicReader("film-fan") });
    const response = await get("/u/film-fan/");
    expect(response.status).toBe(200);
    const { data } = await readProfileData(response);
    expect(data.documents).toContainEqual(
      expect.objectContaining({
        missing: expect.stringMatching(/users\/-\/meta\/films$/),
      }),
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
    expect(readDocuments(data.documents)["users/-"].seen).toEqual({
      "1": { title, addedAt: 1 },
    });
  });

  it("answers HEAD as GET", async () => {
    serve({ store: publicReader("film-fan") });
    expect((await get("/u/film-fan/", { method: "HEAD" })).status).toBe(200);
  });
});

describe("the sections shown", () => {
  const everything = {
    seen: { "101": { title: "Seen", addedAt: 1 } },
    watchlist: { "201": { title: "Wanted", addedAt: 2 } },
    favouriteVenues: { "venue-1": { name: "The Rio", addedAt: 1 } },
  };
  const details = {
    films: { "101": { genres: ["18"], directors: [], cast: [] } },
    people: {},
  };
  const all = {
    watchlist: true,
    seen: true,
    seenStats: true,
    favouriteVenues: true,
  };

  function reader(sections: Record<string, unknown>) {
    const store = publicReader("film-fan", "uid1", everything);
    return {
      ...store,
      "users/uid1/meta/profile": {
        handle: "film-fan",
        public: true,
        sections,
      },
      "users/uid1/meta/films": details,
    };
  }

  /** The third request: what was asked for, of which documents. */
  function listsRequest() {
    const request = firestoreRequests().filter(({ url }) =>
      url.endsWith(":batchGet"),
    )[1];
    if (!request) return undefined;
    const { documents, mask } = JSON.parse(request.body!);
    return {
      documents: (documents as string[]).map((name) =>
        name.split("/").slice(-2).join("/"),
      ),
      fields: (mask.fieldPaths as string[]).sort(),
    };
  }

  it("asks for nothing a hidden section needs", async () => {
    serve({
      store: reader({ ...all, watchlist: false, favouriteVenues: false }),
    });
    const { data, html } = await readProfileData(await get("/u/film-fan/"));
    expect(listsRequest()).toEqual({
      documents: ["users/uid1", "meta/films"],
      fields: ["films", "people", "seen"],
    });
    expect(data.sections).toEqual({
      ...all,
      watchlist: false,
      favouriteVenues: false,
    });
    expect(html).not.toContain("Wanted");
    expect(html).not.toContain("The Rio");
  });

  it("sends the Seen list for the stats while the list itself is hidden", async () => {
    serve({ store: reader({ ...all, seen: false }) });
    await get("/u/film-fan/");
    expect(listsRequest()).toEqual({
      documents: ["users/uid1", "meta/films"],
      fields: ["favouriteVenues", "films", "people", "seen", "watchlist"],
    });
  });

  it("leaves the film details out without the stats", async () => {
    serve({ store: reader({ ...all, seenStats: false }) });
    await get("/u/film-fan/");
    expect(listsRequest()).toEqual({
      documents: ["users/uid1"],
      fields: ["favouriteVenues", "seen", "watchlist"],
    });
  });

  it("reads no lists at all with every section hidden", async () => {
    serve({
      store: reader({
        watchlist: false,
        seen: false,
        seenStats: false,
        favouriteVenues: false,
      }),
    });
    const response = await get("/u/film-fan/");
    expect(response.status).toBe(200);
    const { data } = await readProfileData(response);
    expect(listsRequest()).toBeUndefined();
    expect(data.documents).toEqual([]);
  });

  it("hides a section the map leaves out, or doesn't set to true", async () => {
    serve({ store: reader({ watchlist: true, seen: "yes" }) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.sections).toEqual({
      watchlist: true,
      seen: false,
      seenStats: false,
      favouriteVenues: false,
    });
    expect(listsRequest()?.fields).toEqual(["watchlist"]);
  });

  it.each([
    [{ ...all, watchlist: false }, "The films film-fan has seen,"],
    [
      { ...all, seen: false, seenStats: false },
      "The films film-fan wants to see,",
    ],
    [{ ...all, watchlist: false, seen: false }, "The films film-fan has seen,"],
    [
      {
        watchlist: false,
        seen: false,
        seenStats: false,
        favouriteVenues: true,
      },
      "film-fan's profile,",
    ],
  ])("is described by what it shows (%o)", async (sections, description) => {
    serve({ store: reader(sections) });
    const { html } = await readProfileData(await get("/u/film-fan/"));
    expect(html).toContain(`<meta name="description" content="${description}`);
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

  it("never fetches a private profile's lists", async () => {
    serve({
      store: {
        ...reader,
        "users/uid1/meta/profile": { handle: "film-fan", public: false },
      },
    });
    await get("/u/film-fan/");
    expect(
      firestoreRequests().map(({ body }) => body && JSON.parse(body).documents),
    ).toEqual([
      undefined,
      [
        expect.stringMatching(/users\/uid1\/meta\/profile$/),
        expect.stringMatching(/users\/uid1\/meta\/capabilities$/),
      ],
    ]);
  });

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
