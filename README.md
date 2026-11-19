# api-profiles

> **[Clusterflick](https://clusterflick.com)** is a free, open-source site
> listing every film showing in London, from 500+ venues in one search.
>
> This repository is the Cloudflare Worker behind readers' public profiles at
> `clusterflick.com/u/<handle>/`. See the
> [Clusterflick organisation](https://github.com/clusterflick) for how the
> pieces fit together.

A Cloudflare Worker that serves a reader's public profile: their Seen list and
watchlist, at an address of their choosing.

The site is a static export, so it has no page per reader. Instead it builds
one shell page, `/profile-shell/`, with the site's layout and each deploy's
assets. For each request this Worker reads the profile from Firestore, fetches
that shell, and puts the profile in it. The page draws itself in the browser
from the data it's given.

It is the only reader of profile data. Nothing in Firestore is publicly
readable, so the checks here can't be bypassed by querying Firestore directly.

Each profile is cached in a Durable Object, and the site purges it after any
change the profile shows (see [Caching](#caching)).

## Routes

The Worker owns everything under `/u`, on the routes `clusterflick.com/u/*`
(which also matches `/u/`) and `clusterflick.com/u`, and `/api/profiles/*`
for the purge.

| Request                                           | Response                                         |
| ------------------------------------------------- | ------------------------------------------------ |
| `/u`                                              | 301 → `/u/`                                      |
| `/u/`                                             | 302 → `/personalise/`                            |
| `/u/<Handle>` or `/u/<handle>`                    | 301 → `/u/<handle>/`, lowercased                 |
| `/u/<handle>/`, public                            | 200, the shell with the profile                  |
| `/u/<handle>/`, unknown, private or not permitted | 404, the shell in its not-found state            |
| `/u/<handle>/card-<hash>.jpg`                     | The profile's card; see [The card](#the-card)    |
| Anything else under `/u/`                         | 404, the same, without reading Firestore         |
| An IP over its limit of uncached views            | 429, plain text, `Retry-After: 60`               |
| Firestore, Google or the site failed              | 503, plain text, so nothing is told it's missing |
| `POST /api/profiles/purge`                        | 204; see [Caching](#caching)                     |

`/u/` redirects temporarily so it can become a directory of people later.
Handles are `^[a-z0-9_-]{3,30}$`, lowercase everywhere, as the site's
Firestore rules enforce.

The three kinds of not-found are the same response, byte for byte, so nobody
can tell a private profile from a missing one.

## Caching

Each handle has a Durable Object, `ProfileCache` (`src/cache.ts`): one
instance worldwide, which every view of that profile reaches. It keeps the
last copy of what the page is sent and decides when to read Firestore again,
so a profile costs one read of its documents every five minutes however many
people view it, and visitors who arrive together share one read.

- **Fresh for five minutes** (`FRESH_MS`). After that, the next view reads
  Firestore again.
- **Purged on every change.** The site calls `POST /api/profiles/purge` after
  any write a profile shows, so a change is live on the next view. The five
  minutes are the safety net for a purge that never arrived.
- **The last copy while Firestore is down**, if it's under a day old
  (`STALE_MAX_MS`); with no copy, or an older one, the view is a 503.
- **Not-found is cached too**, so a handle tried over and over costs one read
  every five minutes. Uncached views are limited to 30 a minute per IP
  (`MISS_LIMIT`), which keeps a crawler trying handles from costing a read for
  every one: over it, a cached copy is still served, and anything else is a
  429 that says nothing about the handle.
- **Gone a day after its last read**, by an alarm, so a handle nobody visits
  again leaves nothing stored.

A refresh that read Firestore before a purge arrived isn't kept, and isn't
handed to a view made after the purge: it read the documents before the
change the purge announces.

Each view is logged as one JSON line, `{"event":"profile-view","handle",
"state","ageMs"}`, with `state` one of `hit`, `miss`, `refresh`, `stale`,
`limited` or `unavailable`. Only in the logs: a header saying a copy was
cached would tell a visitor that someone else had just viewed the profile,
and could tell a private profile's not-found from a missing one's.

### The purge

`POST /api/profiles/purge` drops a reader's cached copies. A reader is found
by uid, never by handle: a second Durable Object, `UidIndex`, one per uid,
holds the handles whose copies hold that reader's documents, filed whenever a
copy is read from a handle that names them, whether it was shown or not. So a
purge needs no Firestore read, and the site needs to know nothing but who's
signed in. An entry lapses a day after it was last filed, as the copy does.

| Caller      | `Authorization`                  | Body                                 |
| ----------- | -------------------------------- | ------------------------------------ |
| The site    | `Bearer <the reader's ID token>` | `{}`, or `{ "handles": [old, new] }` |
| The scripts | `Bearer <PURGE_SECRET>`          | `{ "uid": "…" }`                     |

`handles` (up to two) adds copies the index can't know about: a profile save
names the handle given up and the one taken, which a visitor may have found
empty and so cached as not-found. The site's ID token is checked as
api-tmdb-search checks it (`src/auth.ts` is a copy). The scripts run as the
service account and have no ID token, so they send `PURGE_SECRET` and name
the reader.

A purge only ever makes the next view read Firestore, so the worst a caller
can do is cost reads. Readers are limited to 60 purges a minute
(`PURGE_LIMIT`). Each purge is logged as `{"event":"profile-purge","via",
"handles"}`.

## What it reads

Three requests to Firestore's REST API, as a service account:

1. `handles/{handle}`, which holds the owner's uid.
2. A `batchGet` of `users/{uid}/meta/profile` (`handle`, `public`,
   `sections`, `displayName`, `links`, `favourites`) and
   `users/{uid}/meta/capabilities` (`publicProfile`).
3. Only if the profile is to be shown, a `batchGet` of `users/{uid}` (`seen`,
   `watchlist`, `favouriteVenues`) and `users/{uid}/meta/films` (`films`,
   `people`: each film's details, for the Seen stats), for the sections the
   reader shows. A field mask keeps out anything else in them.

### Sections

`sections` is the reader's choice of what the page shows: `watchlist`, `seen`,
`seenStats` and `favouriteVenues`, each a boolean. A hidden section's fields
are left out of the mask, so they're never fetched and never sent: the page
draws only what it's given, but anything sent can be read from its source.

| Shown             | Fields                                          |
| ----------------- | ----------------------------------------------- |
| `seen`            | `seen`                                          |
| `seenStats`       | `seen`, and `films` and `people` (`meta/films`) |
| `watchlist`       | `watchlist`                                     |
| `favouriteVenues` | `favouriteVenues`                               |

The stats are drawn in the browser from the Seen list and the film details,
so showing them sends the Seen list even while the list itself is hidden. The
site says so beside the switches. `meta/films` is only asked for with the
stats, and with every section hidden the third request isn't made at all.

A profile with no `sections` was made public before readers could choose,
when every section was shown, and still shows them all; the site's rules now
refuse `public: true` without `sections`, so no profile becomes public that
way again. Within a `sections` map anything but `true` is hidden, since the
rules require all four booleans and anything else is a hand edit.

A profile is shown only when all of these hold:

- the handle's uid leads to a profile that names the same handle (the Admin
  SDK skips the rules, so a hand edit could leave a stale handle behind)
- the profile is `public`
- the reader has the `publicProfile` capability

### Name and links

`displayName` is shown in place of the handle, and `links` are the reader's
Letterboxd username, IMDb user id (`ur…` or, for newer accounts, `p.…`) and an https website. The site's
rules refuse anything else, but the Admin SDK skips the rules, so both are
checked again as they're read:

- **The name is stripped, not escaped.** `"` `&` `<` `>` `\`, control
  characters, the line and paragraph separators, and the bidirectional
  embeddings, overrides and isolates are taken out, spaces collapsed, and a
  leading `$` dropped. What's left is plain text in the `<title>`, in an
  attribute, and inside the RSC payload, where it sits in a JSON string inside
  a JavaScript string and a string starting with `$` would be read as a
  reference. An apostrophe is kept (O'Brien): nothing it's written into is
  quoted with one. Too long (over 50 characters) or empty is no name.
- **A link that doesn't match its pattern is dropped**, and the others kept.
  The page builds each address from the identifier, so nothing a reader
  types becomes a link anywhere but their website.

The site keeps the same lists (`FORBIDDEN_NAME_RANGES` and the link patterns
in `src/lib/user-profile/identity.ts`, and `firestore.rules`): change them
together.

### Favourite films

`favourites` is up to four films the reader pins to the top of their profile,
in their order, each its own snapshot (`id`, `title`, and a `year` and
`posterPath` if it has them) rather than a reference into the Seen list. So
they're sent whether the Seen list is shown or not, and a hidden Seen list
stays wholly hidden: nothing is pulled out of it. They're checked again as
they're read, as the site's rules check them: a film whose id or title
doesn't fit is dropped, a year or poster that doesn't fit is left off, a
repeat is kept once, and nothing past four is sent. The title is drawn by the
page and never written into the `<head>`, so it needs no stripping.

## What it sends

The page gets this, as `<script type="application/json" id="profile-data">` in
`<head>`, with `<` escaped so a film title can't close the tag:

```json
{
  "found": true,
  "handle": "film-fan",
  "displayName": "Siobhán O'Brien",
  "links": { "letterboxd": "film_fan", "imdb": "p.mbd2yexnoms6latfrdkzba2zxy" },
  "favourites": [
    { "id": "949", "title": "Heat", "year": "1995", "posterPath": "/heat.jpg" }
  ],
  "sections": {
    "watchlist": true,
    "seen": true,
    "seenStats": true,
    "favouriteVenues": false
  },
  "lists": {
    "seen": {
      "949": {
        "title": "Heat",
        "year": "1995",
        "posterPath": "/heat.jpg",
        "addedAt": 1731628800000
      }
    },
    "watchlist": {}
  },
  "favouriteVenues": {},
  "filmDetails": {
    "films": {
      "949": {
        "genres": ["80", "18"],
        "directors": ["638"],
        "cast": ["1158"],
        "runtime": 170,
        "language": "en"
      }
    },
    "people": { "638": "Michael Mann", "1158": "Al Pacino" }
  }
}
```

`lists`, `favouriteVenues` and `filmDetails` are the third request's answer,
decoded into the shapes the site uses for the owner's own (`UserLists`,
`FavouriteVenues`, `FilmDetailsData`), so the page draws the profile as
`/personalise` draws the owner's, with only the sections shown. A hidden
section's data is never read, so it arrives empty, and the page needs
`sections` to tell it from one that is empty. An entry the page couldn't draw
(a list entry with no title, a venue with no name) is dropped, and only the
fields the page reads are kept. `filmDetails` holds only the films on the Seen
list and the people credited on them: removing a film from a list leaves its
details behind in `meta/films`, and nothing else on the page reads them. The
site reads all of it again with the same rules (`parseProfilePageData` in
`src/lib/user-profile/page-data.ts`), as it does the name and links: change
them together.

Never the uid, the email address, or any field outside the mask. A not-found
page gets `{ "found": false, "handle": "…" }`; the handle is there only when
the path held a valid one, so the page can tell its owner why their profile
isn't showing.

For a public profile the Worker also describes it in the `<head>`: the title
and description, the Open Graph and Twitter tags, a canonical link to
`/u/<handle>/`, and `robots` of `index, follow`. Making a profile public is the
consent to its being found. With a display name the title is the name beside
the handle ("Siobhán O'Brien (@film-fan)"), so the address is never hidden
behind a name anyone could choose; without one, "film-fan's films". The
description names only what the page shows ("The films film-fan has seen",
with the watchlist hidden). It is never in
the sitemap. A not-found page gets
`noindex`, and keeps the shell's generic title.

Next renders the `<head>` again in the browser from the page's inline RSC
payload, so the shell's own tags would come back after hydration. So the shell
has no `robots` or canonical of its own, and its title and description
(`SHELL_TITLE`, `SHELL_DESCRIPTION`) are fixed strings the Worker replaces
everywhere in the page, the payload included. They must match the site's
`PROFILE_SHELL_TITLE` and `PROFILE_SHELL_DESCRIPTION`; if they don't, the
Worker logs an error and the page keeps the shell's. The Open Graph and Twitter
tags are only rewritten in the HTML as sent, which is what link previews read.

A link to a profile previews with its card, below, in place of the site's
image: `og:image` and `twitter:image` become the card's address,
`og:image:width` and `og:image:height` its 1200 by 630, `twitter:card` stays
`summary_large_image`, and the alt text is "<name>'s favourite films", made
of the stripped name or the handle and never a film's title. Without a
poster among the favourites, the preview is the site's.

## The card

`/u/<handle>/card-<hash>.jpg` is a 1200 by 630 JPEG of the reader's favourite
films' posters, fanned out beside their handle on the site's colours
(`src/card.ts`). Posters and handle only: a display name is the reader's own
words, drawn under our name, and could need a font for any script, where a
handle is `[a-z0-9_-]` and one font, Montserrat Bold, covers every one. Only
favourites with a poster are drawn, up to four, in the reader's order. A long
handle shrinks to 36px and then wraps, after a `-` or `_` where it has one.

- **The hash** is the first 12 hex digits of a SHA-256 of the handle, each
  drawn favourite's id and poster path, and `CARD_VERSION`. A site that has
  kept a preview of the old favourites fetches a new address when they
  change; bump `CARD_VERSION` with any change to how a card looks.
- **The profile is checked on every request**, in its `ProfileCache` as a
  view checks it, so a card is gone as soon as its page is: a private,
  revoked, unknown or posterless profile is a bare `404 Not found`. A hash
  that isn't the current one is a 302 to the one that is.
- **Drawn once and kept** in the profile's `ProfileCache`, under its hash.
  Purges leave it, as its hash changes with anything it shows; only the
  latest is kept, and the alarm deletes it with the copy. A render counts
  against the per-IP `MISS_LIMIT`. Served with `max-age=300`, so a browser
  stops showing a private profile's card within the cache's five minutes; a
  site that has stored its own preview is out of reach either way.
- **Posters** are fetched from TMDB at 342px wide and handed to Satori as
  data. A poster that can't be fetched makes the card a 503, and nothing is
  kept: a card is drawn whole or not at all.

Each request is logged as `{"event":"profile-card","handle","state"}`, with
`state` one of `hit`, `rendered`, `redirect`, `none`, `limited` or
`unavailable`.

Satori lays the card out as SVG, resvg draws its pixels and mozjpeg (through
`@jsquash/jpeg`) encodes them, all three as WebAssembly that wrangler bundles
precompiled, as a Worker can't compile it at run time; they're set up on the
first render rather than at start-up. It's a JPEG because it's posters: about
95KB for four, against 670KB as a PNG. Baseline at quality 85: at 75 the pink
wordmark's edges soften, and progressive saves 5% for twice the encoding.
**Satori is pinned at 0.32.0**: from 0.33.0 its standalone build compiles
WebAssembly as it's imported, which a Worker refuses. The drop shadows a
design might want cost resvg 2.2s of a 2.4s render, so posters have a thin
light edge instead.

## CPU

The Worker decodes the lists and film details from Firestore's REST format,
which is two to three times the size they're stored at. `npm run bench:cpu`
times that, from parsing Firestore's answer to serialising the script tag:
about 15ms for 2,000 films with their details and 75ms for 10,000, on an
M-series Mac. Workers Logs show the real figure per request. `limits.cpu_ms`
in `wrangler.jsonc` caps a request at 3,000ms: Workers Paid has no spend cap,
so the limit is the guard against a runaway request. It's set for drawing a
card, 350-440ms in Node, with headroom until Workers Logs show what one really
costs.

The bench also prints the sizes. Decoding more than halves the raw payload
(7.4MB to 3.4MB for 10,000 films), but gzip had already taken out most of
REST's repetition, so on the wire it's about the same. What the decoding saves
is the browser's work: it parses plain JSON instead of decoding Firestore's.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # add the service account key
npm run dev                      # http://localhost:8788
npm test
npm run lint
```

`npm run dev` reads the live Firestore project. The site's `next dev` sends
`/u/*` here, and this fetches the shell back from `next dev`, so run both and
visit `http://localhost:3000/u/<handle>/`.

After changing `wrangler.jsonc`, run `npm run cf-typegen` and commit
`worker-configuration.d.ts`.

## Deployment

`.github/workflows/deploy.yml` lints and tests every push and pull request, and
deploys on pushes to `main`. The service account key is a secret stored on the
Worker: it persists across deploys and never goes in the repo or CI.

The site's `/profile-shell/` must be live before the Worker is: without it,
every profile is a 503.

### The service account

In the Google Cloud console for `clusterflick-com`, under IAM → Service
accounts, create one for this Worker alone and give it the **Cloud Datastore
Viewer** role (`roles/datastore.viewer`). That role reads every document in the
project, since Firestore has no narrower IAM role; what this Worker reads, and
what it passes on, is limited by its code. Create a JSON key for it.

### First deploy

CI can't create the Worker. `wrangler.jsonc` marks `FIREBASE_SERVICE_ACCOUNT` and
`PURGE_SECRET` as required, so wrangler refuses to deploy a new Worker without it, and
`wrangler secret put` only works on a Worker that already exists. The first
deploy is from a machine with the key, which creates the Worker and its secret
together:

```sh
# A file holding only the secret: `.dev.vars` also points SITE_ORIGIN at localhost.
node -e 'console.log(`FIREBASE_SERVICE_ACCOUNT=\x27${JSON.stringify(require("./key.json"))}\x27`)' > /tmp/profiles.env
echo "PURGE_SECRET=$(openssl rand -hex 32)" >> /tmp/profiles.env
npx wrangler login
npx wrangler deploy --secrets-file /tmp/profiles.env
rm /tmp/profiles.env
```

Then add the repository secrets `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare
Workers" template, scoped to the account and the `clusterflick.com` zone) and
`CLOUDFLARE_ACCOUNT_ID`, and CI deploys from then on. Delete the key file once
it's on the Worker.

### Adding PURGE_SECRET to a Worker that already exists

The purge came after the first deploy, so the live Worker needs the secret
before CI can deploy a `wrangler.jsonc` that requires it:

```sh
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put PURGE_SECRET
```

and give the same value to the site's scripts as `PROFILES_PURGE_SECRET`
(see `scripts/lib/purge-profile.js` in the site).

### Rotating the key

Create a new key for the service account, then:

```sh
node -e 'process.stdout.write(JSON.stringify(require("./new-key.json")))' | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

and delete the old key in the console.

## License

[MIT](LICENSE)
