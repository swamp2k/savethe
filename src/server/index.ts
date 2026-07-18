import { GameRoom } from './GameRoom';
import { RoomRegistry } from './RoomRegistry';

export { GameRoom, RoomRegistry };

export interface Env {
  ASSETS: Fetcher;
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ROOM_REGISTRY: DurableObjectNamespace<RoomRegistry>;
}

const WS_PREFIX = '/ws/';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith(WS_PREFIX)) {
      const code = decodeURIComponent(url.pathname.slice(WS_PREFIX.length)).toUpperCase();
      if (!code) return new Response('Missing room code', { status: 400 });

      // Deterministic room -> Durable Object mapping (design doc section 38).
      // Forward the request untouched so the WebSocket Upgrade survives; the DO
      // reads the room code from the URL path.
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Everything else is the SPA. run_worker_first scopes the Worker to /ws/*,
    // but we forward defensively so asset serving works under any config.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
