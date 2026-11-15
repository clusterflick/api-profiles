import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
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
import { FRESH_MS, getProfileCache, STALE_MAX_MS } from "../src/cache";
import { clearAccessToken } from "@clusterflick/accounts/google-auth";
import { handleRequest } from "../src/index";
import { handlePurge } from "../src/purge";
import {
  FIREBASE_TEST_KEYS,
  fakeUpstreams,
  publicReader,
  PURGE_SECRET,
  readProfileData,
  signFirebaseToken,
  type FakeOptions,
  type Store,
} from "./helpers";

let upstreams: ReturnType<typeof fakeUpstreams>;

/** Serves `store`, or swaps it for another mid-test, as a write would. */
function serve(options: FakeOptions = {}) {
  upstreams = fakeUpstreams(options);
  vi.spyOn(globalThis, "fetch").mockImplementation(upstreams.fetch);
}

let log: MockInstance<typeof console.log>;

/** The JSON lines logged for `event`. */
const logged = (event: string) =>
  log.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((line) => line.event === event);

let ipCount = 0;
/** A fresh IP per test, so the per-IP limit on misses doesn't carry over. */
let ip = "";

const view = (handle: string, from = ip) =>
  handleRequest(
    new Request(`https://clusterflick.com/u/${handle}/`, {
      headers: { "CF-Connecting-IP": from },
    }),
    env,
  );

const firestoreReads = () =>
  upstreams.requests.filter(({ url }) =>
    url.includes("firestore.googleapis.com"),
  ).length;

const purge = (token: string, body?: unknown) =>
  handlePurge(
    new Request("https://clusterflick.com/api/profiles/purge", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    env,
    FIREBASE_TEST_KEYS,
  );

/** Makes a handle's copy `by` ms older, as if it had been read that long ago. */
async function age(handle: string, by: number) {
  await runInDurableObject(getProfileCache(env, handle), async (_, state) => {
    const snapshot = await state.storage.get<{ fetchedAt: number }>("snapshot");
    if (!snapshot) throw new Error(`No copy of ${handle}`);
    await state.storage.put("snapshot", {
      ...snapshot,
      fetchedAt: snapshot.fetchedAt - by,
    });
  });
}

const withSeen = (title: string): Store =>
  publicReader("film-fan", "uid1", {
    seen: { "1": { title, addedAt: 1 } },
  });

async function seenTitle(handle = "film-fan") {
  const { data } = await readProfileData(await view(handle));
  return data.lists.seen["1"]?.title;
}

beforeEach(() => {
  clearAccessToken();
  ip = `203.0.113.${++ipCount}`;
  vi.spyOn(console, "error").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the cache", () => {
  it("serves a second view from its copy, reading Firestore once", async () => {
    serve({ store: withSeen("Heat") });
    expect(await seenTitle()).toBe("Heat");
    const reads = firestoreReads();
    serve({ store: withSeen("Changed, unannounced") });
    expect(await seenTitle()).toBe("Heat");
    expect(firestoreReads()).toBe(0);
    expect(reads).toBeGreaterThan(0);
  });

  it(`reads Firestore again once the copy is ${FRESH_MS / 60_000} minutes old`, async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    serve({ store: withSeen("Ran") });
    await age("film-fan", FRESH_MS);
    expect(await seenTitle()).toBe("Ran");
  });

  it("keeps a not-found, so a handle tried again costs nothing", async () => {
    serve();
    expect((await view("nobody-here")).status).toBe(404);
    serve();
    expect((await view("nobody-here")).status).toBe(404);
    expect(firestoreReads()).toBe(0);
  });

  it("logs how each view was answered, and nothing in the response", async () => {
    serve({ store: withSeen("Heat") });
    const first = await view("film-fan");
    const second = await view("film-fan");
    const views = logged("profile-view");
    expect(views.map(({ state }) => state)).toEqual(["miss", "hit"]);
    expect(views[1].ageMs).toBeGreaterThanOrEqual(0);
    for (const response of [first, second]) {
      expect([...response.headers.keys()].sort()).toEqual([
        "cache-control",
        "content-type",
      ]);
    }
  });
});

describe("when Firestore fails", () => {
  it("serves the last copy, if it's under a day old", async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    await age("film-fan", STALE_MAX_MS - 60_000);
    serve({ store: withSeen("Heat"), firestoreStatus: 500 });
    expect(await seenTitle()).toBe("Heat");
  });

  it("is a 503 with no copy, or one a day old", async () => {
    serve({ store: withSeen("Heat"), firestoreStatus: 500 });
    expect((await view("film-fan")).status).toBe(503);

    serve({ store: withSeen("Heat") });
    await view("film-fan");
    await age("film-fan", STALE_MAX_MS);
    serve({ store: withSeen("Heat"), firestoreStatus: 500 });
    expect((await view("film-fan")).status).toBe(503);
  });
});

