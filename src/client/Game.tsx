import { useEffect, useRef, useState } from 'react';
import type { Connection, EmoteEvent } from './useGameConnection';
import { MACHINES, type GameView, type Plushie } from '../shared/game';
import { ABILITIES } from '../shared/abilities';
import { MIN_PLAYERS, MAX_PLAYERS } from '../shared/constants';
import type { EmoteKind } from '../shared/protocol';
import { useCountdown } from './useCountdown';
import { PlushieShowcase } from './PlushieShowcase';
import { PlushieInspector } from './PlushieInspector';
import { getMinigameUI } from './minigames/registry';
import { playSound, useMuted } from './sound';

const EMOTE_EMOJI: Record<EmoteKind, string> = { heart: '❤️', panic: '😱', tomato: '🍅' };

export function Game({ conn, view }: { conn: Connection; view: GameView }) {
  const nameOf = (id: string | null): string =>
    view.players.find((p) => p.playerId === id)?.nickname ?? '???';

  return (
    <div className="game">
      <Hud conn={conn} view={view} nameOf={nameOf} />
      <PhasePanel conn={conn} view={view} nameOf={nameOf} />
      <EmoteOverlay emotes={conn.emotes} />
      {conn.status === 'reconnecting' && <p className="hint center">Reconnecting…</p>}
      {conn.error && <p className="error center">{conn.error}</p>}
    </div>
  );
}

