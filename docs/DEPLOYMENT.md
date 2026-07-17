# Deploying via Cloudflare Workers Builds (GitHub integration)

This connects the Cloudflare Worker directly to the `swamp2k/savethe` GitHub repo so
every push to `main` builds and deploys automatically — no local `wrangler deploy`,
no API token to manage. This is a one-time setup done in the Cloudflare dashboard
(it requires an interactive GitHub OAuth grant, so it can't be scripted).

The Worker (`savethe`) already exists — it was deployed once manually via
`npm run deploy`. This setup attaches Git builds to that existing Worker rather than
creating a new one.

## Prerequisites

- `main` on GitHub already has `wrangler.jsonc`, `package.json`, and the full
  `src/` tree at the repo root (it does, as of this writing).
- You have owner/admin access to both the Cloudflare account and the GitHub repo.

## Steps

1. **Open the Worker.** Cloudflare dashboard → **Workers & Pages** → click **savethe**.

2. **Go to Settings → Builds** (may be labeled **Build** or **Git integration**
   depending on dashboard version).

3. **Connect to Git** → **GitHub** → authorize the Cloudflare GitHub App if prompted.
   Grant it access to the `swamp2k/savethe` repository (only that repo, not your
   whole account, unless you want it available to other projects too).

4. **Select the repository and production branch:**
   - Repository: `swamp2k/savethe`
   - Production branch: `main`
   - Leave "Deploy previews for pull requests" **on** if you want a preview Worker
     per PR — useful once there's real gameplay to review, harmless now.

5. **Build configuration:**
   - **Root directory:** `/` (repo root)
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy -c ./dist/savethe/wrangler.json`

     (This matches the path our own `npm run deploy` script uses — the Cloudflare
     Vite plugin writes a fully-resolved wrangler config into `dist/savethe/` at
     build time because `wrangler.jsonc` at the repo root deliberately omits the
     assets `directory`, which the plugin fills in. Pointing at the root
     `wrangler.jsonc` directly will fail with a "missing directory" error.)
   - **Build watch paths:** leave default (any changed file triggers a build) unless
     you later want to exclude non-code paths like `docs/`.

6. **Environment variables:** none required yet. Phase 1 has no secrets. If a later
   milestone adds one (e.g. an external API key), add it here as an **encrypted**
   variable — never commit it to the repo.

7. **Node version:** if the dashboard asks, pin it to the version this repo was
   built against (`node --version` locally) via a `NODE_VERSION` build variable, or
   add a `.nvmrc` to the repo root if you want it version-controlled instead.

8. **Save**, then trigger the first build (either push a commit to `main` or use the
   dashboard's "Retry deployment" / "Deploy now" button if offered).

## Verifying it worked

- Dashboard → **Workers & Pages → savethe → Deployments** should show a new
  deployment sourced from your latest commit on `main`, with build logs.
- Hit the deployed URL and confirm the SPA loads and `/ws/<code>` still returns
  426 for a non-upgrade request (the routing check from PLAN.md M0).
- Push a trivial commit to `main` and confirm a new deployment fires automatically
  without you touching `wrangler` locally.

## Notes specific to this project

- **Durable Object migrations** (`wrangler.jsonc`'s `migrations` block) are applied
  automatically by `wrangler deploy` as part of the Git-triggered deploy, same as a
  manual deploy — no separate step needed when a future milestone adds a new
  migration tag.
- **Local deploys still work** (`npm run deploy`) if you ever need to push a hotfix
  outside the normal PR/merge flow — Workers Builds and manual `wrangler deploy`
  target the same Worker and don't conflict, they just both update it.
- If a branch other than `main` needs its own auto-deployed environment later
  (e.g. a staging Worker), that's a separate Workers Builds "environment" pointed
  at that branch — not covered here since Phase 1 only needs one environment.
