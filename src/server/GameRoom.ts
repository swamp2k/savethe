import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import {
  decodeClientMessage,
  encode,
  type ServerMessage,
  type RoomState,
  type PlayerView,
  type ErrorCode,
} from '../shared/protocol';
import { GRACE_MS, MAX_PLAYERS } from '../shared/constants';

interface PlayerRow {
  playerId: string;
  token: string;
  nickname: string;
  joinedAt: number;
  lastSeen: number;
  seat: number;
}

/** Persisted per-socket. `code` is stored at accept time so a create handshake
 *  still knows its room after a hibernation; `playerId` is added once the socket
 *  is bound to a player (and is thereafter the sole source of identity). */
interface Attachment {
  code: string;
  playerId?: string;
}

const SUPERSEDED = 4000;
const FATAL = 4001;

/**
 * One GameRoom Durable Object per room code. Owns the roster and reconnect
 * identity for its room. SQLite-backed and hibernation-safe: nothing lives in
 * instance memory across requests — connected players are always recomputed
 * from `ctx.getWebSockets()`, and every deadline is a Durable Object alarm.
 */
export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.exec(`CREATE TABLE IF NOT EXISTS players (
        playerId TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        joinedAt INTEGER NOT NULL,
        lastSeen INTEGER NOT NULL,
        seat INTEGER NOT NULL
      )`);
    });
  }

  // --- HTTP: WebSocket upgrade ------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const code = decodeURIComponent(url.pathname.replace(/^\/ws\//, '')).toUpperCase();

    const { 0: client, 1: server } = new WebSocketPair();
    // Bind the room code to the socket before the first message so a `create`
    // handshake survives a hibernation between accept and that message.
    server.serializeAttachment({ code } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernatable WebSocket handlers ---------------------------------------

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const decoded = decodeClientMessage(raw);
    if (!decoded.ok) {
      this.send(ws, { type: 'error', code: 'bad_message', message: 'Malformed message', fatal: false });
      return;
    }
    const msg = decoded.value;
    const att = this.attachment(ws);

    if (att?.playerId) {
      // Already bound to a player: only gameplay messages are valid here.
      switch (msg.type) {
        case 'ping':
          this.send(ws, { type: 'pong' });
          return;
        case 'room.join':
        case 'room.reconnect':
          this.send(ws, { type: 'error', code: 'already_joined', message: 'Already in this room', fatal: false });
          return;
      }
    }

    // Handshake phase.
    switch (msg.type) {
      case 'room.join':
        this.handleJoin(ws, att, msg.mode, msg.nickname);
        return;
      case 'room.reconnect':
        this.handleReconnect(ws, att, msg.token);
        return;
      case 'ping':
        this.send(ws, { type: 'error', code: 'not_joined', message: 'Join the room first', fatal: false });
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.attachment(ws);
    if (att?.playerId) {
      this.exec(`UPDATE players SET lastSeen = ? WHERE playerId = ?`, Date.now(), att.playerId);
      this.broadcastState(ws);
      await this.ensureAlarm();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const connected = this.connectedIds();
    let changed = false;
    for (const p of this.players()) {
      if (!connected.has(p.playerId) && now - p.lastSeen >= GRACE_MS) {
        this.exec(`DELETE FROM players WHERE playerId = ?`, p.playerId);
        changed = true;
      }
    }

    const remaining = this.players();
    if (remaining.length === 0) {
      // Room is empty and past grace: reclaim it entirely.
      await this.ctx.storage.deleteAll();
      return;
    }
    if (changed) this.broadcastState();

    const live = this.connectedIds();
    if (remaining.some((p) => !live.has(p.playerId))) {
      await this.ctx.storage.setAlarm(now + GRACE_MS);
    }
  }

  // --- Handshake handlers -----------------------------------------------------

  private handleJoin(ws: WebSocket, att: Attachment | null, mode: 'create' | 'join', nickname: string): void {
    const code = att?.code ?? '';
    const initialized = this.isInitialized();

    if (mode === 'create') {
      if (initialized && this.playerCount() > 0) {
        this.fail(ws, 'code_taken', 'That room code is already in use');
        return;
      }
      this.initRoom(code);
    } else if (!initialized) {
      this.fail(ws, 'no_such_room', 'No room with that code');
      return;
    }

    if (this.playerCount() >= MAX_PLAYERS) {
      this.fail(ws, 'room_full', 'This room is full');
      return;
    }

    const now = Date.now();
    const player: PlayerRow = {
      playerId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      nickname,
      joinedAt: now,
      lastSeen: now,
      seat: this.nextSeat(),
    };
    this.exec(
      `INSERT INTO players (playerId, token, nickname, joinedAt, lastSeen, seat) VALUES (?, ?, ?, ?, ?, ?)`,
      player.playerId,
      player.token,
      player.nickname,
      player.joinedAt,
      player.lastSeen,
      player.seat,
    );
    this.bind(ws, code, player.playerId);
    this.send(ws, {
      type: 'room.joined',
      token: player.token,
      self: { playerId: player.playerId, nickname: player.nickname },
      state: this.roomState(),
    });
    this.broadcastState();
  }

  private handleReconnect(ws: WebSocket, att: Attachment | null, token: string): void {
    const code = att?.code ?? '';
    if (!this.isInitialized()) {
      this.fail(ws, 'no_such_room', 'No room with that code');
      return;
    }
    const player = this.playerByToken(token);
    if (!player) {
      this.fail(ws, 'unknown_session', 'Your session has expired');
      return;
    }

    // Newest connection wins: close any other socket bound to this player.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (this.attachment(other)?.playerId === player.playerId) {
        try {
          other.close(SUPERSEDED, 'superseded');
        } catch {
          // already closing
        }
      }
    }

    this.exec(`UPDATE players SET lastSeen = ? WHERE playerId = ?`, Date.now(), player.playerId);
    this.bind(ws, code, player.playerId);
    this.send(ws, {
      type: 'room.joined',
      token: player.token,
      self: { playerId: player.playerId, nickname: player.nickname },
      state: this.roomState(),
    });
    this.broadcastState();
  }

  // --- State & messaging ------------------------------------------------------

  private roomState(exclude?: WebSocket): RoomState {
    const connected = this.connectedIds(exclude);
    const players: PlayerView[] = this.players().map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      connected: connected.has(p.playerId),
      seat: p.seat,
    }));
    return {
      code: this.metaGet('code') ?? '',
      phase: 'lobby',
      players,
      maxPlayers: MAX_PLAYERS,
    };
  }

  private broadcastState(exclude?: WebSocket): void {
    const message: ServerMessage = { type: 'room.state', state: this.roomState(exclude) };
    const payload = encode(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      if (!this.attachment(ws)?.playerId) continue;
      try {
        ws.send(payload);
      } catch {
        // socket is gone; the close handler will clean it up
      }
    }
  }

  private connectedIds(exclude?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const playerId = this.attachment(ws)?.playerId;
      if (playerId) ids.add(playerId);
    }
    return ids;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(encode(message));
    } catch {
      // socket is gone
    }
  }

  /** Send a fatal error, then close the socket so the client stops retrying. */
  private fail(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: 'error', code, message, fatal: true });
    try {
      ws.close(FATAL, code);
    } catch {
      // already closing
    }
  }

  private bind(ws: WebSocket, code: string, playerId: string): void {
    ws.serializeAttachment({ code, playerId } satisfies Attachment);
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
    }
  }

  // --- SQLite helpers ---------------------------------------------------------

  private exec<T = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(query, ...bindings).toArray() as T[];
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private metaGet(key: string): string | null {
    const rows = this.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key);
    return rows.length ? rows[0].value : null;
  }

  private metaSet(key: string, value: string): void {
    this.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private isInitialized(): boolean {
    return this.metaGet('initialized') === '1';
  }

  private initRoom(code: string): void {
    if (this.isInitialized()) return;
    this.metaSet('initialized', '1');
    this.metaSet('code', code);
    this.metaSet('createdAt', String(Date.now()));
    this.metaSet('phase', 'lobby');
  }

  private players(): PlayerRow[] {
    return this.exec<PlayerRow>(`SELECT * FROM players ORDER BY seat ASC`);
  }

  private playerCount(): number {
    const rows = this.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM players`);
    return rows[0]?.n ?? 0;
  }

  private playerByToken(token: string): PlayerRow | null {
    const rows = this.exec<PlayerRow>(`SELECT * FROM players WHERE token = ?`, token);
    return rows.length ? rows[0] : null;
  }

  private nextSeat(): number {
    const rows = this.exec<{ seat: number }>(`SELECT COALESCE(MAX(seat), -1) + 1 AS seat FROM players`);
    return rows[0]?.seat ?? 0;
  }
}
