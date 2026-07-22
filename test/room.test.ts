import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/shared/protocol';
import type { GameView } from '../src/shared/game';
import { MAX_MESSAGE_BYTES, RATE_LIMIT_MAX_MESSAGES } from '../src/shared/constants';
import { GameRoom } from '../src/server/GameRoom';

/**
 * Durable Object integration tests. Each test connects real WebSockets through
 * the Worker (SELF) into the GameRoom DO. Storage is isolated per test by the
 * Workers pool, so a fixed room code is safe.
 */

const ROOM = 'TS2';

interface Socket {
  ws: WebSocket;
  next: () => Promise<ServerMessage>;
  /** Non-blocking peek: whatever's already queued, or null. Useful for
   *  proving a *negative* (nothing more arrived) without hanging a test on
   *  a message that, if the code is correct, will never come. */
  tryNext: () => ServerMessage | null;
  waitFor: (type: ServerMessage['type']) => Promise<ServerMessage>;
  waitForPhase: (phase: GameView['phase']) => Promise<GameView>;
  closed: Promise<{ code: number; reason: string }>;
  send: (msg: unknown) => void;
}

async function connect(code = ROOM): Promise<Socket> {
  const resp = await SELF.fetch(`https://room.test/ws/${code}`, {
    headers: { Upgrade: 'websocket' },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`expected a WebSocket, got status ${resp.status}`);
  ws.accept();

  const queue: ServerMessage[] = [];
  const waiters: Array<(m: ServerMessage) => void> = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });

  let resolveClosed: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
  ws.addEventListener('close', (event) => resolveClosed({ code: event.code, reason: event.reason }));

  const next = (): Promise<ServerMessage> => {
    const msg = queue.shift();
    if (msg) return Promise.resolve(msg);
    return new Promise((resolve) => waiters.push(resolve));
  };
  const tryNext = (): ServerMessage | null => queue.shift() ?? null;
  const waitFor = async (type: ServerMessage['type']): Promise<ServerMessage> => {
    for (;;) {
      const msg = await next();
      if (msg.type === type) return msg;
    }
  };
  const waitForPhase = async (phase: GameView['phase']): Promise<GameView> => {
    for (;;) {
      const msg = await next();
      if ((msg.type === 'game.state' || msg.type === 'room.joined') && msg.view.phase === phase) {
        return msg.view;
      }
    }
  };

  return { ws, next, tryNext, waitFor, waitForPhase, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

async function createAndJoin(nickname: string, code = ROOM): Promise<{ socket: Socket; token: string; playerId: string }> {
  const socket = await connect(code);
  socket.send({ type: 'room.join', mode: 'create', nickname });
  const joined = await socket.waitFor('room.joined');
  if (joined.type !== 'room.joined') throw new Error('unreachable');
  return { socket, token: joined.token, playerId: joined.self.playerId };
}

describe('GameRoom lobby', () => {
  it('creates a room and seats the creator', async () => {
    const socket = await connect();
    socket.send({ type: 'room.join', mode: 'create', nickname: 'Martin' });

    const joined = await socket.waitFor('room.joined');
    expect(joined.type).toBe('room.joined');
    if (joined.type === 'room.joined') {
      expect(joined.view.code).toBe(ROOM);
      expect(joined.view.phase).toBe('lobby');
      expect(joined.view.players).toHaveLength(1);
      expect(joined.view.players[0].nickname).toBe('Martin');
      expect(joined.view.players[0].connected).toBe(true);
      expect(joined.token).toBeTruthy();
    }
  });

  it('rejects joining a room that does not exist', async () => {
    const socket = await connect();
    socket.send({ type: 'room.join', mode: 'join', nickname: 'Lonely' });

    const err = await socket.waitFor('error');
    if (err.type === 'error') {
      expect(err.code).toBe('no_such_room');
      expect(err.fatal).toBe(true);
    }
    const close = await socket.closed;
    expect(close.code).toBe(4001);
  });

  it('lets a second player join and both see the roster', async () => {
    const { socket: host } = await createAndJoin('Martin');

    const guest = await connect();
    guest.send({ type: 'room.join', mode: 'join', nickname: 'Balder' });

    const guestJoined = await guest.waitFor('room.joined');
    if (guestJoined.type === 'room.joined') {
      expect(guestJoined.view.players).toHaveLength(2);
    }

    // The host should receive a roster update reflecting the new player. Drain
    // past the host's own single-player join broadcast.
    let hostState = await host.waitFor('game.state');
    while (hostState.type === 'game.state' && hostState.view.players.length < 2) {
      hostState = await host.waitFor('game.state');
    }
    if (hostState.type === 'game.state') {
      expect(hostState.view.players.map((p) => p.nickname).sort()).toEqual(['Balder', 'Martin']);
      expect(hostState.view.players.every((p) => p.connected)).toBe(true);
    }
  });

  it('restores identity on reconnect with the saved token', async () => {
    const { socket, token, playerId } = await createAndJoin('Martin');
    socket.ws.close();

    const again = await connect();
    again.send({ type: 'room.reconnect', token });
    const rejoined = await again.waitFor('room.joined');
    if (rejoined.type === 'room.joined') {
      expect(rejoined.self.playerId).toBe(playerId);
      expect(rejoined.self.nickname).toBe('Martin');
      expect(rejoined.view.players).toHaveLength(1);
    }
  });

  it('closes the old socket when a session reconnects (newest wins)', async () => {
    const { socket: first, token } = await createAndJoin('Martin');

    const second = await connect();
    second.send({ type: 'room.reconnect', token });
    await second.waitFor('room.joined');

    const close = await first.closed;
    expect(close.code).toBe(4000);
  });

  it('rejects reconnecting with an unknown token', async () => {
    await createAndJoin('Martin');
    const stranger = await connect();
    stranger.send({ type: 'room.reconnect', token: 'not-a-real-token' });

    const err = await stranger.waitFor('error');
    if (err.type === 'error') expect(err.code).toBe('unknown_session');
  });

  it('rejects a malformed message without closing the socket', async () => {
    const { socket } = await createAndJoin('Martin');
    socket.ws.send('{ this is not json');

    const err = await socket.waitFor('error');
    if (err.type === 'error') {
      expect(err.code).toBe('bad_message');
      expect(err.fatal).toBe(false);
    }

    // Socket still works: a ping should still get a pong.
    socket.send({ type: 'ping' });
    const pong = await socket.waitFor('pong');
    expect(pong.type).toBe('pong');
  });

  it('rejects an oversized message without closing the socket', async () => {
    const { socket } = await createAndJoin('Martin');
    const oversized = JSON.stringify({ type: 'ping', pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    socket.ws.send(oversized);

    const err = await socket.waitFor('error');
    if (err.type === 'error') {
      expect(err.code).toBe('bad_message');
      expect(err.fatal).toBe(false);
    }

    socket.send({ type: 'ping' });
    const pong = await socket.waitFor('pong');
    expect(pong.type).toBe('pong');
  });

  it('rate-limits a per-connection message flood, dropping excess without flooding errors back', async () => {
    const { socket } = await createAndJoin('Flood');
    // The join handshake itself already counted one message in this window,
    // so RATE_LIMIT_MAX_MESSAGES - 1 pings are allowed before the limit trips.
    const burst = RATE_LIMIT_MAX_MESSAGES + 5;
    for (let i = 0; i < burst; i++) socket.send({ type: 'ping' });

    let pongs = 0;
    let errors = 0;
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
      const msg = await socket.next();
      if (msg.type === 'pong') pongs++;
      else if (msg.type === 'error') {
        errors++;
        expect(msg.fatal).toBe(false);
      }
    }
    expect(pongs).toBe(RATE_LIMIT_MAX_MESSAGES - 1);
    expect(errors).toBe(1);
  });

  it('refuses gameplay actions before joining', async () => {
    const socket = await connect();
    socket.send({ type: 'ping' });
    const err = await socket.waitFor('error');
    if (err.type === 'error') expect(err.code).toBe('not_joined');
  });

  it('enforces the maximum player count', async () => {
    await createAndJoin('P1');
    for (const name of ['P2', 'P3', 'P4', 'P5']) {
      const s = await connect();
      s.send({ type: 'room.join', mode: 'join', nickname: name });
      await s.waitFor('room.joined');
    }

    const overflow = await connect();
    overflow.send({ type: 'room.join', mode: 'join', nickname: 'P6' });
    const err = await overflow.waitFor('error');
    if (err.type === 'error') expect(err.code).toBe('room_full');
  });

  it('isolates rooms with different codes', async () => {
    await createAndJoin('Martin', 'AAB');

    const other = await connect('BBC');
    other.send({ type: 'room.join', mode: 'join', nickname: 'Nobody' });
    const err = await other.waitFor('error');
    // BBC was never created, so joining it must fail.
    if (err.type === 'error') expect(err.code).toBe('no_such_room');
  });
});

describe('GameRoom game flow', () => {
  async function twoPlayerRoom(code = ROOM): Promise<{ host: Socket; guest: Socket }> {
    const { socket: host } = await createAndJoin('Martin', code);
    const guest = await connect(code);
    guest.send({ type: 'room.join', mode: 'join', nickname: 'Balder' });
    await guest.waitFor('room.joined');
    return { host, guest };
  }

  it('starts a game and broadcasts the MPC selection to everyone', async () => {
    const { host, guest } = await twoPlayerRoom();
    host.send({ type: 'game.start' });

    const hostView = await host.waitForPhase('mpc_selected');
    const guestView = await guest.waitForPhase('mpc_selected');
    // 2-player: the vote is skipped and the lowest seat (the host) is MPC.
    expect(hostView.mpcId).toBe(hostView.youId);
    expect(guestView.mpcId).toBe(hostView.youId);
    expect(guestView.currentPlushie).not.toBeNull();
  });

  it('ignores game.start from a non-host', async () => {
    const { guest } = await twoPlayerRoom('NHT');
    guest.send({ type: 'game.start' });
    // The guest is not the host, so nothing should happen. A ping still pongs
    // and the phase stays in the lobby.
    guest.send({ type: 'ping' });
    await guest.waitFor('pong');
    const id = env.GAME_ROOM.idFromName('NHT');
    await runInDurableObject(env.GAME_ROOM.get(id), async (_instance, state) => {
      const raw = await state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'game'`).toArray();
      const game = raw.length ? JSON.parse(raw[0].value as string) : { phase: 'lobby' };
      expect(game.phase).toBe('lobby');
    });
  });

  it('schedules an alarm once a timed phase begins', async () => {
    const { host } = await twoPlayerRoom('ARM');
    host.send({ type: 'game.start' });
    await host.waitForPhase('mpc_selected');

    const id = env.GAME_ROOM.idFromName('ARM');
    await runInDurableObject(env.GAME_ROOM.get(id), async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it('resumes correctly after the DO instance is evicted and rebuilt mid-game', async () => {
    // GameRoom keeps no authoritative state in instance fields — every
    // handler reloads from storage. Simulate "the runtime tore down the old
    // JS instance and constructed a fresh one before firing the alarm" by
    // building a brand-new GameRoom bound to the same persisted
    // DurableObjectState, and firing its alarm directly.
    const { host } = await twoPlayerRoom('EVT');
    host.send({ type: 'game.start' });
    await host.waitForPhase('mpc_selected'); // schedules an alarm

    const id = env.GAME_ROOM.idFromName('EVT');
    await runInDurableObject(env.GAME_ROOM.get(id), async (_instance, state) => {
      const fresh = new GameRoom(state, env);
      await fresh.alarm();
    });

    // The alarm should have advanced the combined MPC/challenge reveal
    // directly into active play, and
    // the still-connected socket (bound to the DO's state, not the evicted
    // JS instance) should have received the broadcast.
    const view = await host.waitForPhase('challenge_active');
    expect(view.phase).toBe('challenge_active');
  });

  it('rejects a minigame action outside an active challenge', async () => {
    const { host } = await twoPlayerRoom('NCH');
    host.send({ type: 'minigame.action', payload: { kind: 'save' } });
    const err = await host.waitFor('error');
    if (err.type === 'error') expect(err.code).toBe('bad_action');
  });

  it('restores the live game view on reconnect after the game has started', async () => {
    const code = 'RCN';
    const first = await connect(code);
    first.send({ type: 'room.join', mode: 'create', nickname: 'Solo' });
    const joined = await first.waitFor('room.joined');
    const token = joined.type === 'room.joined' ? joined.token : '';

    const second = await connect(code);
    second.send({ type: 'room.join', mode: 'join', nickname: 'Duo' });
    await second.waitFor('room.joined');

    first.send({ type: 'game.start' });
    await first.waitForPhase('mpc_selected');

    // Reconnect the first player; the snapshot must not fall back to the lobby.
    first.ws.close();
    const again = await connect(code);
    again.send({ type: 'room.reconnect', token });
    const rejoined = await again.waitFor('room.joined');
    if (rejoined.type === 'room.joined') {
      expect(rejoined.view.phase).not.toBe('lobby');
      expect(rejoined.view.mpcId).not.toBeNull();
    }
  });
});

describe('spectator emotes', () => {
  async function twoPlayerRoomWithIds(
    code: string,
  ): Promise<{ host: Socket; guest: Socket; hostId: string; guestId: string }> {
    const { socket: host, playerId: hostId } = await createAndJoin('Martin', code);
    const guest = await connect(code);
    guest.send({ type: 'room.join', mode: 'join', nickname: 'Balder' });
    const guestJoined = await guest.waitFor('room.joined');
    const guestId = guestJoined.type === 'room.joined' ? guestJoined.self.playerId : '';
    // The guest joining broadcasts a roster update to the host; drain it so
    // callers doing precise message-order assertions start from a clean queue.
    let hostState = await host.waitFor('game.state');
    while (hostState.type === 'game.state' && hostState.view.players.length < 2) {
      hostState = await host.waitFor('game.state');
    }
    return { host, guest, hostId, guestId };
  }

  it('relays an emote to everyone (including the sender) once the run has started', async () => {
    const { host, guest, hostId } = await twoPlayerRoomWithIds('EMO');
    host.send({ type: 'game.start' });
    await host.waitForPhase('mpc_selected');
    await guest.waitForPhase('mpc_selected');

    host.send({ type: 'emote', kind: 'heart' });

    const hostEcho = await host.waitFor('emote');
    const guestEcho = await guest.waitFor('emote');
    if (hostEcho.type === 'emote') {
      expect(hostEcho.playerId).toBe(hostId);
      expect(hostEcho.kind).toBe('heart');
    }
    if (guestEcho.type === 'emote') {
      expect(guestEcho.playerId).toBe(hostId);
      expect(guestEcho.kind).toBe('heart');
    }
  });

  it('drops an emote sent before the run has started (nothing to react to yet)', async () => {
    const { host } = await twoPlayerRoomWithIds('EM2');
    host.send({ type: 'emote', kind: 'panic' });
    // Same connection, so message processing order is deterministic: if the
    // emote were (incorrectly) relayed, it would be queued ahead of the pong.
    host.send({ type: 'ping' });
    const msg = await host.next();
    expect(msg.type).toBe('pong');
  });

  it('throttles rapid emotes from the same player', async () => {
    const { host, guest } = await twoPlayerRoomWithIds('EM3');
    host.send({ type: 'game.start' });
    await host.waitForPhase('mpc_selected');
    await guest.waitForPhase('mpc_selected');

    host.send({ type: 'emote', kind: 'tomato' });
    host.send({ type: 'emote', kind: 'tomato' }); // within the cooldown window: dropped

    const first = await guest.waitFor('emote');
    expect(first.type).toBe('emote');

    // The host's two sends and the ping below are processed strictly in
    // order on one connection, so by the time the pong arrives, any second
    // emote relay would already be sitting in the guest's queue.
    host.send({ type: 'ping' });
    await host.waitFor('pong');
    expect(guest.tryNext()).toBeNull();
  });
});

describe('RoomRegistry', () => {
  it('reserves up to the cap and rejects beyond it', async () => {
    const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('unit-test-cap'));
    expect(await stub.tryReserve(2)).toBe(true);
    expect(await stub.tryReserve(2)).toBe(true);
    expect(await stub.tryReserve(2)).toBe(false); // over cap
  });

  it('release frees a slot for reuse', async () => {
    const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('unit-test-release'));
    await stub.tryReserve(1);
    expect(await stub.tryReserve(1)).toBe(false);
    await stub.release();
    expect(await stub.tryReserve(1)).toBe(true);
  });
});

describe('room cap (GameRoom <-> RoomRegistry wiring)', () => {
  it('reserves a registry slot when a room is created', async () => {
    const registryStub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('singleton'));
    const before = await runInDurableObject(registryStub, async (instance) => instance.count());

    await createAndJoin('CapCheck', 'CAP');

    const after = await runInDurableObject(registryStub, async (instance) => instance.count());
    expect(after).toBe(before + 1);
  });
});
