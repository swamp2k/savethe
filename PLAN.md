# Save The... — Implementation Plan

A browser-based multiplayer party game for 2–5 players. One player (the MPC) plays a
skill minigame to rescue a cute plushie from an absurd doom machine; everyone else
supports. Success adds the plushie to an unbanked collection; the group then votes to
bank (safe) or risk (harder round, better reward).

This plan is the agreed roadmap. Work top to bottom. Each milestone ends with explicit
exit criteria — do not start the next milestone until they pass.

**Status: M0–M4 built and deployed, M3 playtest gate cleared.** Scaffold,
rooms/identity, the full round engine, Reaction Test, and Typing Challenge are all
live, with weighted random selection between them. A real playtest happened with 2
players (this plan originally called for 3+; the user confirmed 2-person testing is
sufficient for their purposes and signed off) — the core loop held up and it worked.
Go for M5.

---

## Design decisions (deviations & additions to the design doc)

These were flagged during planning review and are considered part of the agreed design:

1. **Banking must not end the session — trophy shelf.** In the original loop, BANK ends
   the run, meaning the reward for playing safe is *stopping the fun* — groups would
   always risk because they came to play. Fix: a *run* is like a hand of cards. Banking
   (or failing) ends the run, shows a summary, and flows straight into a new run with
   the same players. Banked plushies accumulate on a session-wide **trophy shelf**
   visible to everyone. Score across the session = trophies collected. Bank/Risk is now
   a real decision instead of "do we want to stop playing?".

