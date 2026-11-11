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

Two requests to Firestore's REST API, as a service account:

1. `handles/{handle}`, which holds the owner's uid.
2. One `batchGet` of `users/{uid}/meta/profile` (`handle`, `public`),
   `users/{uid}/meta/capabilities` (`publicProfile`) and `users/{uid}` (`seen`,
   `watchlist`), through a field mask, so the reader's other fields are never
   fetched.

A profile is shown only when all of these hold:

- the handle's uid leads to a profile that names the same handle (the Admin
  SDK skips the rules, so a hand edit could leave a stale handle behind)
- the profile is `public`
- the reader has the `publicProfile` capability

## What it sends

The page gets this, as `<script type="application/json" id="profile-data">` in
`<head>`, with `<` escaped so a film title can't close the tag:

```json
{
  "found": true,
  "handle": "film-fan",
  "seen": {
    "count": 412,
    "films": [
      { "id": "438631", "title": "Dune", "year": "2021", "posterPath": "/…" }
    ]
  },
  "watchlist": { "count": 37, "films": [] }
}
```

`films` is the 24 most recently added (`RECENT_FILMS`), each the list entry's
own snapshot. Never the uid, the email address, or any field the reader didn't
choose to publish. A not-found page gets `{ "found": false, "handle": "…" }`;
the handle is there only when the path held a valid one, so the page can tell
its owner why their profile isn't showing.

For a public profile the Worker also rewrites the `<head>`: the title,
description, Open Graph and Twitter tags, the canonical link, and `robots` from
the shell's `noindex` to `index, follow`. Making a profile public is the consent
to its being found. It is never in the sitemap. A not-found page keeps the
shell's `noindex` and generic title, and loses its canonical link.

## CPU

Workers Free allows 10ms of CPU a request. A field mask can't trim a map, so a
reader's whole Seen list is parsed, though only the films sent are decoded.
`npm run bench:cpu` times that for 2,000 films: about 3ms on a fresh isolate,
2ms warm, on an M-series Mac. Workers Logs show the real figure per request.

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
