import {
  decodeFields,
  decodeValue,
  type Fields,
  type Firestore,
  type Value,
} from "./firestore";

/** How many of each list's films the page shows, most recently added first. */
export const RECENT_FILMS = 24;

/** The lists a profile shows, as `users/{uid}` names their fields. */
const LISTS = ["seen", "watchlist"] as const;
type ListId = (typeof LISTS)[number];

/** A list entry's own snapshot, which the site writes with each film. */
export type ProfileFilm = {
  id: string;
  title: string;
  year?: string;
  posterPath?: string;
};

export type ProfileList = { count: number; films: ProfileFilm[] };

/**
 * Everything the page is sent. Only what the reader chose to publish: never
 * the uid, the email address, or another field of their documents.
 */
export type ProfileData =
  | ({ found: true; handle: string } & Record<ListId, ProfileList>)
  | { found: false; handle?: string };

function readNumber(value: Value | undefined) {
  if (!value) return 0;
  return Number(value.integerValue ?? value.doubleValue) || 0;
}

/**
 * A list as Firestore's REST API sends it (a map of film id → entry), as the
 * page is sent it. Only the films sent are decoded: the rest are only counted
 * and sorted, by their `addedAt` read in place.
 */
export function toProfileList(list: Value | undefined): ProfileList {
  const map = list?.mapValue as { fields?: Fields } | undefined;
  const entries = Object.entries(map?.fields ?? {}).flatMap(([id, entry]) => {
    const fields = (entry.mapValue as { fields?: Fields } | undefined)?.fields;
    return fields?.title?.stringValue !== undefined
      ? [{ id, fields, addedAt: readNumber(fields.addedAt) }]
      : [];
  });
  entries.sort((a, b) => b.addedAt - a.addedAt);
  return {
    count: entries.length,
    films: entries.slice(0, RECENT_FILMS).map(({ id, fields }) => {
      const { title, year, posterPath } = decodeFields(fields);
      return {
        id,
        title: title as string,
        ...(typeof year === "string" && { year }),
        ...(typeof posterPath === "string" && { posterPath }),
      };
    }),
  };
}

/** A uid as a document path segment: anything else is a hand edit gone wrong. */
function isUid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value);
}

/**
 * The public profile at a handle, or null when there isn't one to show: no
 * such handle, a private profile, or a capability revoked. All three are the
 * same answer, so nobody can tell a private profile from a missing one.
 *
 * The rules keep `handles/{h}` and the profile pointing at each other, but the
 * Admin SDK skips the rules, so a hand edit could leave a stale handle. It's
 * served only when the handle leads to a profile that names it back.
 */
export async function loadProfile(
  db: Firestore,
  handle: string,
): Promise<ProfileData | null> {
  const handleDoc = await db.get(`handles/${handle}`);
  const uid = handleDoc?.uid;
  if (!isUid(uid)) return null;

  const [profile, capabilities, lists] = await db.batchGet(
    [
      `users/${uid}/meta/profile`,
      `users/${uid}/meta/capabilities`,
      `users/${uid}`,
    ],
    ["handle", "public", "publicProfile", ...LISTS],
  );
  if (!profile?.handle || decodeValue(profile.handle) !== handle) return null;
  if (!profile.public || decodeValue(profile.public) !== true) return null;
  // Granted is the key being there, as the rules and the site read it.
  if (!capabilities || !("publicProfile" in capabilities)) return null;

  return {
    found: true,
    handle,
    seen: toProfileList(lists?.seen),
    watchlist: toProfileList(lists?.watchlist),
  };
}
