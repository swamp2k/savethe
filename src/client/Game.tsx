import type { Connection } from './useGameConnection';
import type { GameView, Plushie } from '../shared/game';
import { MIN_PLAYERS, MAX_PLAYERS } from '../shared/constants';
import { useCountdown } from './useCountdown';

interface DebugView {
  role: 'mpc' | 'support' | 'spectator';
  canAct: string[];
  mpcChoice: 'none' | 'save' | 'doom';
  rescuedBy: string | null;
  endsAt: number;
}

export function Game({ conn, view }: { conn: Connection; view: GameView }) {
  const nameOf = (id: string | null): string =>
    view.players.find((p) => p.playerId === id)?.nickname ?? '???';

  return (
    <div className="game">
      <Hud conn={conn} view={view} nameOf={nameOf} />
      <PhasePanel conn={conn} view={view} nameOf={nameOf} />
      {conn.status === 'reconnecting' && <p className="hint center">Reconnecting…</p>}
      {conn.error && <p className="error center">{conn.error}</p>}
    </div>
  );
}

function Hud({ conn, view, nameOf }: { conn: Connection; view: GameView; nameOf: (id: string | null) => string }) {
  const inRun = view.phase !== 'lobby';
  return (
    <div className="hud">
      <div className="hud__row">
        <span className="chip">Room {view.code}</span>
        {inRun && <span className="chip">Round {view.round}</span>}
        {view.mpcId && <span className="chip chip--mpc">MPC: {nameOf(view.mpcId)}</span>}
        <button className="btn btn--ghost btn--small hud__leave" onClick={conn.leave}>
          Leave
        </button>
      </div>
      <Shelf label="Trophy shelf" plushies={view.trophies} empty="Nothing banked yet" />
      {view.unbanked.length > 0 && <Shelf label="At risk" plushies={view.unbanked} danger />}
    </div>
  );
}

function Shelf({
  label,
  plushies,
  empty,
  danger,
}: {
  label: string;
  plushies: Plushie[];
  empty?: string;
  danger?: boolean;
}) {
  return (
    <div className={`shelf ${danger ? 'shelf--danger' : ''}`}>
      <span className="shelf__label">{label}</span>
      <div className="shelf__items">
        {plushies.length === 0 && empty && <span className="shelf__empty">{empty}</span>}
        {plushies.map((p) => (
          <span key={p.id} className="shelf__item" title={p.name}>
            {p.emoji}
          </span>
        ))}
      </div>
    </div>
  );
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
      return <Resolution view={view} nameOf={nameOf} />;
    case 'risk_voting':
      return <RiskVoting conn={conn} view={view} />;
    case 'run_complete':
    case 'run_failed':
      return <RunOver view={view} />;
  }
}

function Timer({ deadline }: { deadline: number | null }) {
  const seconds = useCountdown(deadline);
  if (seconds === null) return null;
  return <div className={`timer ${seconds <= 5 ? 'timer--urgent' : ''}`}>{seconds}s</div>;
}

