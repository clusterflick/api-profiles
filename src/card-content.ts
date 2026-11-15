import { CARD_MAX_POSTERS } from "./card";
import type { FavouriteFilm } from "./profile";

/**
 * Part of every card's hash, so bumping it renders every card afresh: do so
 * with any change to how a card looks.
 */
export const CARD_VERSION = 1;

const CARD_FILE = /^card-([0-9a-f]{12})\.jpg$/;

/** A card's file name within `/u/<handle>/`, or its hash from one. */
export const cardFileName = (hash: string) => `card-${hash}.jpg`;
export const parseCardFileName = (name: string) =>
  name.match(CARD_FILE)?.[1] ?? null;

export type CardFilm = Required<Pick<FavouriteFilm, "id" | "posterPath">>;

/**
 * The favourites a card draws: those with a poster, in the reader's order, up
 * to four. None means no card, and the link previews with the site's image.
 */
export function getCardFilms(favourites: FavouriteFilm[]): CardFilm[] {
  return favourites
    .flatMap(({ id, posterPath }) => (posterPath ? [{ id, posterPath }] : []))
    .slice(0, CARD_MAX_POSTERS);
}

/**
 * The first 12 hex digits of a SHA-256 of everything the card shows, and the
 * design it's drawn with. It's in the card's address, so a site that has kept
 * a preview of the old favourites fetches the new card rather than its copy.
 */
export async function getCardHash(handle: string, films: CardFilm[]) {
  const text = JSON.stringify([
    CARD_VERSION,
    handle,
    films.map(({ id, posterPath }) => [id, posterPath]),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** TMDB's poster at 342px wide, sharp at the 250px a card draws it. */
const POSTER_URL = "https://image.tmdb.org/t/p/w342";
const POSTER_TIMEOUT_MS = 8000;
/** A w342 poster is 30-100KB; anything near this isn't one. */
const MAX_POSTER_BYTES = 1024 * 1024;
const POSTER_TYPES = ["image/jpeg", "image/png"];

/**
 * A poster as a data URL, for Satori, which is never left to fetch anything
 * itself. Throws on anything but a modest JPEG or PNG: a card is rendered
 * whole or not at all, rather than kept with a hole in it.
 */
export async function fetchPoster(posterPath: string): Promise<string> {
  const response = await fetch(`${POSTER_URL}${posterPath}`, {
    signal: AbortSignal.timeout(POSTER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Poster ${posterPath} answered ${response.status}`);
  }
  const type = response.headers.get("Content-Type")?.split(";")[0].trim();
  if (!type || !POSTER_TYPES.includes(type)) {
    throw new Error(`Poster ${posterPath} is ${type ?? "untyped"}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_POSTER_BYTES) {
    throw new Error(`Poster ${posterPath} is ${bytes.length} bytes`);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}
