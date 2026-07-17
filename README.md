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

Open http://localhost:5173, create a room, and share the `SAVE-XXXX` code.

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

## Status

**Milestones 0–2 complete.**

- **M0/M1:** scaffold + deploy pipeline; room codes, typed & validated WebSocket
  protocol, connection-derived identity with reconnect (newest-connection-wins),
  lobby UI, roster/room lifecycle on Durable Object alarms.
- **M2:** the full round loop on a pure, deterministic engine — phase state machine,
  MPC voting (live tallies, previous-MPC exclusion, 2-player alternation, tie-break),
  Bank/Risk with the trophy shelf, difficulty scaling, per-player state projection,
  and a minigame plugin contract + registry driving a placeholder "debug" minigame.
  All deadlines run on Durable Object alarms.

Next up is Milestone 3 — the Reaction Test minigame and the Hydraulic Press
presentation (the playable vertical slice). See PLAN.md.