function Hud({ conn, view, nameOf }: { conn: Connection; view: GameView; nameOf: (id: string | null) => string }) {
  const inRun = view.phase !== 'lobby';
  const [muted, setMuted] = useMuted();
  return (
    <div className="hud">
      <div className="hud__row">
        <span className="chip">Room {view.code}</span>
        {inRun && <span className="chip">Round {view.round}</span>}
        {inRun && (
          <span className="chip">
            {MACHINES[view.machine].emoji} {MACHINES[view.machine].label}
          </span>
        )}
        {view.mpcId && <span className="chip chip--mpc">MPC: {nameOf(view.mpcId)}</span>}
        <button
          className="btn btn--ghost btn--small hud__mute"
          onClick={() => setMuted(!muted)}
          aria-label={muted ? 'Unmute sound' : 'Mute sound'}
          title={muted ? 'Unmute sound' : 'Mute sound'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button className="btn btn--ghost btn--small hud__leave" onClick={conn.leave}>
          Leave
        </button>
      </div>
      {inRun && <EmoteBar conn={conn} />}
      <Shelf label="🏆 Trophy shelf" plushies={view.trophies} empty="Nothing banked yet — go rescue someone!" big />
      {view.unbanked.length > 0 && <Shelf label="😰 At risk" plushies={view.unbanked} danger />}
    </div>
  );
}

/** Spectator reactions — a spam-proof, low-stakes way to cheer or heckle
 *  whoever's on the hot seat. Purely decorative: the click just fires the
 *  emote and lets it fly (server-side per-player cooldown handles spam), no
 *  local disabling or feedback sound needed beyond the burst itself. */
function EmoteBar({ conn }: { conn: Connection }) {
  return (
    <div className="emote-bar">
      {(Object.keys(EMOTE_EMOJI) as EmoteKind[]).map((kind) => (
        <button
          key={kind}
          className="emote-bar__btn"
          onClick={() => conn.sendEmote(kind)}
          aria-label={`Send ${kind} emote`}
        >
          {EMOTE_EMOJI[kind]}
        </button>
      ))}
    </div>
  );
}

/** Floating burst of received emotes, layered over the whole game panel
 *  (design doc: rendered around the endangered plushie). Each entry expires
 *  itself out of `conn.emotes` client-side (useGameConnection); this just
 *  renders whatever's currently alive. */
function EmoteOverlay({ emotes }: { emotes: EmoteEvent[] }) {
  if (emotes.length === 0) return null;
  return (
    <div className="emote-overlay">
      {emotes.map((e) => (
        <span key={e.id} className="emote-overlay__item" style={{ left: `${15 + e.jitter * 70}%` }}>
          {EMOTE_EMOJI[e.kind]}
        </span>
      ))}
    </div>
  );
}

function Shelf({
  label,
  plushies,
  empty,
  danger,
  big,
}: {
  label: string;
  plushies: Plushie[];
  empty?: string;
  danger?: boolean;
  big?: boolean;
}) {
  // Each shelf owns its inspector modal, so every place a shelf renders
  // (Hud, Bank/Risk, Stakes) gets click-to-admire for free.
  const [inspected, setInspected] = useState<Plushie | null>(null);
  return (
    <div className={`shelf ${danger ? 'shelf--danger' : ''} ${big ? 'shelf--big' : ''}`}>
      <span className="shelf__label">
        {label}
        {big && plushies.length > 0 && <span className="shelf__count">{plushies.length}</span>}
      </span>
      <div className="shelf__items">
        {plushies.length === 0 && empty && <span className="shelf__empty">{empty}</span>}
        {plushies.map((p) => (
          <button
            key={p.id}
            className={`shelf__item shelf__item--${p.rarity}`}
            title={`${p.name} — click for a closer look`}
            onClick={() => setInspected(p)}
          >
            <span className="shelf__item-emoji">{p.emoji}</span>
            {big && <span className="shelf__item-name">{p.name} · {p.value}★</span>}
          </button>
        ))}
      </div>
      {inspected && <PlushieInspector plushie={inspected} onClose={() => setInspected(null)} />}
    </div>
  );
}

function totalValue(plushies: Plushie[]): number {
  return plushies.reduce((total, plushie) => total + plushie.value, 0);
}

function PhasePanel({
  conn,
  view,
  nameOf,
}: {
  conn: Connection;
  view: GameView;
  nameOf: (id: string | null) => string;
}) {
  switch (view.phase) {
    case 'lobby':
      return <Lobby conn={conn} view={view} />;
    case 'mpc_voting':
      return <MpcVoting conn={conn} view={view} nameOf={nameOf} />;
    case 'mpc_selected':
      return <MpcSelected view={view} nameOf={nameOf} />;
    case 'challenge_intro':
      return <ChallengeIntro view={view} nameOf={nameOf} />;
    case 'challenge_active':
      return <Challenge conn={conn} view={view} nameOf={nameOf} />;
    case 'round_resolution':
      return <Resolution conn={conn} view={view} nameOf={nameOf} />;
    case 'plushie_naming':
      return <PlushieNaming conn={conn} view={view} nameOf={nameOf} />;
    case 'risk_voting':
      return <RiskVoting conn={conn} view={view} />;
    case 'cruelty_event':
      return <CrueltyEventPanel conn={conn} view={view} nameOf={nameOf} />;
    case 'stakes':
      return <Stakes view={view} />;
    case 'last_chance':
      return <LastChance conn={conn} view={view} nameOf={nameOf} />;
    case 'run_complete':
    case 'run_failed':
      return <RunOver view={view} />;
  }
}

function CrueltyEventPanel({ conn, view, nameOf }: { conn: Connection; view: GameView; nameOf: (id: string | null) => string }) {
  const event = view.cruelty;
  if (!event) return null;
  if (event.kind === 'the_sacrifice') {
    const candidates = event.candidateIds.map((id) => view.unbanked.find((plushie) => plushie.id === id)).filter((plushie): plushie is Plushie => plushie !== undefined);
    const victim = event.sacrificedPlushie ?? null;
    if (event.stage === 'resolved') return <div className="panel center-panel cruelty-panel"><Timer remainingMs={view.deadlineRemainingMs} /><h2 className="panel__title">YOU CHOSE POORLY.</h2>{victim ? <PlushieShowcase plushie={victim} mood="😵" animation="gesture-negative" machine={view.machine} /> : <p className="big-reveal bad">The sacrifice is complete.</p>}<p className="hint center">{victim ? `${victim.name} has been sacrificed.` : 'The machine has taken its tribute.'}</p></div>;
    return <div className="panel center-panel cruelty-panel"><Timer remainingMs={view.deadlineRemainingMs} /><h2 className="panel__title">THE SACRIFICE</h2><p className="hint center">SACRIFICE REQUIRED. PICK ONE.</p><div className="sacrifice-grid">{candidates.map((plushie) => <button key={plushie.id} className={`sacrifice-card ${event.yourVote === plushie.id ? 'sacrifice-card--mine' : ''}`} onClick={() => conn.voteSacrifice(plushie.id)}><span className="sacrifice-card__emoji">{plushie.emoji}</span><strong>{plushie.name}</strong><span>{plushie.rarity.toUpperCase()} · {plushie.value}★</span><span>{abilityLabel(plushie)}</span><span className="vote-btn__count">{event.voteTally[plushie.id] ?? 0} votes</span><span>SACRIFICE</span></button>)}</div></div>;
  }
  const chooser = event.chooserId === view.youId;
  const hostage = event.kind === 'the_deal' ? view.unbanked.find((p) => p.id === event.hostagePlushieId) : undefined;
  return <div className="panel center-panel cruelty-panel">
    <Timer remainingMs={view.deadlineRemainingMs} />
    <h2 className="panel__title">{event.kind === 'the_deal' ? 'THE DEAL' : `BAD NEWS, ${nameOf(event.chooserId)}.`}</h2>
    {hostage && <PlushieShowcase plushie={hostage} mood="😨" animation="idle" machine={view.machine} />}
    <p className="hint center">{chooser ? 'Choose your pain.' : `Waiting for ${nameOf(event.chooserId)} to choose...`}</p>
    {event.kind === 'the_deal' ? <div className="actions__row"><button className="btn btn--bank" disabled={!chooser} onClick={() => conn.chooseCruelty('sacrifice')}>SACRIFICE IT</button><button className="btn btn--risk" disabled={!chooser} onClick={() => conn.chooseCruelty('harder')}>MAKE IT HARDER (+2)</button></div> : <div className="actions__row"><button className="btn btn--risk" disabled={!chooser} onClick={() => conn.chooseCruelty('nuts')}>NUTS: I am MPC (+1)</button><button className="btn btn--bank" disabled={!chooser} onClick={() => conn.chooseCruelty('teeth')}>TEETH: no support</button></div>}
  </div>;
}

function PlushieNaming({ conn, view, nameOf }: { conn: Connection; view: GameView; nameOf: (id: string | null) => string }) {
  const plushie = view.outcome?.plushie ?? view.currentPlushie;
  const [name, setName] = useState(plushie?.name ?? '');
  const yours = view.namingPlayerId === view.youId;
  if (!plushie) return null;
  return <div className="panel center-panel naming-panel"><Timer remainingMs={view.deadlineRemainingMs} /><p className={`rescue-rarity rescue-rarity--${plushie.rarity}`}>{plushie.rarity.toUpperCase()} RESCUE · +{plushie.value}★</p><PlushieShowcase plushie={plushie} mood="🥳" animation="dance" machine={view.machine} /><p className="ability-line">{abilityLabel(plushie)}</p>{yours ? <form className="naming-form" onSubmit={(event) => { event.preventDefault(); conn.namePlushie(name); }}><label htmlFor="plushie-name">Name your rescue</label><input id="plushie-name" value={name} maxLength={24} onChange={(event) => setName(event.target.value)} /><button className="btn btn--primary" disabled={!name.trim()} type="submit">KEEP / SAVE NAME</button></form> : <p className="hint center">{nameOf(view.namingPlayerId)} is naming the rescue…</p>}</div>;
}

function LastChance({ conn, view, nameOf }: { conn: Connection; view: GameView; nameOf: (id: string | null) => string }) {
  const lastChance = view.lastChance;
  const attemptId = lastChance?.attemptId;
  const shownAtRef = useRef<number | null>(null);
  useEffect(() => {
    shownAtRef.current = null;
    if (attemptId === undefined) return;
    let second: number | null = null;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { shownAtRef.current = performance.now(); }); });
    return () => { cancelAnimationFrame(first); if (second !== null) cancelAnimationFrame(second); };
  }, [attemptId]);
  if (!lastChance || !view.currentPlushie) return null;
  const yours = lastChance.playerId === view.youId;
  return <div className="panel center-panel last-chance"><Timer remainingMs={view.deadlineRemainingMs} /><h2 className="panel__title">⚠️ LAST CHANCE ⚠️</h2><p className="big-reveal bad">{view.currentPlushie.name} ISN'T GONE YET.</p><PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} />{yours ? <button className="btn btn--doom last-chance__button" onClick={() => { if (shownAtRef.current !== null) conn.hitLastChance(lastChance.attemptId, Math.round(performance.now() - shownAtRef.current)); }}>SAVE {view.currentPlushie.name.toUpperCase()}!</button> : <p className="hint center">{nameOf(lastChance.playerId)} — HIT IT!</p>}</div>;
}

