/**
 * How much CPU a large profile costs: the part that grows with a reader's
 * lists. Times what the Worker does with Firestore's answer once it arrives:
 * parsing it, decoding and trimming the lists and film details, and
 * serialising them into the script tag. In Node, which runs the same V8,
 * because in workerd the clock only moves on I/O.
 *
 * Not timed: reading the body, which workerd does natively, and HTMLRewriter,
 * which streams the same few KB of shell for every profile. Workers Logs give
 * the real figure per request once deployed.
 *
 *   npm run bench:cpu
 */
import type { Fields } from "../src/firestore";
import { readFavouriteVenues, readFilmDetails, readList } from "../src/lists";
import { readSections } from "../src/profile";
import { toScriptJson } from "../src/shell";
import { encodeValue } from "../test/helpers";

const UID = "Xy7kQ2mN9pLrT4vB8cD1eF3gH5jK";
const ROOT = "projects/clusterflick-com/databases/(default)/documents";

const list = (size: number) =>
  Object.fromEntries(
    Array.from({ length: size }, (_, n) => [
      String(100000 + n),
      {
        title: `A Film With A Fairly Long Title, Part ${n}`,
        year: "1987",
        posterPath: "/kqjL17yufvn9OVLyXYpvtyrFfak.jpg",
        addedAt: 1_700_000_000_000 + n * 1000,
      },
    ]),
  );

const details = (size: number) => ({
  films: Object.fromEntries(
    Array.from({ length: size }, (_, n) => [
      String(100000 + n),
      {
        genres: ["18", "80"],
        directors: [String(n % 500)],
        cast: Array.from({ length: 5 }, (_, i) => String(n * 5 + i)),
        runtime: 100 + (n % 60),
        language: "en",
      },
    ]),
  ),
  people: Object.fromEntries(
    Array.from({ length: size * 3 }, (_, n) => [String(n), `Person ${n}`]),
  ),
});

const fieldsOf = (data: Record<string, unknown>) =>
  (encodeValue(data) as { mapValue: { fields: unknown } }).mapValue.fields;

/** The second batchGet's answer, as Firestore sends it. */
const documentsFor = (seen: number) =>
  JSON.stringify([
    {
      found: {
        name: `${ROOT}/users/${UID}`,
        fields: fieldsOf({ seen: list(seen), watchlist: list(300) }),
      },
      readTime: "2026-11-12T00:00:00Z",
    },
    {
      found: {
        name: `${ROOT}/users/${UID}/meta/films`,
        fields: fieldsOf(details(seen + 300)),
      },
      readTime: "2026-11-12T00:00:00Z",
    },
  ]);

for (const seen of [2000, 10000]) {
  const text = documentsFor(seen);
  let sent = "";
  const runs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const [user, films] = (
      JSON.parse(text) as { found: { fields: Fields } }[]
    ).map(({ found }) => found.fields);
    const seenList = readList(user.seen);
    sent = toScriptJson({
      found: true,
      handle: "film-fan",
      links: {},
      favourites: [],
      sections: readSections(undefined),
      lists: { watchlist: readList(user.watchlist), seen: seenList },
      favouriteVenues: readFavouriteVenues(user.favouriteVenues),
      filmDetails: readFilmDetails(films.films, films.people, seenList),
    });
    runs.push(performance.now() - start);
  }
  const [first] = runs;
  runs.sort((a, b) => a - b);
  const mb = (length: number) => (length / 1024 / 1024).toFixed(2);
  // Web-standard, so it type-checks against the Workers types too.
  const gzipped = async (json: string) =>
    mb(
      (
        await new Response(
          new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer()
      ).byteLength,
    );
  console.log(`${seen} seen + 300 watchlist, with film details:`);
  // What the page was sent before, Firestore's answer passed on, and now.
  console.log(
    `  ${mb(text.length)}MB as Firestore sends it (${await gzipped(text)}MB gzipped)`,
  );
  console.log(`  ${mb(sent.length)}MB sent (${await gzipped(sent)}MB gzipped)`);
  // The first run is before V8 has optimised anything, as on a fresh isolate.
  console.log(`  first run ${first.toFixed(1)}ms`);
  console.log(`  median    ${runs[10].toFixed(1)}ms`);
}
