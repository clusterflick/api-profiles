import { decodeValue, type Firestore, type Value } from "./firestore";

/**
 * The sections a reader can show or hide on their profile, as the site's
 * `ProfileSectionId`. Each is a switch in the profile's `sections` map.
 */
export const SECTION_IDS = [
  "watchlist",
  "seen",
  "seenStats",
  "favouriteVenues",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];
export type Sections = Record<SectionId, boolean>;

/**
 * Which sections are shown. A profile with no `sections` was made public
 * before readers could choose, when every section was shown, and keeps
 * showing them all. Within a `sections` map, anything but `true` is hidden:
 * the rules require all four booleans, so a missing or odd key is a hand edit,
 * and hiding is the safe reading of one.
 */
export function readSections(value: Value | undefined): Sections {
  const decoded = value === undefined ? undefined : decodeValue(value);
  if (decoded === undefined) {
    return Object.fromEntries(SECTION_IDS.map((id) => [id, true])) as Sections;
  }
  const map =
    typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    SECTION_IDS.map((id) => [id, map[id] === true]),
  ) as Sections;
}

/**
 * The fields the page is sent, from `users/{uid}` (the lists and favourite
 * venues) and `users/{uid}/meta/films` (each film's details, for the Seen
 * stats), for the sections shown. Nothing else in those documents, nothing
 * from any other, and nothing for a hidden section: the page only draws what
 * it's given, but anything sent can be read from its source.
 *
 * The stats are drawn in the browser from the Seen list and the film details,
 * so showing the stats sends the Seen list even while the list itself is
 * hidden. The site says so beside the switches.
 */
export function getPublishedFields(sections: Sections): string[] {
  return [
    ...(sections.seen || sections.seenStats ? ["seen"] : []),
    ...(sections.watchlist ? ["watchlist"] : []),
    ...(sections.favouriteVenues ? ["favouriteVenues"] : []),
    ...(sections.seenStats ? ["films", "people"] : []),
  ];
}

export const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * Code points a display name never holds, as the site's
 * `FORBIDDEN_NAME_RANGES` and its rules: `"` `&` `<` `>` `\`, control
 * characters, the line and paragraph separators, and the bidirectional
 * embeddings, overrides and isolates. The rules refuse them, but the Admin
 * SDK skips the rules, so they're stripped again here: with them gone, the
 * name is plain text in the `<head>`, in an attribute, and inside the RSC
 * payload's JSON strings, with nothing to escape. An apostrophe is kept, as
 * nothing it's written into is quoted with one.
 */
const FORBIDDEN_NAME_CHARACTERS =
  /[\u{0}-\u{1F}\u{22}\u{26}\u{3C}\u{3E}\u{5C}\u{7F}-\u{9F}\u{2028}-\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/**
 * A stored name as it's shown, or undefined: stripped of what it can't hold,
 * spaces collapsed and trimmed, and any leading `$` dropped, since the RSC
 * payload reads a string starting with `$` as a reference and the title
 * starts with the name. Too long, or nothing left, is no name.
 */
export function readDisplayName(value: Value | undefined): string | undefined {
  const decoded = value === undefined ? undefined : decodeValue(value);
  if (typeof decoded !== "string") return undefined;
  const name = decoded
    .replace(FORBIDDEN_NAME_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[$\s]+/u, "");
  if (name.length === 0 || [...name].length > DISPLAY_NAME_MAX_LENGTH) {
    return undefined;
  }
  return name;
}

/**
 * Links to the reader's profiles elsewhere, as the site's `ProfileLinkId`:
 * identifiers rather than addresses, bar the website. Each is checked again
 * as it's read, and one that fails is dropped. The page builds the addresses.
 */
export type Links = Partial<Record<"letterboxd" | "imdb" | "website", string>>;

const LINK_PATTERNS = {
  letterboxd: /^[A-Za-z0-9_-]{1,50}$/,
  imdb: /^ur[0-9]{1,12}$/,
  website: /^https:\/\/[^\s<>"\\]{1,192}$/,
} as const;

export function readLinks(value: Value | undefined): Links {
  const decoded = value === undefined ? undefined : decodeValue(value);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    return {};
  const map = decoded as Record<string, unknown>;
  const links: Links = {};
  for (const id of Object.keys(LINK_PATTERNS) as (keyof Links)[]) {
    const link = map[id];
    if (typeof link === "string" && LINK_PATTERNS[id].test(link)) {
      links[id] = link;
    }
  }
  return links;
}

/** Firestore's `batchGet` answer with nothing in it. */
const NO_DOCUMENTS = "[]";

/**
 * Everything the page is sent. A found profile carries the sections shown,
 * and `documents`: the documents those need, as Firestore's REST API sent
 * them, as JSON text, for the page to decode. Never the uid, which is taken
 * out of the documents' names.
 */
export type ProfileData =
  | {
      found: true;
      handle: string;
      displayName?: string;
      links: Links;
      sections: Sections;
      documents: string;
    }
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
    ["handle", "public", "sections", "displayName", "links", "publicProfile"],
  );
  if (!profile?.handle || decodeValue(profile.handle) !== handle) return null;
  if (!profile.public || decodeValue(profile.public) !== true) return null;
  // Granted is the key being there, as the rules and the site read it.
  if (!capabilities || !("publicProfile" in capabilities)) return null;

  const sections = readSections(profile.sections);
  const fields = getPublishedFields(sections);
  // With every section hidden there is nothing to ask for, and nothing here
  // should rest on what Firestore does with an empty mask: a mask left unset
  // means every field.
  const documents =
    fields.length === 0
      ? NO_DOCUMENTS
      : await db.batchGetText(
          [
            `users/${uid}`,
            // The film details are only for the stats.
            ...(sections.seenStats ? [`users/${uid}/meta/films`] : []),
          ],
          fields,
        );
  // Each document's name holds the uid; the page needs only its last part.
  const displayName = readDisplayName(profile.displayName);
  return {
    found: true,
    handle,
    ...(displayName && { displayName }),
    links: readLinks(profile.links),
    sections,
    documents: documents.replaceAll(uid, "-"),
  };
}