function PlushieStage({ plushie, mood }: { plushie: Plushie | null; mood: string }) {
  if (!plushie) return null;
  return (
    <div className="stage">
      <div className="stage__press">🏭</div>
      <div className="stage__plushie">
        <span className="stage__emoji">{plushie.emoji}</span>
        <span className="stage__mood">{mood}</span>
      </div>
      <div className="stage__name">{plushie.name}</div>
    </div>
  );
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
        <button className="btn btn--primary" disabled={!enough} onClick={conn.startGame}>
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
      <Timer deadline={view.deadline} />
      <h2 className="panel__title">Who do we trust?</h2>
      <PlushieStage plushie={view.currentPlushie} mood="😟" />
      <p className="hint center">Vote for the MPC — the challenge is revealed after.</p>
      <div className="vote-grid">
        {view.eligibleIds.map((id) => {
          const votes = view.mpcVoteTally[id] ?? 0;
          const mine = view.yourMpcVote === id;
          return (
            <button
              key={id}
              className={`vote-btn ${mine ? 'vote-btn--mine' : ''}`}
              onClick={() => conn.voteMpc(id)}
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
      <Timer deadline={view.deadline} />
      <div className="big-reveal">{you ? 'You are the MPC!' : `${nameOf(view.mpcId)} is the MPC`}</div>
      <p className="hint">{you ? 'The whole group is watching you.' : 'May the odds be ever in their favour.'}</p>
      <PlushieStage plushie={view.currentPlushie} mood="😟" />
    </div>
  );
}

function ChallengeIntro({ view, nameOf }: { view: GameView; nameOf: (id: string | null) => string }) {
  return (
    <div className="panel center-panel">
      <Timer deadline={view.deadline} />
      <p className="hint">Challenge incoming…</p>
      <div className="big-reveal">{view.minigame?.title ?? 'A challenge'}</div>
      <p className="hint">
        {view.mpcId === view.youId ? 'Get ready — you are up.' : `${nameOf(view.mpcId)} is up. Get ready to help.`}
      </p>
      <PlushieStage plushie={view.currentPlushie} mood="😨" />
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
  const mg = view.minigame?.view as DebugView | undefined;
  const role = mg?.role ?? 'spectator';
  const canAct = mg?.canAct ?? [];

  return (
    <div className="panel center-panel">
      <Timer deadline={view.deadline} />
      <PlushieStage plushie={view.currentPlushie} mood="😨" />

      {role === 'mpc' && (
        <div className="actions">
          <p className="hint">You are the MPC. Save the plushie!</p>
          {canAct.includes('save') ? (
            <div className="actions__row">
              <button className="btn btn--save" onClick={() => conn.minigameAction({ kind: 'save' })}>
                SAVE
              </button>
              <button className="btn btn--doom" onClick={() => conn.minigameAction({ kind: 'doom' })}>
                DOOM
              </button>
            </div>
          ) : (
            <p className="hint">You pressed {mg?.mpcChoice}. Now everyone waits…</p>
          )}
        </div>
      )}

      {role === 'support' && (
        <div className="actions">
          <p className="hint">Support — you can rescue if the MPC fumbles.</p>
          {canAct.includes('rescue') ? (
            <button className="btn btn--save" onClick={() => conn.minigameAction({ kind: 'rescue' })}>
              RESCUE!
            </button>
          ) : (
            <p className="hint">Rescue used{mg?.rescuedBy ? ` by ${nameOf(mg.rescuedBy)}` : ''}.</p>
          )}
        </div>
      )}

      {role === 'spectator' && <p className="hint">Watching {nameOf(view.mpcId)} sweat…</p>}
    </div>
  );
}

function Resolution({ view, nameOf }: { view: GameView; nameOf: (id: string | null) => string }) {
  const outcome = view.outcome;
  if (!outcome) return null;
  return (
    <div className="panel center-panel">
      <Timer deadline={view.deadline} />
      <div className={`big-reveal ${outcome.success ? 'good' : 'bad'}`}>
        {outcome.success ? 'SAVED!' : 'DOOMED'}
      </div>
      <PlushieStage plushie={outcome.plushie} mood={outcome.success ? '😄' : '💥'} />
      <p className="hint center">{outcome.headline}</p>
      {outcome.savedBy && <p className="hint center">Rescued by {nameOf(outcome.savedBy)} 🦸</p>}
    </div>
  );
}

function RiskVoting({ conn, view }: { conn: Connection; view: GameView }) {
  return (
    <div className="panel center-panel">
      <Timer deadline={view.deadline} />
      <h2 className="panel__title">Bank or Risk?</h2>
      <Shelf label="Currently at risk" plushies={view.unbanked} danger empty="—" />
      <div className="actions__row">
        <button
          className={`btn btn--bank ${view.yourRiskVote === 'bank' ? 'btn--chosen' : ''}`}
          onClick={() => conn.voteRisk('bank')}
        >
          BANK ({view.riskTally.bank})
        </button>
        <button
          className={`btn btn--risk ${view.yourRiskVote === 'risk' ? 'btn--chosen' : ''}`}
          onClick={() => conn.voteRisk('risk')}
        >
          RISK ({view.riskTally.risk})
        </button>
      </div>
      <p className="hint center">Bank secures them forever. Risk keeps them exposed for a harder round.</p>
    </div>
  );
}

function RunOver({ view }: { view: GameView }) {
  const summary = view.runSummary;
  const banked = view.phase === 'run_complete';
  return (
    <div className="panel center-panel">
      <Timer deadline={view.deadline} />
      <div className={`big-reveal ${banked ? 'good' : 'bad'}`}>{banked ? 'Banked!' : 'Run over'}</div>
      <p className="hint center">
        {summary
          ? banked
            ? `Secured ${summary.plushies.length} plushie(s) over ${summary.rounds} round(s).`
            : `Lost ${summary.plushies.length} plushie(s) after ${summary.rounds} round(s).`
          : ''}
      </p>
      {summary && summary.plushies.length > 0 && (
        <Shelf label={banked ? 'Banked' : 'Lost'} plushies={summary.plushies} danger={!banked} />
      )}
      <p className="hint center">A fresh run starts in a moment…</p>
    </div>
  );
}
