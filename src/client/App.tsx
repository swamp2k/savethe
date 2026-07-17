import { useState } from 'react';
import { useGameConnection, type Connection } from './useGameConnection';
import { Game } from './Game';
import { MAX_NICKNAME } from '../shared/constants';

export function App() {
  const conn = useGameConnection();
  const inRoom = conn.view !== null && conn.status !== 'idle' && conn.status !== 'error';

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          Save The<span className="app__title-dots">…</span>
        </h1>
        {!inRoom && <p className="app__tagline">Cute things in ridiculous danger.</p>}
      </header>
      {inRoom && conn.view ? <Game conn={conn} view={conn.view} /> : <Entry conn={conn} />}
    </div>
  );
}

function Entry({ conn }: { conn: Connection }) {
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

      {busy && <p className="hint center">Connecting…</p>}
      {conn.error && <p className="error center">{conn.error}</p>}
    </div>
  );
}
