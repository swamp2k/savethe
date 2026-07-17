import { useState } from 'react';
import { useGameConnection, type Connection } from './useGameConnection';
import { MAX_NICKNAME, MIN_PLAYERS, MAX_PLAYERS } from '../shared/constants';

export function App() {
  const conn = useGameConnection();
  const inRoom = conn.state !== null && (conn.status === 'connected' || conn.status === 'reconnecting');

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          Save The<span className="app__title-dots">...</span>
        </h1>
        <p className="app__tagline">Cute things in ridiculous danger.</p>
      </header>
      {inRoom ? <RoomView conn={conn} /> : <Lobby conn={conn} />}
    </div>
  );
}

function Lobby({ conn }: { conn: Connection }) {
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const busy = conn.status === 'connecting' || conn.status === 'reconnecting';
  const trimmed = nickname.trim();
  const canCreate = trimmed.length > 0 && !busy;
  const canJoin = canCreate && code.trim().length > 0;

  return (
    <div className="panel">
      <label className="field">
        <span className="field__label">Your nickname</span>
        <input
          className="field__input"
          value={nickname}
          maxLength={MAX_NICKNAME}
          placeholder="e.g. Martin"
          onChange={(e) => setNickname(e.target.value)}
          autoFocus
        />
      </label>

      <button className="btn btn--primary" disabled={!canCreate} onClick={() => conn.createRoom(trimmed)}>
        Create a room
      </button>

      <div className="divider">or join one</div>

      <label className="field">
        <span className="field__label">Room code</span>
        <input
          className="field__input field__input--code"
          value={code}
          placeholder="SAVE-K7Q2"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canJoin) conn.joinRoom(code, trimmed);
          }}
        />
      </label>
      <button className="btn" disabled={!canJoin} onClick={() => conn.joinRoom(code, trimmed)}>
        Join room
      </button>

      {busy && <p className="hint">Connecting…</p>}
      {conn.error && <p className="error">{conn.error}</p>}
    </div>
  );
}

function RoomView({ conn }: { conn: Connection }) {
  const state = conn.state!;
  const count = state.players.length;
  const enough = count >= MIN_PLAYERS;

  return (
    <div className="panel">
      <div className="room-code">
        <span className="room-code__label">Room code</span>
        <span className="room-code__value">{state.code}</span>
        <button
          className="btn btn--ghost"
          onClick={() => navigator.clipboard?.writeText(state.code).catch(() => {})}
        >
          Copy
        </button>
      </div>

      {conn.status === 'reconnecting' && <p className="hint">Reconnecting…</p>}

      <ul className="roster">
        {state.players.map((p) => (
          <li key={p.playerId} className="roster__row">
            <span className={`dot ${p.connected ? 'dot--on' : 'dot--off'}`} />
            <span className="roster__name">{p.nickname}</span>
            {conn.self?.playerId === p.playerId && <span className="roster__you">you</span>}
          </li>
        ))}
      </ul>

      <p className="hint">
        {count}/{MAX_PLAYERS} players
        {enough ? ' — enough to play once the round system lands.' : ` — waiting for at least ${MIN_PLAYERS}.`}
      </p>

      {conn.error && <p className="error">{conn.error}</p>}

      <button className="btn btn--ghost" onClick={conn.leave}>
        Leave room
      </button>
    </div>
  );
}
