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
      [
        "displayName",
        "favourites",
        "handle",
        "links",
        "public",
        "publicProfile",
        "sections",
      ],
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

describe("the name and links", () => {
  function reader(profile: Record<string, unknown>) {
    const store = publicReader("film-fan");
    return {
      ...store,
      "users/uid1/meta/profile": {
        handle: "film-fan",
        public: true,
        ...profile,
      },
    };
  }

  /**
   * The RSC payload's strings, read as the browser would: the script's
   * argument as JavaScript, then the string inside it as JSON. Throws if the
   * name broke either.
   */
  function readPayload(html: string) {
    const script = html.match(/self\.__next_f\.push\((.*?)\)<\/script>/s)?.[1];
    if (!script) throw new Error("No payload");
    const [, text] = JSON.parse(script) as [number, string];
    return JSON.parse(text) as [
      string,
      string,
      string,
      Record<string, string>,
    ][];
  }

  it("sends them, and the head is the name beside the handle", async () => {
    serve({
      store: reader({
        displayName: "Siobhán O'Brien",
        links: {
          letterboxd: "film_fan",
          imdb: "p.mbd2yexnoms6latfrdkzba2zxy",
        },
      }),
    });
    const { html, data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.displayName).toBe("Siobhán O'Brien");
    expect(data.links).toEqual({
      letterboxd: "film_fan",
      imdb: "p.mbd2yexnoms6latfrdkzba2zxy",
    });
    const title = "Siobhán O'Brien (@film-fan)";
    expect(html).toContain(`<title>${title} | Clusterflick</title>`);
    expect(html).toContain(`<meta property="og:title" content="${title}"`);
    expect(html).toContain(
      `The films ${title} has seen and wants to see, on Clusterflick`,
    );
    const [titleTag, description] = readPayload(html);
    expect(titleTag[3].children).toBe(`${title} | Clusterflick`);
    expect(description[3].content).toMatch(/^The films Siobhán O'Brien/);
  });

  it("strips a name that would break the page, and it stays plain text everywhere", async () => {
    serve({
      store: reader({
        displayName: '$"><script>alert(1)</script>\\ & \u2028x\u202Ey',
      }),
    });
    const { html, data } = await readProfileData(await get("/u/film-fan/"));
    const name = "scriptalert(1)/script xy";
    expect(data.displayName).toBe(name);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain(`<title>${name} (@film-fan) | Clusterflick</title>`);
    expect(html).toContain(
      `<meta property="og:title" content="${name} (@film-fan)"`,
    );
    expect(readPayload(html)[0][3].children).toBe(
      `${name} (@film-fan) | Clusterflick`,
    );
  });

  it("drops a leading $, which the payload would read as a reference", async () => {
    serve({ store: reader({ displayName: "$$ Money" }) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.displayName).toBe("Money");
  });

  it.each([
    ["too long", "é".repeat(51)],
    ["nothing left once stripped", "<<>>"],
    ["not a string", 42],
  ])(
    "a name %s is no name, and the head is the handle's",
    async (_, displayName) => {
      serve({ store: reader({ displayName }) });
      const { html, data } = await readProfileData(await get("/u/film-fan/"));
      expect(data).not.toHaveProperty("displayName");
      expect(html).toContain("<title>film-fan's films | Clusterflick</title>");
    },
  );

  it("drops links it can't show", async () => {
    serve({
      store: reader({
        links: {
          letterboxd: "film-fan",
          imdb: "ur99",
          website: "javascript:alert(1)",
          twitter: "film_fan",
        },
      }),
    });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.links).toEqual({ imdb: "ur99" });
  });

  it("drops an IMDb id of neither kind", async () => {
    serve({ store: reader({ links: { imdb: "p.Has-Capitals" } }) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.links).toEqual({});
  });

  it("sends no links as none", async () => {
    serve({ store: reader({}) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.links).toEqual({});
  });
});

describe("favourite films", () => {
  const film = (n: number) => ({
    id: String(100 + n),
    title: `Film ${n}`,
    year: "2001",
    posterPath: `/poster-${n}.jpg`,
  });

  function reader(profile: Record<string, unknown>) {
    const store = publicReader("film-fan", "uid1", {
      seen: { "101": { title: "Film 1", addedAt: 1 } },
    });
    return {
      ...store,
      "users/uid1/meta/profile": {
        handle: "film-fan",
        public: true,
        sections: {
          watchlist: true,
          seen: false,
          seenStats: false,
          favouriteVenues: true,
        },
        ...profile,
      },
    };
  }

  it("are sent in order, from the profile, while the Seen list stays hidden", async () => {
    serve({ store: reader({ favourites: [film(3), film(1)] }) });
    const { data, html } = await readProfileData(await get("/u/film-fan/"));
    expect(data.favourites).toEqual([film(3), film(1)]);
    // Nothing from the Seen list itself: it isn't asked for.
    const listsMask = firestoreRequests()
      .filter(({ url }) => url.endsWith(":batchGet"))
      .map(({ body }) => JSON.parse(body!).mask.fieldPaths)[1];
    expect(listsMask).not.toContain("seen");
    expect(JSON.stringify(data.documents)).not.toContain('"seen"');
    expect(html).toContain("Film 3");
  });

  it("drops what can't be drawn, repeats, and anything past four", async () => {
    serve({
      store: reader({
        favourites: [
          film(1),
          { id: "../x", title: "Bad" },
          { id: "102", title: "   " },
          film(1),
          { ...film(2), year: "c. 1920", posterPath: "https://x.y/p.jpg" },
          film(3),
          film(4),
          film(5),
        ],
      }),
    });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.favourites).toEqual([
      film(1),
      { id: "102", title: "Film 2" },
      film(3),
      film(4),
    ]);
  });

  it("are none when there are none, or they aren't a list", async () => {
    serve({ store: reader({ favourites: { 0: film(1) } }) });
    const { data } = await readProfileData(await get("/u/film-fan/"));
    expect(data.favourites).toEqual([]);
  });

  it("lend the first one with a poster to the link preview", async () => {
    serve({
      store: reader({
        displayName: "Siobhán O'Brien",
        favourites: [{ id: "100", title: "No Poster" }, film(2), film(3)],
      }),
    });
    const { html } = await readProfileData(await get("/u/film-fan/"));
    const poster = "https://image.tmdb.org/t/p/w500/poster-2.jpg";
    expect(html).toContain(`<meta property="og:image" content="${poster}"`);
    expect(html).toContain(`<meta name="twitter:image" content="${poster}"`);
    expect(html).toContain('<meta name="twitter:card" content="summary"');
    expect(html).toContain(
      `<meta property="og:image:alt" content="Siobhán O'Brien's favourite film"`,
    );
    // The site image's size, which isn't the poster's.
    expect(html).not.toContain("og:image:width");
    expect(html).not.toContain("og:image:height");
  });

  it("leave the site's preview image without a poster among them", async () => {
    serve({
      store: reader({ favourites: [{ id: "100", title: "No Poster" }] }),
    });
    const { html } = await readProfileData(await get("/u/film-fan/"));
    expect(html).toContain(
      '<meta property="og:image" content="https://clusterflick.com/images/og-image.png"/>',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image"/>',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200"/>');
  });

  it("escapes a title that would close the script tag", async () => {
    const title = "</script><script>alert(1)</script>";
    serve({ store: reader({ favourites: [{ id: "101", title }] }) });
    const { html, data } = await readProfileData(await get("/u/film-fan/"));
    expect(html).not.toContain("<script>alert(1)");
    expect(data.favourites).toEqual([{ id: "101", title }]);
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
