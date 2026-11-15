import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { getProfileCache } from "../src/cache";
import { CARD_VERSION, getCardFilms, getCardHash } from "../src/card-content";
import { clearAccessToken } from "@clusterflick/accounts/google-auth";
import { handleRequest } from "../src/index";
import { handlePurge } from "../src/purge";
import {
  fakeUpstreams,
  publicReader,
  PURGE_SECRET,
  type FakeOptions,
  type Store,
} from "./helpers";

let upstreams: ReturnType<typeof fakeUpstreams>;
let log: MockInstance<typeof console.log>;
let ipCount = 0;
let ip = "";

function serve(options: FakeOptions = {}) {
  upstreams = fakeUpstreams(options);
  vi.spyOn(globalThis, "fetch").mockImplementation(upstreams.fetch);
}

const get = (path: string) =>
  handleRequest(
    new Request(`https://clusterflick.com${path}`, {
      headers: { "CF-Connecting-IP": ip },
    }),
    env,
  );

const posterFetches = () =>
  upstreams.requests.filter(({ url }) => url.includes("image.tmdb.org"));

const film = (n: number) => ({
  id: String(100 + n),
  title: `Film ${n}`,
  posterPath: `/poster-${n}.jpg`,
});

function reader(profile: Record<string, unknown> = {}): Store {
  return {
    ...publicReader("film-fan"),
    "users/uid1/meta/profile": {
      handle: "film-fan",
      public: true,
      favourites: [film(1), film(2), film(3), film(4)],
      ...profile,
    },
  };
}

const hashOf = (favourites: ReturnType<typeof film>[]) =>
  getCardHash("film-fan", getCardFilms(favourites));

const cardPath = (hash: string) => `/u/film-fan/card-${hash}.jpg`;

/**
 * A JPEG's width and height, from its start-of-frame segment, and whether
 * it's baseline (SOF0) rather than progressive (SOF2).
 */
async function jpegFrame(response: Response) {
  const bytes = new DataView(await response.arrayBuffer());
  if (bytes.getUint16(0) !== 0xffd8) throw new Error("Not a JPEG");
  for (let at = 2; at < bytes.byteLength;) {
    const marker = bytes.getUint16(at);
    if (marker === 0xffc0 || marker === 0xffc2) {
      return {
        baseline: marker === 0xffc0,
        height: bytes.getUint16(at + 5),
        width: bytes.getUint16(at + 7),
      };
    }
    at += 2 + bytes.getUint16(at + 2);
  }
  throw new Error("No frame");
}

const cardStates = () =>
  log.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter(({ event }) => event === "profile-card")
    .map(({ state }) => state);

