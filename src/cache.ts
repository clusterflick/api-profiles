import { DurableObject } from "cloudflare:workers";
import { Firestore } from "./firestore";
import { getAccessToken } from "./google-auth";
import { loadProfile, type ProfileData } from "./profile";

/**
 * How long a copy is served before the next view refreshes it. Every change a
 * profile shows purges its copy (see `purge.ts`), so this is the safety net
 * for a purge that never arrived: a profile switched to private, say, while
 * the purge failed.
 */
export const FRESH_MS = 5 * 60 * 1000;

/**
 * The oldest copy ever served, while Firestore can't be read. Also how long a
 * copy, or an index entry, outlives its last refresh before it's deleted.
 */
export const STALE_MAX_MS = 24 * 60 * 60 * 1000;

type Snapshot = { data: ProfileData; fetchedAt: number };

/**
 * How a view was answered, for the logs: `hit` from a fresh copy, `miss`
 * with none to serve, `refresh` replacing an old copy, `stale` an old copy
 * served because Firestore couldn't be read or the visitor's IP is over its
 * limit, `limited` refused for that limit with no copy to serve, and
 * `unavailable` when Firestore couldn't be read and there was no copy either.
 */
export type CacheState =
  "hit" | "miss" | "refresh" | "stale" | "limited" | "unavailable";

export type CachedProfile =
  | { state: "limited" | "unavailable" }
  | {
      state: Exclude<CacheState, "limited" | "unavailable">;
      data: ProfileData;
      ageMs: number;
    };

const SNAPSHOT_KEY = "snapshot";
const HANDLES_KEY = "handles";

/**
 * One per handle, worldwide: the last copy of what `/u/<handle>/` shows, and
 * the one place that decides when to read it from Firestore again. Visitors
 * who arrive together share one refresh, so a profile costs Firestore one
 * read of its documents every `FRESH_MS` however many people view it.
 *
 * "Not found" is a copy like any other, so a handle tried over and over costs
 * one read every `FRESH_MS` too. Every copy, found or not, is deleted
 * `STALE_MAX_MS` after it was read, so a handle nobody visits again leaves no
 * object behind.
 */
export class ProfileCache extends DurableObject<Env> {
  /**
   * Bumped by every purge. A refresh started before a purge read Firestore
   * before the change it announces, so its result is neither kept nor
   * handed to anyone who asked after the purge.
   */
  private generation = 0;
  private refreshing?: { generation: number; snapshot: Promise<Snapshot> };

  async load(handle: string, ip: string): Promise<CachedProfile> {
    const now = Date.now();
    const snapshot = await this.ctx.storage.get<Snapshot>(SNAPSHOT_KEY);
    const age = snapshot ? now - snapshot.fetchedAt : Infinity;
    if (snapshot && age < FRESH_MS) {
      return { state: "hit", data: snapshot.data, ageMs: age };
    }
    const servable = snapshot && age < STALE_MAX_MS ? snapshot : undefined;

    // Joining a refresh already under way costs nothing, so isn't counted.
    if (this.refreshing?.generation !== this.generation) {
      const { success } = await this.env.MISS_LIMIT.limit({ key: ip });
      if (!success) {
        return servable
          ? { state: "stale", data: servable.data, ageMs: age }
          : { state: "limited" };
      }
    }

    try {
      const fresh = await this.refresh(handle);
      return {
        state: snapshot ? "refresh" : "miss",
        data: fresh.data,
        ageMs: 0,
      };
    } catch (e) {
      // Logged here and answered as a state, not thrown: an error thrown out
      // of an RPC method is logged as uncaught however the caller handles it.
      if (!servable) {
        console.error("Profile unavailable", e);
        return { state: "unavailable" };
      }
      console.error("Profile refresh failed; serving the last copy", e);
      return { state: "stale", data: servable.data, ageMs: age };
    }
  }

  /** Drops the copy, so the next view reads Firestore. */
  async purge(): Promise<void> {
    this.generation++;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private refresh(handle: string): Promise<Snapshot> {
    const { generation } = this;
    if (this.refreshing?.generation === generation) {
      return this.refreshing.snapshot;
    }
    const snapshot = this.read(handle, generation);
    this.refreshing = { generation, snapshot };
    const clear = () => {
      if (this.refreshing?.snapshot === snapshot) this.refreshing = undefined;
    };
    snapshot.then(clear, clear);
    return snapshot;
  }

  private async read(handle: string, generation: number): Promise<Snapshot> {
    const db = new Firestore(this.env.FIREBASE_PROJECT_ID, () =>
      getAccessToken(this.env.FIREBASE_SERVICE_ACCOUNT),
    );
    const { profile, uid } = await loadProfile(db, handle);
    const snapshot: Snapshot = {
      data: profile ?? { found: false, handle },
      fetchedAt: Date.now(),
    };
    if (generation !== this.generation) return snapshot;

    // Filed under its uid first, so a purge by uid can always find a copy
    // that's kept. Without that, it isn't kept.
    if (uid) {
      try {
        await getUidIndex(this.env, uid).add(handle);
      } catch (e) {
        console.error("Couldn't index the profile; not keeping it", e);
        return snapshot;
      }
    }
    if (generation !== this.generation) return snapshot;
    try {
      await this.ctx.storage.put(SNAPSHOT_KEY, snapshot);
      await this.ctx.storage.setAlarm(snapshot.fetchedAt + STALE_MAX_MS);
    } catch (e) {
      // Too big to store, say: served, just not kept.
      console.error("Couldn't keep the profile", e);
    }
    return snapshot;
  }
}

/**
 * One per uid: the handles whose copies hold that reader's documents, so a
 * change can be purged by uid alone, with no Firestore read and nothing the
 * site has to know. An entry is never removed by a purge, as the copy is
 * filled again on its next view; it lapses `STALE_MAX_MS` after it was last
 * filed, as the copy itself does.
 */
export class UidIndex extends DurableObject<Env> {
  async add(handle: string): Promise<void> {
    const now = Date.now();
    const handles = await this.current(now);
    handles[handle] = now;
    await this.ctx.storage.put(HANDLES_KEY, handles);
    await this.ctx.storage.setAlarm(now + STALE_MAX_MS);
  }

  async handles(): Promise<string[]> {
    return Object.keys(await this.current(Date.now()));
  }

  async alarm(): Promise<void> {
    const handles = await this.current(Date.now());
    if (Object.keys(handles).length === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.put(HANDLES_KEY, handles);
      const oldest = Math.min(...Object.values(handles));
      await this.ctx.storage.setAlarm(oldest + STALE_MAX_MS);
    }
  }

  private async current(now: number) {
    const stored =
      (await this.ctx.storage.get<Record<string, number>>(HANDLES_KEY)) ?? {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, at]) => now - at < STALE_MAX_MS),
    );
  }
}

export const getProfileCache = (env: Env, handle: string) =>
  env.PROFILES.get(env.PROFILES.idFromName(handle));

export const getUidIndex = (env: Env, uid: string) =>
  env.UID_INDEX.get(env.UID_INDEX.idFromName(uid));