2. **Failure also flows into a new run.** No dumping players back to the lobby. Run
   summary screen (what was lost, everyone's stats) → next run starts.

3. **Reaction timing must account for network latency.** Pure server-side timing adds
   each player's RTT (30–150 ms) to their reaction time — unfair and inconsistent at a
   500 ms threshold. Approach: the client measures elapsed time locally (signal shown →
   click) and reports it; the server validates plausibility (message cannot arrive
   earlier than signal-send + claimed elapsed, minus small tolerance; claimed values
   outside human bounds are rejected). The server still owns the verdict. This is a
   party game among friends — light anti-cheat is enough.

4. **Per-player state projection from day one.** The minigame contract exposes
   `getStateForPlayer(playerId)`, not a single `getPublicState()`. Memory-game clues,
   the Traitor Button, and support-only prompts all require different players seeing
   different things. Retrofitting this later would touch every minigame.

5. **All deadlines via Durable Object alarms.** Hibernatable WebSockets mean in-memory
   timers (`setTimeout`) die when the DO hibernates. Every timed thing (vote windows,
   reaction delays, challenge timers) is a persisted deadline plus a DO alarm. The
   minigame contract's `getNextDeadline()` feeds this.

6. **Small-lobby rules.**
   - 2 players: skip the MPC vote entirely — MPC alternates automatically.
   - 3+ players: normal voting; previous MPC excluded; self-votes allowed
     (volunteering is fun).
   - MPC vote tie → random among tied (server RNG, deterministic in tests).

7. **Every vote has a deadline.** An AFK player must never stall the room. Non-voters
   abstain. Bank/Risk: RISK requires a strict majority of votes cast; tie or all-abstain
   → BANK (safe default; tunable later).

8. **Cheap attachment wins (in scope for v1).**
   - After a rescue, the MPC names the plushie (with a silly default offered).
   - Round resolution reveals everyone's numbers ("Martin: 612 ms. Lisa: 289 ms —
     EMERGENCY SAVE"). Fuel for the social ribbing that is the actual product.

9. **Difficulty scales within a run from v1.** For Reaction Test: the threshold
   tightens each round (e.g. 500 → 460 → 420 ms…, floor at some minimum). Greed makes
   the game harder, mechanically, from the first playable build.

Everything else follows the design doc: server-authoritative, plugin minigames,
deterministic pure engine, explicit phase state machine, no accounts.

---

## Architecture summary

```
Browser (React/Vite SPA)
    │  WebSocket (typed, validated protocol)
    ▼
Cloudflare Worker (routing, static assets)
    ▼
GameRoom Durable Object  (one per room code, SQLite-backed, hibernatable WS)
    ▼
Pure game engine  (no I/O; injected { now, random }; phase state machine)
    ▼
Minigame plugins  (registry: id → implementation of the common contract)
```

Hard rules (also in CLAUDE.md):
- Clients send **actions**, never results. The server decides outcomes.
- The engine never imports Workers APIs, React, or wall-clock/`Math.random` — time and
  randomness are injected. All engine logic is deterministically testable.
- The engine contains **zero** minigame-specific branches. Adding a minigame touches
  only its plugin module, the registry, and its UI component.
- Player identity derives from the connection/session, never from message payloads.
- Invalid or out-of-phase messages are rejected at the boundary and cannot corrupt
  room state.

Minigame plugin contract (conceptual):

```
createInitialState(config, ctx)
start(state, ctx)
handleMpcAction(state, action, ctx)
handleSupportAction(state, playerId, action, ctx)
onDeadline(state, ctx)              // alarm fired
evaluate(state, ctx) → active | success | failure
getStateForPlayer(state, playerId)  // per-player projection
getNextDeadline(state)
```

---

## Milestone 0 — Foundations & deploy pipeline

Prove the stack end-to-end before writing any game logic.

- Scaffold: Vite + React + TypeScript SPA; Worker with Static Assets; one
  `GameRoom` Durable Object binding (SQLite-backed); `wrangler.jsonc`.
- Tooling: Vitest with the Workers pool (`@cloudflare/vitest-pool-workers`), ESLint,
  strict TypeScript. Canonical scripts: `dev`, `test`, `typecheck`, `lint`, `build`,
  `deploy`.
- Walking skeleton: page opens a WebSocket to `/ws/:room`, the DO echoes messages,
  proof it survives hibernation (alarm-based ping).
- Deploy to workers.dev **now** — routing bugs (like the known `/ws/*` vs `/ws` issue)
  surface on day one, not launch week.

**Exit criteria:** deployed URL loads the SPA; a WS message round-trips through the DO
in production; all scripts pass; one DO test and one protocol test exist as templates.

## Milestone 1 — Rooms, identity, protocol

- Room creation with codes (3 characters, unambiguous alphabet, e.g. `PW7`, collision-checked).
- Typed discriminated-union protocol with boundary validation (e.g. zod): `room.join`,
  `room.reconnect`, plus error replies. Malformed input never throws in the DO.
- Session identity: persistent ID in localStorage; reconnect restores the same player
  and receives a full authoritative snapshot; newest connection wins, old socket closed.
- Lobby UI: create/join, nickname, live roster, connection status, 2–5 player limits.
- Room lifecycle: empty-room cleanup via alarm; stale-player timeout.

**Exit criteria:** two browsers join the same room and see each other live; refreshing
mid-lobby restores identity; join of a full/nonexistent room fails cleanly; tests cover
join/reconnect/duplicate-session/validation.

## Milestone 2 — Round engine (with a debug minigame)

The complete game loop, using a trivial placeholder minigame (a "succeed / fail" debug
button, itself written as a plugin — the first consumer of the contract).

- Pure engine module: phase state machine
  `LOBBY → MPC_VOTING → MPC_SELECTED → CHALLENGE_INTRO → CHALLENGE_ACTIVE →
  ROUND_RESOLUTION → RISK_VOTING → (bank → RUN_COMPLETE | risk → MPC_VOTING)`,
  failure path → `RUN_FAILED`. Out-of-phase actions rejected.
- MPC voting with live tallies, previous-MPC exclusion, 2-player alternation,
  deadline + tie rules (decision 6/7).
- Plushie assignment per round, unbanked collection, Bank/Risk vote, trophy shelf,
  run summary → auto new run (decisions 1/2).
- Difficulty level increments per round and is passed into the minigame config.
- All deadlines persisted + DO alarm wiring.
- Minimal functional UI for every phase (ugly is fine; correct is required).

**Exit criteria:** 3 browsers play full runs end-to-end with the debug minigame —
bank path, fail path, multi-round risk path; refresh mid-anything recovers; engine
test suite covers phases, voting, eligibility, bank/risk, tie and timeout rules.

## Milestone 3 — Reaction Test + Hydraulic Press (the vertical slice)

The first real minigame and the first real presentation layer. This is the build that
answers the core question: *is it fun?*

- Reaction Test plugin: server-scheduled random delay (alarm), signal broadcast,
  client-measured elapsed with server plausibility validation (decision 3), false-start
  handling, MPC threshold scaled by difficulty, support rescue window (harder
  threshold) after MPC failure.
- The three outcomes: clean victory / team rescue / total failure — each with a
  distinct resolution beat.
- Presentation: bear visibly under the hydraulic press during the challenge, escalating
  worry expressions, press slam on failure (stuffing everywhere), rescue animation on
  success. Spectators see MPC status live.
- Round-resolution stat reveal; MPC names the rescued plushie (decision 8).
- A handful of plushie types (bear, penguin, frog…) with generated silly default names.

**Exit criteria:** all M2 exit tests still pass with Reaction Test swapped in via the
registry (no engine changes); deployed; **playtest with 3+ real humans in the same
room**. Go/no-go: if the core loop isn't fun, iterate here — do not proceed to M4.

**Status:** built and deployed — Reaction Test plugin, three outcomes, hydraulic-press
presentation with escalating mood, resolution-time stat reveal (elapsed times for
everyone who attempted). 80 automated tests pass, including the same engine suite
from M2 driving rounds through the real Reaction Test with no engine changes. Verified
live against the dev Worker (real WebSockets + DO alarms): clean victory, MPC
alternation across rounds, the hidden-signal window, a too-slow-but-valid MPC click
correctly opening the support window, and a correctly-timed team rescue.

**Not yet done:** MPC naming the rescued plushie (decision 8) — plushies currently get
a random silly default name only; there's no rename action yet. Small, deferred rather
than blocking.

**Playtest: done.** Played with 2 real people (this section originally called for 3+;
the user confirmed 2-person testing is sufficient for their purposes and signed off).
It worked — go for M5.

## Milestone 4 — Typing Challenge (architecture stress test)

Typing exists primarily to prove the plugin abstraction: continuous progress,
simultaneous multi-player input, per-player support state, composite save conditions.

- Typing plugin: MPC types a passage toward a target; support players get typing
  bursts; each support success lowers the MPC's requirement / adds time (per design
  doc). Server validates progress increments for plausibility (max human WPM bounds).
