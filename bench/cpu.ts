/**
 * How much CPU a large profile costs, against Workers Free's 10ms a request:
 * parsing Firestore's answer and picking out the recent films, the part that
 * grows with a reader's lists. In Node, which runs the same V8, because in
 * workerd the clock only moves on I/O.
 *
 * Not timed: reading the body, which workerd does natively (Node's own
 * `Response.json()` is JavaScript, and takes 10ms cold on its own), and
 * HTMLRewriter, which streams the same few KB of shell for every profile.
 * Workers Logs give the real figure per request once deployed.
 *
 *   npm run bench:cpu
 */
import { toProfileList } from "../src/profile";
import { encodeValue } from "../test/helpers";

const SEEN = 2000;
const WATCHLIST = 300;

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

// The lists document as batchGet sends it, its fields undecoded.
const body = JSON.stringify([
  {
    found: {
      name: "projects/clusterflick-com/databases/(default)/documents/users/uid1",
      fields: {
        seen: encodeValue(list(SEEN)),
        watchlist: encodeValue(list(WATCHLIST)),
      },
    },
    readTime: "2026-11-11T00:00:00Z",
  },
]);

const runs: number[] = [];
for (let i = 0; i < 50; i++) {
  const start = performance.now();
  const [{ found }] = JSON.parse(body);
  toProfileList(found.fields.seen);
  toProfileList(found.fields.watchlist);
  runs.push(performance.now() - start);
}
const [first] = runs;
runs.sort((a, b) => a - b);
console.log(
  `${SEEN} seen + ${WATCHLIST} watchlist, ${(body.length / 1024).toFixed(0)}KB from Firestore:`,
);
// The first run is before V8 has optimised anything, as on a fresh isolate.
console.log(`  first run ${first.toFixed(1)}ms`);
console.log(`  median    ${runs[25].toFixed(1)}ms`);