beforeEach(() => {
  clearAccessToken();
  ip = `198.51.100.${++ipCount}`;
  vi.spyOn(console, "error").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the card", () => {
  it("is a 1200x630 baseline JPEG of the favourites' posters", async () => {
    serve({ store: reader() });
    const hash = await hashOf([film(1), film(2), film(3), film(4)]);
    const response = await get(cardPath(hash));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await jpegFrame(response)).toEqual({
      baseline: true,
      width: 1200,
      height: 630,
    });
    expect(posterFetches().map(({ url }) => url)).toEqual(
      [1, 2, 3, 4].map(
        (n) => `https://image.tmdb.org/t/p/w342/poster-${n}.jpg`,
      ),
    );
  });

  it("is drawn once, and kept", async () => {
    serve({ store: reader() });
    const hash = await hashOf([film(1), film(2), film(3), film(4)]);
    await get(cardPath(hash));
    serve({ store: reader() });
    const response = await get(cardPath(hash));
    expect(response.status).toBe(200);
    expect(posterFetches()).toEqual([]);
    expect(cardStates()).toEqual(["rendered", "hit"]);
  });

  it("draws one to four posters, skipping favourites without one", async () => {
    const favourites = [{ id: "100", title: "No Poster" }, film(2)];
    serve({ store: reader({ favourites }) });
    const response = await get(cardPath(await hashOf([film(2)])));
    expect(response.status).toBe(200);
    expect(posterFetches()).toHaveLength(1);
  });

  it("redirects an old address to the card as the favourites are now", async () => {
    serve({ store: reader({ favourites: [film(2), film(1)] }) });
    const old = await hashOf([film(1), film(2)]);
    const response = await get(cardPath(old));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `https://clusterflick.com${cardPath(await hashOf([film(2), film(1)]))}`,
    );
    expect(posterFetches()).toEqual([]);
  });

  it("survives a purge, and is drawn again only when the favourites change", async () => {
    serve({ store: reader() });
    const hash = await hashOf([film(1), film(2), film(3), film(4)]);
    await get(cardPath(hash));
    await handlePurge(
      new Request("https://clusterflick.com/api/profiles/purge", {
        method: "POST",
        headers: { Authorization: `Bearer ${PURGE_SECRET}` },
        body: JSON.stringify({ uid: "uid1" }),
      }),
      env,
    );
    serve({ store: reader() });
    expect((await get(cardPath(hash))).status).toBe(200);
    expect(posterFetches()).toEqual([]);
  });

  it("keeps only the latest card", async () => {
    serve({ store: reader({ favourites: [film(1)] }) });
    await get(cardPath(await hashOf([film(1)])));
    await getProfileCache(env, "film-fan").purge();
    serve({ store: reader({ favourites: [film(2)] }) });
    const latest = await hashOf([film(2)]);
    await get(cardPath(latest));
    const cards = await runInDurableObject(
      getProfileCache(env, "film-fan"),
      async (_, state) => [
        ...(await state.storage.list({ prefix: "card:" })).keys(),
      ],
    );
    expect(cards).toEqual([`card:${latest}`]);
  });

  it("is a 503 when a poster can't be fetched, and isn't kept", async () => {
    serve({ store: reader(), posterStatus: 500 });
    const hash = await hashOf([film(1), film(2), film(3), film(4)]);
    const response = await get(cardPath(hash));
    expect(response.status).toBe(503);
    serve({ store: reader() });
    expect((await get(cardPath(hash))).status).toBe(200);
    expect(cardStates()).toEqual(["unavailable", "rendered"]);
  });

  it.each<[string, Store]>([
    ["a private profile", reader({ public: false })],
    [
      "a revoked capability",
      (() => {
        const store = reader();
        delete store["users/uid1/meta/capabilities"];
        return store;
      })(),
    ],
    ["an unknown handle", {}],
    [
      "no favourite with a poster",
      reader({ favourites: [{ id: "1", title: "x" }] }),
    ],
  ])("is a bare 404 for %s", async (_, store) => {
    serve({ store });
    const response = await get(cardPath(await hashOf([film(1)])));
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("Not found");
    expect(posterFetches()).toEqual([]);
  });

  it("is gone as soon as the profile is made private", async () => {
    serve({ store: reader() });
    const hash = await hashOf([film(1), film(2), film(3), film(4)]);
    expect((await get(cardPath(hash))).status).toBe(200);
    serve({ store: reader({ public: false }) });
    await getProfileCache(env, "film-fan").purge();
    expect((await get(cardPath(hash))).status).toBe(404);
  });
});

describe("the card's address", () => {
  it("changes with the favourites, their order, their posters and the handle", async () => {
    const base = await getCardHash(
      "film-fan",
      getCardFilms([film(1), film(2)]),
    );
    const others = await Promise.all([
      getCardHash("film-fan", getCardFilms([film(2), film(1)])),
      getCardHash("film-fan", getCardFilms([film(1)])),
      getCardHash(
        "film-fan",
        getCardFilms([film(1), { ...film(2), posterPath: "/new.jpg" }]),
      ),
      getCardHash("cinephile", getCardFilms([film(1), film(2)])),
    ]);
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set([base, ...others]).size).toBe(5);
    expect(CARD_VERSION).toBeGreaterThan(0);
  });

  it("draws at most four posters", () => {
    const five = [1, 2, 3, 4, 5].map(film);
    expect(getCardFilms(five).map(({ id }) => id)).toEqual([
      "101",
      "102",
      "103",
      "104",
    ]);
  });
});