- Weighted random minigame selection from the registry (revealed after MPC selection).
- **Hard rule:** if Typing requires changes to the engine, GameRoom, or transport,
  stop and fix the abstraction before shipping the minigame.

**Exit criteria:** both minigames selectable and playable in mixed runs; engine diff
for this milestone touches only plugin, registry, and UI; typing plugin tests
(progress, support effects, WPM plausibility, deadlines).

**Status:** built and deployed. Typing plugin: MPC types a themed passage toward a
target word count; support players work through a repeating queue of short phrases,
each completion lowering the MPC's requirement (floored so support can't trivialize
the task) and able to trigger success outright if it drops the bar to the MPC's
existing progress. Server recomputes correctness fresh from the client's full current
input on every keystroke (not deltas), so corrections just work with no state to
desync; progress is rate-limited against a generous max-WPM ceiling to catch a
paste-like burst. Weighted selection added to the registry (equal weights for now;
the mechanism supports future imbalance). `engine.ts` has a zero-line diff for this
milestone — confirmed via `git diff --stat`, not just claimed — satisfying the exit
criteria's central architectural bet. 112 tests total (33 new), including a
registry-level weighted-selection test and an engine-level test driving a full round
through Typing via the exact same generic dispatch used for every other minigame.
Verified live against the dev Worker: real weighted selection picked both minigames
across consecutive rounds in the same run, a support phrase-completion correctly
lowered the requirement and won the round, and the word-level visual feedback
(correct/mismatch/pending) renders correctly in the browser.

## Milestone 5 — Launch polish

- Juice pass: transitions between phases, countdowns, sound effects, spectator emotes
  (hearts / panic / tomatoes) rendered around the endangered plushie.
