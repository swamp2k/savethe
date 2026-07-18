import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import type { RoomRegistry } from './RoomRegistry';
import { decodeClientMessage, encode, type ServerMessage, type ErrorCode, type EmoteKind } from '../shared/protocol';
import {
  EMOTE_COOLDOWN_MS,
  GRACE_MS,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MAX_ROOMS,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
} from '../shared/constants';
import {
  initialGameState,
  projectFor,
  reduce,
  type EngineAction,
  type EnginePlayer,
  type GameState,
} from './engine/engine';
import { getMinigame } from './minigames/registry';
import type { MinigameContext } from './minigames/contract';

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
  /** Per-connection rate-limit window state (hardening). Lives on the
   *  attachment, not an instance field, so it survives hibernation. */
  rl?: { windowStart: number; count: number; warned: boolean };
  /** Server time of this connection's last accepted emote, for the
   *  per-player emote cooldown. */
  emoteAt?: number;
}

const SUPERSEDED = 4000;
const FATAL = 4001;
/** Floor for a past-due alarm so we never request a wake in the past. */
const ALARM_FLOOR_MS = 100;

/**
 * One GameRoom Durable Object per room code. Owns roster + reconnect identity
 * (SQLite) and drives the pure game engine, persisting GameState as JSON and
 * scheduling a single alarm that covers both engine deadlines and roster
 * cleanup. Hibernation-safe: nothing lives in instance memory across requests.
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
    server.serializeAttachment({ code } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernatable WebSocket handlers ---------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (raw.length > MAX_MESSAGE_BYTES) {
      this.send(ws, { type: 'error', code: 'bad_message', message: 'Message too large', fatal: false });
      return;
    }
    if (!this.checkRateLimit(ws)) return;

    const decoded = decodeClientMessage(raw);
    if (!decoded.ok) {
      this.send(ws, { type: 'error', code: 'bad_message', message: 'Malformed message', fatal: false });
      return;
    }
    const msg = decoded.value;
    const att = this.attachment(ws);

    if (!att?.playerId) {
      // Handshake phase: only join/reconnect are valid.
      if (msg.type === 'room.join') return this.handleJoin(ws, att, msg.mode, msg.nickname);
      if (msg.type === 'room.reconnect') return this.handleReconnect(ws, att, msg.token);
      this.send(ws, { type: 'error', code: 'not_joined', message: 'Join the room first', fatal: false });
      return;
    }

    const playerId = att.playerId;
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' });
        return;
      case 'room.join':
      case 'room.reconnect':
        this.send(ws, { type: 'error', code: 'already_joined', message: 'Already in this room', fatal: false });
        return;
      case 'game.start':
        return this.dispatch({ type: 'start', byPlayerId: playerId });
      case 'mpc.vote':
        return this.dispatch({ type: 'mpcVote', voterId: playerId, candidateId: msg.candidateId });
      case 'risk.vote':
        return this.dispatch({ type: 'riskVote', voterId: playerId, choice: msg.choice });
      case 'minigame.action':
        return this.handleMinigameAction(ws, playerId, msg.payload);
      case 'emote':
        return this.handleEmote(ws, playerId, msg.kind);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.attachment(ws);
    if (!att?.playerId) return;
    this.exec(`UPDATE players SET lastSeen = ? WHERE playerId = ?`, Date.now(), att.playerId);
    // The player is now disconnected; sync the engine (may complete a vote).
    let state = this.loadState();
    state = reduce(state, { type: 'syncPlayers', players: this.enginePlayers(ws) }, this.now());
    await this.commit(state);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // 1. Drop players who have been gone longer than the grace period.
    const connected = this.connectedIds();
    for (const p of this.players()) {
      if (!connected.has(p.playerId) && now - p.lastSeen >= GRACE_MS) {
        this.exec(`DELETE FROM players WHERE playerId = ?`, p.playerId);
      }
    }
    if (this.players().length === 0) {
      const wasInitialized = this.isInitialized();
      await this.ctx.storage.deleteAll();
      if (wasInitialized) await this.releaseRoomSlot();
      return;
    }

    // 2. Sync roster into the engine, then advance any elapsed deadlines. A
    //    single wake may have slept past several deadlines, so loop until the
    //    engine stops making progress or its next deadline is in the future.
    let state = this.loadState();
    state = reduce(state, { type: 'syncPlayers', players: this.enginePlayers() }, this.now());
    while (state.deadline !== null && now >= state.deadline) {
      const before = state;
      state = reduce(state, { type: 'tick' }, this.now());
      if (state === before) break;
    }
    await this.commit(state);
  }

  // --- Handshake --------------------------------------------------------------

  private async handleJoin(
    ws: WebSocket,
    att: Attachment | null,
    mode: 'create' | 'join',
    nickname: string,
  ): Promise<void> {
    const code = att?.code ?? '';
    const initialized = this.isInitialized();

    if (mode === 'create') {
      if (initialized && this.playerCount() > 0) {
        this.fail(ws, 'code_taken', 'That room code is already in use');
        return;
      }
      if (!initialized) {
        const reserved = await this.reserveRoomSlot();
        if (!reserved) {
          this.fail(ws, 'server_busy', 'Too many active rooms right now — try again shortly');
          return;
        }
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
    await this.admit(ws, player.playerId, player.token, player.nickname);
  }

  private async handleReconnect(ws: WebSocket, att: Attachment | null, token: string): Promise<void> {
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
    await this.admit(ws, player.playerId, player.token, player.nickname);
  }

  /** Sync the (re)joined player into the engine, broadcast, and send the
   *  private room.joined handshake reply with this player's own view. */
  private async admit(ws: WebSocket, playerId: string, token: string, nickname: string): Promise<void> {
    let state = this.loadState();
    state = reduce(state, { type: 'syncPlayers', players: this.enginePlayers() }, this.now());
    await this.commit(state);
    this.send(ws, { type: 'room.joined', token, self: { playerId, nickname }, view: projectFor(state, playerId) });
  }

  // --- Gameplay ---------------------------------------------------------------

  private handleMinigameAction(ws: WebSocket, playerId: string, payload: unknown): void {
    const state = this.loadState();
    if (state.phase !== 'challenge_active' || !state.activeMinigameId) {
      this.send(ws, { type: 'error', code: 'bad_action', message: 'No active challenge', fatal: false });
      return;
    }
    const game = getMinigame(state.activeMinigameId);
    if (!game) {
      this.send(ws, { type: 'error', code: 'bad_action', message: 'Unknown challenge', fatal: false });
      return;
    }
    const parsed = game.actionSchema.safeParse(payload);
    if (!parsed.success) {
      this.send(ws, { type: 'error', code: 'bad_action', message: 'Invalid action', fatal: false });
      return;
    }
    void this.dispatch({ type: 'minigameAction', playerId, payload: parsed.data });
  }

  /** Spectator emotes are a pure ephemeral broadcast relay: never persisted,
   *  never touching GameState or the engine (there's nothing here for a pure,
   *  deterministic reducer to own). Gated to an active run — nothing to react
   *  to in the lobby — and throttled per-player so one mashed button can't
   *  flood everyone's screen. */
  private handleEmote(ws: WebSocket, playerId: string, kind: EmoteKind): void {
    if (this.loadState().phase === 'lobby') return;

    const att = this.attachment(ws) ?? { code: this.metaGet('code') ?? '' };
    const now = Date.now();
    if (att.emoteAt !== undefined && now - att.emoteAt < EMOTE_COOLDOWN_MS) return; // throttled, drop silently
    ws.serializeAttachment({ ...att, emoteAt: now } satisfies Attachment);

    const message: ServerMessage = { type: 'emote', playerId, kind };
    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.playerId) this.send(socket, message);
    }
  }

  private async dispatch(action: EngineAction): Promise<void> {
    const state = reduce(this.loadState(), action, this.now());
    await this.commit(state);
  }

  // --- Commit: persist, broadcast, reschedule ---------------------------------

  private async commit(state: GameState): Promise<void> {
    this.saveState(state);
    this.broadcast(state);
    await this.scheduleAlarm(state);
  }

  private broadcast(state: GameState): void {
    for (const ws of this.ctx.getWebSockets()) {
      const playerId = this.attachment(ws)?.playerId;
      if (!playerId) continue;
      this.send(ws, { type: 'game.state', view: projectFor(state, playerId) });
    }
  }

  private async scheduleAlarm(state: GameState): Promise<void> {
    const now = Date.now();
    let wake: number | null = null;
    if (state.deadline !== null) wake = Math.max(state.deadline, now + ALARM_FLOOR_MS);

    const cleanup = this.cleanupDeadline();
    if (cleanup !== null) wake = wake === null ? cleanup : Math.min(wake, cleanup);

    if (wake !== null) {
      await this.ctx.storage.setAlarm(wake);
    } else if ((await this.ctx.storage.getAlarm()) !== null) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** Earliest moment a disconnected player crosses the grace threshold, or null. */
  private cleanupDeadline(): number | null {
    const connected = this.connectedIds();
    let earliest: number | null = null;
    for (const p of this.players()) {
      if (connected.has(p.playerId)) continue;
      earliest = earliest === null ? p.lastSeen : Math.min(earliest, p.lastSeen);
    }
    return earliest === null ? null : earliest + GRACE_MS;
  }

  // --- Engine glue ------------------------------------------------------------

  private now(): MinigameContext {
    return { now: Date.now(), random: Math.random };
  }

  private enginePlayers(exclude?: WebSocket): EnginePlayer[] {
    const connected = this.connectedIds(exclude);
    return this.players().map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      connected: connected.has(p.playerId),
      seat: p.seat,
    }));
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

  private loadState(): GameState {
    const raw = this.metaGet('game');
    let state: GameState;
    try {
      state = raw ? (JSON.parse(raw) as GameState) : initialGameState();
    } catch {
      state = initialGameState();
    }
    // The room code lives in meta (set at creation); surface it in the view.
    if (!state.code) state.code = this.metaGet('code') ?? '';
    return state;
  }

  private saveState(state: GameState): void {
    this.metaSet('game', JSON.stringify(state));
  }

  // --- Messaging --------------------------------------------------------------

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(encode(message));
    } catch {
      // socket is gone
    }
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: 'error', code, message, fatal: true });
    try {
      ws.close(FATAL, code);
    } catch {
      // already closing
    }
  }

  private bind(ws: WebSocket, code: string, playerId: string): void {
    // Preserve rate-limit state: this runs mid-message, from inside the very
    // join/reconnect message that checkRateLimit already accounted for at
    // the top of webSocketMessage. A bare overwrite would silently reset the
    // window on every join.
    const rl = this.attachment(ws)?.rl;
    ws.serializeAttachment({ code, playerId, rl } satisfies Attachment);
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  /** Hardening: per-connection flood protection. State lives on the socket's
   *  attachment (survives hibernation) rather than an instance field. Sends
   *  at most one warning per exceeded window so the limiter itself can't be
   *  used to flood the client back. */
  private checkRateLimit(ws: WebSocket): boolean {
    const att: Attachment = this.attachment(ws) ?? { code: '' };
    const now = Date.now();
    const fresh = !att.rl || now - att.rl.windowStart >= RATE_LIMIT_WINDOW_MS;
    const windowStart = fresh ? now : att.rl!.windowStart;
    const count = (fresh ? 0 : att.rl!.count) + 1;
    const allowed = count <= RATE_LIMIT_MAX_MESSAGES;
    const warned = fresh ? false : att.rl!.warned;
    ws.serializeAttachment({ ...att, rl: { windowStart, count, warned: warned || !allowed } } satisfies Attachment);
    if (!allowed && !warned) {
      this.send(ws, { type: 'error', code: 'bad_message', message: 'Slow down', fatal: false });
    }
    return allowed;
  }

  // --- SQLite helpers ---------------------------------------------------------

  private exec<T = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(query, ...bindings).toArray() as T[];
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

  /** Hardening: a global room cap, enforced through the RoomRegistry
   *  singleton. Every successful reservation here is paired with exactly one
   *  `releaseRoomSlot` call, in `alarm()`, when this room's storage is
   *  finally torn down. */
  private registry(): DurableObjectStub<RoomRegistry> {
    return this.env.ROOM_REGISTRY.get(this.env.ROOM_REGISTRY.idFromName('singleton'));
  }

  private async reserveRoomSlot(): Promise<boolean> {
    return this.registry().tryReserve(MAX_ROOMS);
  }

  private async releaseRoomSlot(): Promise<void> {
    await this.registry().release();
  }

  private initRoom(code: string): void {
    if (this.isInitialized()) return;
    this.metaSet('initialized', '1');
    this.metaSet('code', code);
    this.metaSet('createdAt', String(Date.now()));
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
