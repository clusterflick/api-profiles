# api-profiles

> **[Clusterflick](https://clusterflick.com)** is a free, open-source site
> listing every film showing in London, from 450+ venues in one search.
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

## Routes

The Worker owns everything under `/u`, on the routes `clusterflick.com/u/*`
(which also matches `/u/`) and `clusterflick.com/u`.

| Request                                           | Response                                         |
| ------------------------------------------------- | ------------------------------------------------ |
| `/u`                                              | 301 → `/u/`                                      |
| `/u/`                                             | 302 → `/personalise/`                            |
| `/u/<Handle>` or `/u/<handle>`                    | 301 → `/u/<handle>/`, lowercased                 |
| `/u/<handle>/`, public                            | 200, the shell with the profile                  |
| `/u/<handle>/`, unknown, private or not permitted | 404, the shell in its not-found state            |
| Anything else under `/u/`                         | 404, the same, without reading Firestore         |
| Firestore, Google or the site failed              | 503, plain text, so nothing is told it's missing |

`/u/` redirects temporarily so it can become a directory of people later.
Handles are `^[a-z0-9_-]{3,30}$`, lowercase everywhere, as the site's
Firestore rules enforce.

The three kinds of not-found are the same response, byte for byte, so nobody
can tell a private profile from a missing one. Nothing is cached, so switching
a profile off takes effect on the next request.

## What it reads

Three requests to Firestore's REST API, as a service account:

1. `handles/{handle}`, which holds the owner's uid.
2. A `batchGet` of `users/{uid}/meta/profile` (`handle`, `public`,
   `sections`, `displayName`, `links`) and `users/{uid}/meta/capabilities`
   (`publicProfile`).
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
Letterboxd username, IMDb user id (`ur…`) and an https website. The site's
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

## What it sends

The page gets this, as `<script type="application/json" id="profile-data">` in
`<head>`, with `<` escaped so a film title can't close the tag:

```json
{
  "found": true,
  "handle": "film-fan",
  "displayName": "Siobhán O'Brien",
  "links": { "letterboxd": "film_fan", "imdb": "ur1234567" },
  "sections": { "watchlist": true, "seen": true, "seenStats": true, "favouriteVenues": false },
  "documents": [
    { "found": { "name": "projects/…/documents/users/-", "fields": { "seen": { "mapValue": { … } } } } },
    { "missing": "projects/…/documents/users/-/meta/films" }
  ]
}
```

`documents` is the third request's answer as Firestore sent it, undecoded, with
the uid in each name replaced by `-`. The page decodes it and draws the profile
as `/personalise` draws the owner's own, with only the sections shown. It
needs `sections` to tell a hidden list from an empty one, since both arrive as
a field that isn't there. Never the uid, the email address, or any field
outside the mask. A not-found page gets `{ "found": false, "handle": "…" }`;
the handle is there only when the path held a valid one, so the page can tell
its owner why their profile isn't showing.

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

## CPU

Workers Free allows 10ms of CPU a request. Firestore's REST format is two to
three times the stored size, and decoding a long Seen list in it costs more
than that, so the Worker decodes only the three small documents it checks.
The lists and film details pass through as text: taking out the uid and
escaping them is all it does to them. `npm run bench:cpu` times that: 0.3ms
for 2,000 films with their details (1.6MB), 1.1ms for 10,000 (7.4MB), on an
M-series Mac. Workers Logs show the real figure per request.

On the Workers Paid plan, with CPU to spare, the Worker could decode them and
send the page a smaller payload instead.

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

CI can't create the Worker. `wrangler.jsonc` marks `FIREBASE_SERVICE_ACCOUNT` as
required, so wrangler refuses to deploy a new Worker without it, and
`wrangler secret put` only works on a Worker that already exists. The first
deploy is from a machine with the key, which creates the Worker and its secret
together:

```sh
# A file holding only the secret: `.dev.vars` also points SITE_ORIGIN at localhost.
node -e 'console.log(`FIREBASE_SERVICE_ACCOUNT=\x27${JSON.stringify(require("./key.json"))}\x27`)' > /tmp/profiles.env
npx wrangler login
npx wrangler deploy --secrets-file /tmp/profiles.env
rm /tmp/profiles.env
```

Then add the repository secrets `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare
Workers" template, scoped to the account and the `clusterflick.com` zone) and
`CLOUDFLARE_ACCOUNT_ID`, and CI deploys from then on. Delete the key file once
it's on the Worker.

### Rotating the key

Create a new key for the service account, then:

```sh
node -e 'process.stdout.write(JSON.stringify(require("./new-key.json")))' | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

and delete the old key in the console.

## License

[MIT](LICENSE)