describe("a day after its last read", () => {
  it("a copy is deleted", async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    const stub = getProfileCache(env, "film-fan");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const stored = await runInDurableObject(stub, (_, state) =>
      state.storage.list(),
    );
    expect(stored.size).toBe(0);
  });
});

describe("uncached views from one IP", () => {
  it("are limited, with a 429 that says nothing about the handle", async () => {
    serve();
    for (let n = 0; n < 30; n++) {
      expect((await view(`nobody-${n}`)).status).toBe(404);
    }
    const response = await view("nobody-30");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    // A cached copy is still served to that IP.
    expect((await view("nobody-0")).status).toBe(404);
  });
});

describe("POST /api/profiles/purge", () => {
  it("drops the reader's own copies, found by their uid", async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    serve({ store: withSeen("Ran") });
    const response = await purge(await signFirebaseToken({ sub: "uid1" }));
    expect(response.status).toBe(204);
    expect(await seenTitle()).toBe("Ran");
  });

  it("doesn't keep a refresh that read Firestore before the purge", async () => {
    // Firestore held mid-read, as a slow answer would be.
    serve({ store: withSeen("Heat") });
    const { fetch } = upstreams;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith(":batchGet")) await held;
      return fetch(input, init);
    });
    const before = view("film-fan");
    // Give the view time to reach Firestore and wait there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The reader's change lands, and its purge, while the read is held.
    await purge(PURGE_SECRET, { handles: ["film-fan"] });
    release();
    await before;

    serve({ store: withSeen("Ran") });
    expect(await seenTitle()).toBe("Ran");
  });

  it("leaves other readers' copies alone", async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    serve({ store: withSeen("Ran") });
    await purge(await signFirebaseToken({ sub: "someone-else" }));
    expect(await seenTitle()).toBe("Heat");
  });

  it("drops a handle just taken, which a visitor may have found empty", async () => {
    serve();
    expect((await view("film-fan")).status).toBe(404);
    serve({ store: withSeen("Heat") });
    await purge(await signFirebaseToken(), { handles: ["film-fan"] });
    expect((await view("film-fan")).status).toBe(200);
  });

  it("drops a private profile's not-found when it's made public", async () => {
    const reader = withSeen("Heat");
    serve({
      store: {
        ...reader,
        "users/uid1/meta/profile": { handle: "film-fan", public: false },
      },
    });
    expect((await view("film-fan")).status).toBe(404);
    serve({ store: reader });
    // Filed under its uid even though it wasn't shown.
    await purge(await signFirebaseToken());
    expect((await view("film-fan")).status).toBe(200);
  });

  it("takes the secret and a uid from the scripts", async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    // A revoked capability, as `grant-capability --revoke` leaves it.
    const revoked = withSeen("Heat");
    delete revoked["users/uid1/meta/capabilities"];
    serve({ store: revoked });
    expect((await purge(PURGE_SECRET, { uid: "uid1" })).status).toBe(204);
    expect((await view("film-fan")).status).toBe(404);
  });

  it("logs what it purged, and how it was asked", async () => {
    serve({ store: withSeen("Heat") });
    await view("film-fan");
    await purge(PURGE_SECRET, { uid: "uid1" });
    expect(logged("profile-purge")).toEqual([
      { event: "profile-purge", via: "secret", handles: ["film-fan"] },
    ]);
  });

  it.each<[string, () => Promise<Response>, number]>([
    ["no token", () => purge(""), 401],
    ["a wrong secret, read as a token", () => purge("not-the-secret"), 401],
    [
      "an unverified email",
      async () => purge(await signFirebaseToken({ email_verified: false })),
      403,
    ],
    [
      "a uid from a reader",
      async () => purge(await signFirebaseToken(), { uid: "uid2" }),
      400,
    ],
    [
      "a bad handle",
      async () => purge(await signFirebaseToken(), { handles: ["Bad!"] }),
      400,
    ],
    [
      "three handles",
      async () =>
        purge(await signFirebaseToken(), { handles: ["aaa", "bbb", "ccc"] }),
      400,
    ],
    ["the secret with nothing named", () => purge(PURGE_SECRET, {}), 400],
  ])("refuses %s", async (_, call, status) => {
    serve();
    expect((await call()).status).toBe(status);
  });

  it("refuses other methods", async () => {
    const response = await handleRequest(
      new Request("https://clusterflick.com/api/profiles/purge"),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("404s anything else under /api/profiles/", async () => {
    const response = await handleRequest(
      new Request("https://clusterflick.com/api/profiles/other"),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("limits each reader", async () => {
    serve();
    const token = await signFirebaseToken({ sub: "busy-reader" });
    for (let n = 0; n < 60; n++) {
      expect((await purge(token)).status).toBe(204);
    }
    expect((await purge(token)).status).toBe(429);
  });
});