function abilityLabel(plushie: Plushie): string {
  const ability = ABILITIES[plushie.ability];
  const power = ['', 'I', 'II', 'III'][plushie.abilityPower] ?? `Power ${plushie.abilityPower}`;
  return `${ability.emoji} ${ability.label} ${power}`;
}

function Timer({ remainingMs }: { remainingMs: number | null }) {
  const seconds = useCountdown(remainingMs);
  const lastTicked = useRef<number | null>(null);
  useEffect(() => {
    if (seconds !== null && seconds >= 1 && seconds <= 5 && lastTicked.current !== seconds) {
      lastTicked.current = seconds;
      playSound('tick');
    } else if (seconds === null || seconds > 5) {
      lastTicked.current = null; // fresh countdown next time it re-enters the urgent zone
    }
  }, [seconds]);

  // A null deadline here means a minigame is deliberately hiding it (e.g. the
  // Reaction Test's secret signal window) — every phase that renders a Timer
  // otherwise always has one. Reserve the same box rather than unmounting it,
  // or everything below jumps up when the countdown disappears.
  if (seconds === null) return <div className="timer timer--hidden">&nbsp;</div>;
  return <div className={`timer ${seconds <= 5 ? 'timer--urgent' : ''}`}>{seconds}s</div>;
}

