import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/shared/protocol';

/**
 * Durable Object integration tests. Each test connects real WebSockets through
 * the Worker (SELF) into the GameRoom DO. Storage is isolated per test by the
 * Workers pool, so a fixed room code is safe.
 */

const ROOM = 'SAVE-TEST1';

interface Socket {
  ws: WebSocket;
  next: () => Promise<ServerMessage>;
  waitFor: (type: ServerMessage['type']) => Promise<ServerMessage>;
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
  const waitFor = async (type: ServerMessage['type']): Promise<ServerMessage> => {
    for (;;) {
      const msg = await next();
      if (msg.type === type) return msg;
    }
  };

  return { ws, next, waitFor, closed, send: (m) => ws.send(JSON.stringify(m)) };
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
      expect(joined.state.code).toBe(ROOM);
      expect(joined.state.players).toHaveLength(1);
      expect(joined.state.players[0].nickname).toBe('Martin');
      expect(joined.state.players[0].connected).toBe(true);
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
      expect(guestJoined.state.players).toHaveLength(2);
    }

    // The host should receive a roster update reflecting the new player. Drain
    // past the host's own single-player join broadcast.
    let hostState = await host.waitFor('room.state');
    while (hostState.type === 'room.state' && hostState.state.players.length < 2) {
      hostState = await host.waitFor('room.state');
    }
    if (hostState.type === 'room.state') {
      expect(hostState.state.players.map((p) => p.nickname).sort()).toEqual(['Balder', 'Martin']);
      expect(hostState.state.players.every((p) => p.connected)).toBe(true);
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
      expect(rejoined.state.players).toHaveLength(1);
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
    await createAndJoin('Martin', 'SAVE-AAAA');

    const other = await connect('SAVE-BBBB');
    other.send({ type: 'room.join', mode: 'join', nickname: 'Nobody' });
    const err = await other.waitFor('error');
    // SAVE-BBBB was never created, so joining it must fail.
    if (err.type === 'error') expect(err.code).toBe('no_such_room');
  });
});
