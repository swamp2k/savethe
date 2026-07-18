# Save The...

A browser-based multiplayer party game for 2-5 players. The group elects one player
(the **MPC**) to play a skill minigame that rescues a plushie from a cartoon doom
machine; everyone else actively supports. Between rounds the group votes to **bank**
(play it safe) or **risk** (harder round, better reward).

See **[PLAN.md](./PLAN.md)** for the roadmap and design decisions, and
**[CLAUDE.md](./CLAUDE.md)** for the architecture rules.

## Stack

React + TypeScript + Vite SPA | Cloudflare Worker (Static Assets) | one `GameRoom`
Durable Object per room (SQLite-backed, hibernatable WebSockets) | Vitest with
`@cloudflare/vitest-pool-workers`.

## Getting started

```bash
npm install
npm run dev        # local dev (Vite + Worker via the Cloudflare plugin)
```

Open http://localhost:5173, create a room, and share the 3-character code (for
example, `PW7`).

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Local dev server (client + Worker + DO)       |
| `npm run test`      | Vitest (engine, protocol, Durable Object)     |
| `npm run typecheck` | `tsc --noEmit` for client and worker projects |
| `npm run lint`      | ESLint                                        |
| `npm run build`     | Production build                              |
| `npm run deploy`    | Build, then deploy to Cloudflare              |

All four of `typecheck`, `lint`, `test`, and `build` must pass before any commit.

For automatic deploys on push instead of running `npm run deploy` by hand, see
**[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** for one-time Cloudflare Workers Builds
setup that connects the Worker to this GitHub repo.

## Status

**Milestones 0-5 and the first Phase 2 mechanics pass are complete locally.**

- **M0/M1:** scaffold + deploy pipeline; 3-character room codes, typed and validated
  WebSocket protocol, connection-derived identity with reconnect
  (newest-connection-wins), lobby UI, roster/room lifecycle on Durable Object alarms.
- **M2:** the full round loop on a pure, deterministic engine: MPC voting, Bank/Risk,
  trophy shelf, difficulty scaling, per-player state projection, and a minigame plugin
  contract + registry.
- **M3/M4:** six selectable minigames are live: Reaction Test, Typing Challenge, Aim
  Trainer, Memory, Block Fit, and Obstacle Run. They all share the server-authoritative
  plugin architecture while retaining their own mechanics and player projections.
- **M5:** the presentation layer is live: 3D plushie models (with emoji fallbacks), a
  persistent trophy shelf, stakes screens, spectator emotes, sound, and two
  destruction-machine variants: Hydraulic Press and Cannon Into Space. Durable
  Object-backed persistence and reconnect recovery are part of the core game.

The Bank/Risk loop is the center of the session: banked plushies stay on the trophy
shelf while an unbanked run can be pushed for another rescue. The current Phase 2
direction is risk/rarity progression, social-consequence events, and further
meta-game mechanics that make those decisions more dramatic.

**Phase 2 adds attachment and drama:** every rescued plushie has a generated name,
rarity/value, and rarity-scaled ability. The round's saver names it before Bank/Risk.
Abilities only work while their plushie remains unbanked: Brave Heart lowers future
difficulty, Guardian reduces cruelty odds, Greedy Bastard boosts future values, and
Lucky Charm improves Last Chance odds. A failed rescue may open a single Last Chance
button challenge per run; its hero earns naming rights on success. The cruelty
registry now includes The Sacrifice, a reconnect-safe group vote between the two most
valuable at-risk plushies.

**Playtested with 2 real people** (PLAN.md originally called for 3+; the user
confirmed 2-person testing is sufficient for their purposes) - it worked.

Mobile layout polish and a custom-domain deploy are deferred deliberately, not
forgotten. They are outside this mechanics pass. Phase 2 changes have not yet been
deployed or human-playtested.