function Lobby({ conn, view }: { conn: Connection; view: GameView }) {
  const isHost = view.hostId === view.youId;
  const count = view.players.length;
  const enough = count >= MIN_PLAYERS;

  return (
    <div className="panel">
      <div className="room-code">
        <span className="room-code__label">Share code</span>
        <span className="room-code__value">{view.code}</span>
        <button className="btn btn--ghost" onClick={() => navigator.clipboard?.writeText(view.code).catch(() => {})}>
          Copy
        </button>
      </div>

      <ul className="roster">
        {view.players.map((p) => (
          <li key={p.playerId} className="roster__row">
            <span className={`dot ${p.connected ? 'dot--on' : 'dot--off'}`} />
            <span className="roster__name">{p.nickname}</span>
            {p.playerId === view.hostId && <span className="roster__tag">host</span>}
            {p.playerId === view.youId && <span className="roster__you">you</span>}
          </li>
        ))}
      </ul>

      {isHost ? (
        <button
          className="btn btn--primary"
          disabled={!enough}
          onClick={() => {
            playSound('click');
            conn.startGame();
          }}
        >
          {enough ? 'Start the run' : `Need ${MIN_PLAYERS}+ players`}
        </button>
      ) : (
        <p className="hint center">Waiting for the host to start…</p>
      )}
      <p className="hint center">
        {count}/{MAX_PLAYERS} players
      </p>
    </div>
  );
}

