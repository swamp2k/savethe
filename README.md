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

**Milestone 0 + 1 complete:** project scaffold and deploy pipeline; room codes, typed
& validated WebSocket protocol, connection-derived identity with reconnect
(newest-connection-wins), the lobby UI, and roster/room lifecycle with Durable Object
alarms. Next up is Milestone 2 — the round engine (see PLAN.md).