- Stakes screen before each risked round: what's being rescued, what's at risk
  (design doc §34).
- Second destruction machine (e.g. cannon into space) chosen randomly per run.
- Mobile layout pass — party games get played on phones on couches.
- Hardening: per-connection message rate limiting, room cap, oversized-message
  rejection, graceful handling of DO eviction mid-game.
- Deploy to a custom domain; smoke-test the full flow from 5 devices.

**Exit criteria:** a stranger can be handed the URL and play a full session without
explanation; complete flows verified on desktop + phone; no console errors; all suites
green.

**Status:** mostly done; two items intentionally deferred (below).

- Juice pass: done, including the two pieces that were missing when this status was
  first written (sound effects, spectator emotes — caught during an M5 audit,
  flagged, then closed out). Transitions/countdowns/party styling (self-hosted
  fonts, candy palette, trophy shelf as HUD centerpiece, springy animations);
  extended with a 3D showcase (real GLB models, idle/dance/failure clips for 24
  species, emoji fallback for the rest); four CC0 sound cues (click, success,
  failure, a last-5-seconds countdown tick) with a persisted Hud mute toggle;
  spectator emotes (heart/panic/tomato) as a pure ephemeral broadcast relay — never
  touching GameState or the engine, gated to an active run, per-player cooldown on
  top of the existing rate limiter so one mashed button can't flood the screen.
  Verified live: sound triggers confirmed via a monkey-patched `Audio.play`, mute
  correctly silencing one player while the other still hears cues, emote burst/
  cooldown/expiry all confirmed via DOM assertions in a scripted two-browser
  playtest. 126 tests passing (up from 121): protocol validation for the new
  `emote` message, and DO-level relay/lobby-gating/cooldown coverage.
- Stakes screen: done. A new `stakes` engine phase sits between a RISK vote and the
  next MPC vote, showing the newly-assigned plushie and the still-unbanked ones at
  risk before play resumes. Only fires for rounds reached via RISK (a run's first
  round has nothing at stake yet). Covered by engine tests and verified live via a
  scripted two-browser playtest.
- Second destruction machine: done. `press` (🏭 Hydraulic Press) or `cannon` (🚀
  Cannon Into Space) is chosen once per run (server-side, injected `random`), shown
  via a persistent Hud chip and the plushie stage/showcase throughout the run;
  purely cosmetic, no engine or minigame branching. Both variants confirmed live.
- Hardening: done. Oversized-message rejection and per-connection rate limiting
  (window-based, state carried on the WebSocket attachment so it survives
  hibernation); a global room cap enforced via a new singleton `RoomRegistry`
  Durable Object (`tryReserve`/`release`, reserved on room creation, released on
  empty-room cleanup); a regression test proving a room resumes correctly if the DO
  instance is torn down and rebuilt mid-game (GameRoom already kept no
  authoritative in-memory state — this was verifying an existing property, not
  fixing a gap). 121 tests passing (up from 115), including one that caught a real
  bug: the join/reconnect handshake was clobbering the rate-limit state on the
  socket's attachment.
- **Deferred by explicit decision, not forgotten:** mobile layout pass, custom
  domain deploy.

---

## Deferred (Phase 2 backlog — do not build until the core loop is proven fun)

In rough priority order: more minigames (Aim Trainer, Memory, Tetris-like, Platformer) •
rarity tiers • plushie abilities (unbanked-only) • The Sacrifice • The Hostage •
The Deal • curses • Traitor Button • Last Chance • Wrong Answer • Wheel of
Consequences • The Machine Is Angry • D1 persistent profiles/collections • R2 assets.

The design doc's own warning stands: the dangerous temptation is building systems
before the basic social experience is fun. M3's playtest gate exists for this reason.

## Open questions (decide before or during the relevant milestone)

- Bank/Risk tie default: BANK (current choice) vs. something crueler. Revisit after
  playtests (M3).
- Reaction support rescue: simultaneous with MPC attempt vs. sequential after failure.
  Current choice: sequential (more dramatic). Revisit after playtests (M3).
- Run length pressure: should reward scaling alone motivate risking, or is a minimum
  round count needed? Playtest data (M3).