function MpcVoting({
  conn,
  view,
  nameOf,
}: {
  conn: Connection;
  view: GameView;
  nameOf: (id: string | null) => string;
}) {
  return (
    <div className="panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <h2 className="panel__title">Who do we trust?</h2>
      <PlushieShowcase plushie={view.currentPlushie} mood="😟" animation="idle" machine={view.machine} />
      <p className="hint center">Vote for the MPC — the challenge is revealed after.</p>
      <div className="vote-grid">
        {view.eligibleIds.map((id) => {
          const votes = view.mpcVoteTally[id] ?? 0;
          const mine = view.yourMpcVote === id;
          return (
            <button
              key={id}
              className={`vote-btn ${mine ? 'vote-btn--mine' : ''}`}
              onClick={() => {
                playSound('click');
                conn.voteMpc(id);
              }}
            >
              <span className="vote-btn__name">{nameOf(id)}</span>
              <span className="vote-btn__count">{votes}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MpcSelected({ view, nameOf }: { view: GameView; nameOf: (id: string | null) => string }) {
  const you = view.mpcId === view.youId;
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <div className="big-reveal">{you ? 'You are the MPC!' : `${nameOf(view.mpcId)} is the MPC`}</div>
      <p className="hint">{you ? 'The whole group is watching you.' : 'May the odds be ever in their favour.'}</p>
      <PlushieShowcase plushie={view.currentPlushie} mood="😟" animation="idle" machine={view.machine} />
    </div>
  );
}

function ChallengeIntro({ view, nameOf }: { view: GameView; nameOf: (id: string | null) => string }) {
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <p className="hint">Challenge incoming…</p>
      <div className="big-reveal">{view.minigame?.title ?? 'A challenge'}</div>
      <p className="hint">
        {view.mpcId === view.youId ? 'Get ready — you are up.' : `${nameOf(view.mpcId)} is up. Get ready to help.`}
      </p>
      <PlushieShowcase plushie={view.currentPlushie} mood="😨" animation="idle" machine={view.machine} />
    </div>
  );
}

/** The pressure fuse: a rope burning down toward the bomb, ashes on the left,
 *  spark at the burn point. Purely presentational — the fraction is recomputed
 *  from the server-issued deadline every frame-ish tick, so it survives
 *  reconnects and never drifts from the authoritative clock. */
function Fuse({ fuse }: { fuse: { remainingMs: number; totalMs: number } | null }) {
  const fuseRemainingMs = fuse?.remainingMs;
  const fuseTotalMs = fuse?.totalMs;
  const deadlineRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    deadlineRef.current = fuseRemainingMs === undefined ? null : performance.now() + fuseRemainingMs;
    setNow(performance.now());
    if (fuseRemainingMs === undefined) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [fuseRemainingMs, fuseTotalMs]);

  if (fuseRemainingMs === undefined || fuseTotalMs === undefined || deadlineRef.current === null) return null;
  const remainingMs = Math.max(0, deadlineRef.current - now);
  const remaining = Math.max(0, Math.min(1, remainingMs / fuseTotalMs));
  const urgent = remainingMs <= 5000;
  return (
    <div className={`fuse ${urgent ? 'fuse--urgent' : ''}`} role="timer" aria-label="Time remaining">
      <div className="fuse__rope" style={{ width: `${remaining * 100}%` }}>
        <span className="fuse__spark">✴️</span>
      </div>
      <span className="fuse__bomb">💣</span>
    </div>
  );
}

function Challenge({
  conn,
  view,
  nameOf,
}: {
  conn: Connection;
  view: GameView;
  nameOf: (id: string | null) => string;
}) {
  const MinigameUI = view.minigame ? getMinigameUI(view.minigame.id) : undefined;
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <Fuse fuse={view.fuse} />
      {MinigameUI ? (
        <MinigameUI conn={conn} view={view} nameOf={nameOf} />
      ) : (
        <PlushieShowcase plushie={view.currentPlushie} mood="😨" animation="idle" machine={view.machine} />
      )}
    </div>
  );
}

function Resolution({
  conn,
  view,
  nameOf,
}: {
  conn: Connection;
  view: GameView;
  nameOf: (id: string | null) => string;
}) {
  const outcome = view.outcome;
  useEffect(() => {
    if (outcome) playSound(outcome.success ? 'success' : 'failure');
    // Mount-only: this component remounts fresh every time the phase re-enters
    // round_resolution (a different phase renders in between each round), so
    // an empty dep array plays the cue exactly once per round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!outcome) return null;
  const MinigameUI = view.minigame ? getMinigameUI(view.minigame.id) : undefined;
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <div className={`big-reveal ${outcome.success ? 'good' : 'bad'}`}>
        {outcome.success ? 'SAVED!' : 'DOOMED'}
      </div>
      <PlushieShowcase
        plushie={outcome.plushie}
        mood={outcome.success ? '😄' : MACHINES[view.machine].failEmoji}
        animation={outcome.success ? 'dance' : 'gesture-negative'}
        machine={view.machine}
      />
      <p className="hint center">{outcome.headline}</p>
      {outcome.savedBy && <p className="hint center">Rescued by {nameOf(outcome.savedBy)} 🦸</p>}
      {MinigameUI && <MinigameUI conn={conn} view={view} nameOf={nameOf} />}
    </div>
  );
}

function RiskVoting({ conn, view }: { conn: Connection; view: GameView }) {
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <h2 className="panel__title">Bank or Risk?</h2>
      <p className="typing-progress">Current pot: {totalValue(view.unbanked)}★</p>
      <Shelf label="Currently at risk" plushies={view.unbanked} danger empty="—" />
      <ActiveEffects effects={view.activeEffects} />
      <div className="actions__row">
        <button
          className={`btn btn--bank ${view.yourRiskVote === 'bank' ? 'btn--chosen' : ''}`}
          onClick={() => {
            playSound('click');
            conn.voteRisk('bank');
          }}
        >
          BANK ({view.riskTally.bank})
        </button>
        <button
          className={`btn btn--risk ${view.yourRiskVote === 'risk' ? 'btn--chosen' : ''}`}
          onClick={() => {
            playSound('click');
            conn.voteRisk('risk');
          }}
        >
          RISK ({view.riskTally.risk})
        </button>
      </div>
      <p className="hint center">Bank secures them forever but ends their active abilities. Risk keeps their abilities active — and keeps them in danger.</p>
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function ActiveEffects({ effects }: { effects: GameView['activeEffects'] }) {
  if (!effects.brave && !effects.guardian && !effects.greedy && !effects.lucky) return null;

  return (
    <div className="active-effects">
      <h3 className="active-effects__title">ACTIVE WHILE YOU RISK</h3>
      {effects.brave && <div className="active-effect"><strong>❤️‍🔥 Brave Heart</strong><span>Next challenge difficulty: {effects.brave.baseDifficulty} → {effects.brave.effectiveDifficulty}</span></div>}
      {effects.guardian && <div className="active-effect"><strong>🛡️ Guardian</strong><span>Cruelty chance: {percent(effects.guardian.baseChance)} → {percent(effects.guardian.effectiveChance)}</span></div>}
      {effects.greedy && <div className="active-effect"><strong>🤑 Greedy Bastard</strong><span>Next rescue: +{effects.greedy.bonus}★</span></div>}
      {effects.lucky && <div className="active-effect"><strong>🍀 Lucky Charm</strong><span>Last Chance chance: {percent(effects.lucky.baseChance)} → {percent(effects.lucky.effectiveChance)}</span></div>}
    </div>
  );
}

function Stakes({ view }: { view: GameView }) {
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <h2 className="panel__title">Round {view.round} — here we go again</h2>
      <PlushieShowcase plushie={view.currentPlushie} mood="🙂" animation="idle" machine={view.machine} />
      <Shelf label="😰 Still at risk" plushies={view.unbanked} danger empty="—" />
      <p className="hint center">Everyone banked so far is riding on this run. Get ready.</p>
    </div>
  );
}

function RunOver({ view }: { view: GameView }) {
  const summary = view.runSummary;
  const banked = view.phase === 'run_complete';
  const total = summary ? totalValue(summary.plushies) : 0;
  return (
    <div className="panel center-panel">
      <Timer remainingMs={view.deadlineRemainingMs} />
      <div className={`big-reveal ${banked ? 'good' : 'bad'}`}>{banked ? 'Banked!' : 'Run over'}</div>
      {summary && summary.plushies.length > 0 ? <>
        <p className="run-summary__count">{banked ? `${summary.plushies.length} plushies secured` : `${summary.plushies.length} plushies lost`}</p>
        <div className={`run-summary__value ${banked ? 'good' : 'bad'}`}>{total}★ {banked ? 'BANKED' : 'GONE'}</div>
        <p className="hint center">{summary.rounds} round(s) played.</p>
      </> : <p className="hint center">Nothing was banked.</p>}
      {summary && summary.plushies.length > 0 && (
        <Shelf label={banked ? '🎉 Banked' : '💔 Lost'} plushies={summary.plushies} danger={!banked} big />
      )}
      <p className="hint center">A fresh run starts in a moment…</p>
    </div>
  );
}
