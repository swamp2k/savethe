# Save The... — project guide

Browser-based multiplayer party game (2–5 players): the group elects one player (the
MPC) to play a skill minigame that rescues a plushie from a cartoon doom machine;
the others actively support. Push-your-luck Bank/Risk voting between rounds.

**Read `PLAN.md` first.** It is the agreed roadmap with per-milestone exit criteria
and the binding design decisions. Work milestone by milestone; do not pull Phase 2
mechanics (rarity, abilities, sacrifices, wheels…) forward.

## Stack

React + TypeScript + Vite SPA · Cloudflare Worker (Static Assets) · one `GameRoom`
Durable Object per room (SQLite-backed, hibernatable WebSockets) · Vitest with
`@cloudflare/vitest-pool-workers`.

## Commands

```
npm run dev        # local dev (wrangler + vite)
npm run test       # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # production build
npm run deploy     # wrangler deploy
```

All four of `typecheck`, `lint`, `test`, `build` must pass before any commit.

## Architecture rules (non-negotiable)

1. **Server-authoritative.** Clients send actions ("I clicked"), never results
   ("my score is 100"). The server owns phases, timers, votes, outcomes. Exception:
   reaction-style timing uses client-measured elapsed time with server-side
   plausibility validation (see PLAN.md decision 3) — the server still issues the
   verdict.
2. **Pure engine.** The game engine imports no Workers APIs, React, wall-clock, or
   `Math.random`. It receives `(state, action, ctx: { now, random })` and returns new
   state. Everything is deterministically testable.
3. **Minigames are plugins.** The engine and `GameRoom` contain zero
   minigame-specific branches (`if (game === "typing")` is a bug). A registry maps
   IDs to implementations of the common contract. Adding a minigame touches only:
   its plugin module, the registry, its UI component, and its tests.
4. **Per-player projections.** Minigames expose `getStateForPlayer(playerId)` —
   different players may legitimately see different state. Never broadcast raw
   internal minigame state.
5. **Alarms, not timers.** The DO hibernates; `setTimeout` state dies. Every deadline
   is persisted state plus a Durable Object alarm.
6. **Identity from the connection.** Player identity derives from the session
   attached to the socket, never from message payloads.
7. **Validate at the boundary.** Every inbound message is schema-validated and
   phase-checked before touching state. Malformed input must never corrupt a room.

## Testing philosophy

Tests are part of feature development, not an afterthought. Priorities: engine phase
transitions and voting rules · minigame thresholds, invalid/duplicate/out-of-phase
actions · DO integration (persistence, reconnect, room isolation, alarm firing) ·
protocol fuzzing (malformed JSON, unknown types, spoofing attempts) · full-flow smoke
tests (success path, failure path, reconnect path).

Deterministic timing: engine and minigame tests inject `now`/`random` — never sleep,
never rely on real clocks.

## Conventions

- Shared protocol types live in a module imported by both client and server; message
  types are a discriminated union validated with a schema library at the boundary.
- Design intent lives in the game bible (external doc) as distilled into PLAN.md.
  When gameplay questions arise, PLAN.md's "Design decisions" section wins.
- Tone: cartoon peril, absurd drama. Cute things in ridiculous danger. No horror,
  no gore.

# Agent Development and Validation Workflow

## Test strategy

Optimize for fast iteration during implementation.

While actively modifying code:

* Run only targeted tests directly relevant to the files or features being changed.
* Prefer individual test files, test suites, or focused test filters over the complete test suite.
* Do not repeatedly run the full test suite, lint, typecheck, and production build after every code change.
* When a targeted test fails, fix the issue and rerun only that test or the smallest relevant test set.

## Final validation

Once implementation is complete, run the full validation suite:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test`
4. `npm run build`

Run each full validation command once initially.

If one command fails:

* Investigate and fix the failure.
* Rerun the failed command first.
* Only rerun other validation commands if the fix could reasonably affect them.
* Do not automatically restart the entire validation suite after every minor fix.

Before finishing, ensure all four validation commands have passed against the final code state.

## Manual testing

Do not attempt elaborate manual multi-player or multi-browser smoke tests unless the task specifically requires agent-driven browser testing.

For features that require several real players, subjective gameplay evaluation, physical input timing, or human UX judgement:

* Implement the feature.
* Verify it technically with targeted automated tests.
* Clearly describe what requires human playtesting in the final report.

Human multiplayer playtesting will be performed separately.

## General principle

Spend compute and time where it provides useful confidence.

During implementation:

`edit → targeted test → edit → targeted test`

At completion:

`typecheck → lint → full test suite → build`

Avoid:

`edit → typecheck → lint → all tests → build → edit → repeat everything`
