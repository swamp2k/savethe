# Save The...

A browser-based multiplayer party game for 2–5 players. The group elects one player
(the **MPC**) to play a skill minigame that rescues a plushie from a cartoon doom
machine; everyone else actively supports. Between rounds the group votes to **bank**
(play it safe) or **risk** (harder round, better reward).

See **[PLAN.md](./PLAN.md)** for the roadmap and design decisions, and
**[CLAUDE.md](./CLAUDE.md)** for the architecture rules.

## Stack

React + TypeScript + Vite SPA · Cloudflare Worker (Static Assets) · one `GameRoom`
Durable Object per room (SQLite-backed, hibernatable WebSockets) · Vitest with
`@cloudflare/vitest-pool-workers`.

## Getting started

```bash
npm install
npm run dev        # local dev (Vite + Worker via the Cloudflare plugin)
```

Open http://localhost:5173, create a room, and share the 3-character code (e.g. `PW7`).

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Local dev server (client + Worker + DO)       |
| `npm run test`      | Vitest (engine, protocol, Durable Object)     |
| `npm run typecheck` | `tsc --noEmit` for client and worker projects |
| `npm run lint`      | ESLint                                        |
| `npm run build`     | Production build                              |
| `npm run deploy`    | Build, then deploy to Cloudflare              |

All four of `typecheck`, `lint`, `test`, `build` must pass before any commit.

For automatic deploys on push instead of running `npm run deploy` by hand, see
**[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** — one-time Cloudflare Workers Builds
setup that connects the Worker to this GitHub repo.

## Status

**Milestones 0–3 built and deployed.**

- **M0/M1:** scaffold + deploy pipeline; 3-character room codes, typed & validated
  WebSocket protocol, connection-derived identity with reconnect
  (newest-connection-wins), lobby UI, roster/room lifecycle on Durable Object alarms.
- **M2:** the full round loop on a pure, deterministic engine — phase state machine,
  MPC voting (live tallies, previous-MPC exclusion, 2-player alternation, tie-break),
  Bank/Risk with the trophy shelf, difficulty scaling, per-player state projection,
  and a minigame plugin contract + registry.
- **M3:** the Reaction Test — MPC arms the test, a random signal delay stays hidden
  from every client (the deadline is deliberately suppressed so nobody can time a
  click to a known schedule), then a threshold-based click with server-side
  plausibility validation. Miss it and the whole support team gets one shared
  emergency-rescue window. Hydraulic-press presentation with escalating plushie mood,
  and a resolution-time stat reveal of everyone's reaction times.

**M3's exit criteria has one piece left that only a human can do: a real 3+ person
playtest.** See PLAN.md's Milestone 3 section for what's built vs. still open before
starting M4.
