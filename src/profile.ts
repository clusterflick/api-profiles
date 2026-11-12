import { decodeValue, type Firestore } from "./firestore";

/**
 * The fields the page is sent, from `users/{uid}` (the lists and favourite
 * venues) and `users/{uid}/meta/films` (each film's details, for the Seen
 * stats). Nothing else in those documents, and nothing from any other.
 */
export const PUBLISHED_FIELDS = [
  "seen",
  "watchlist",
  "favouriteVenues",
  "films",
  "people",
];

/**
 * Everything the page is sent. A found profile carries `documents`: those two
 * documents as Firestore's REST API sent them, as JSON text, for the page to
 * decode. Never the uid, which is taken out of the documents' names.
 */
export type ProfileData =
  | { found: true; handle: string; documents: string }
  | { found: false; handle?: string };

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
 *
 * Only the three small documents are decoded. The lists and film details are
 * passed on as Firestore sent them: decoding a long Seen list costs more CPU
 * than a Worker on the free plan has, and the page decodes them anyway. They
 * are read only once the checks have passed, so a private profile's lists are
 * never fetched.
 */
export async function loadProfile(
  db: Firestore,
  handle: string,
): Promise<ProfileData | null> {
  const handleDoc = await db.get(`handles/${handle}`);
  const uid = handleDoc?.uid;
  if (!isUid(uid)) return null;

  const [profile, capabilities] = await db.batchGet(
    [`users/${uid}/meta/profile`, `users/${uid}/meta/capabilities`],
    ["handle", "public", "publicProfile"],
  );
  if (!profile?.handle || decodeValue(profile.handle) !== handle) return null;
  if (!profile.public || decodeValue(profile.public) !== true) return null;
  // Granted is the key being there, as the rules and the site read it.
  if (!capabilities || !("publicProfile" in capabilities)) return null;

  const documents = await db.batchGetText(
    [`users/${uid}`, `users/${uid}/meta/films`],
    PUBLISHED_FIELDS,
  );
  // Each document's name holds the uid; the page needs only its last part.
  return { found: true, handle, documents: documents.replaceAll(uid, "-") };
}
