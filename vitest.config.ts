import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// The Workers pool reads raw wrangler config, which would demand an
// `assets.directory` that the Vite plugin manages instead. So the test worker is
// defined inline here: same entry and same SQLite-backed Durable Object, minus
// the static-assets binding (tests only exercise /ws/* and the DO).
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: './src/server/index.ts',
        miniflare: {
          compatibilityDate: '2025-05-01',
          durableObjects: {
            GAME_ROOM: { className: 'GameRoom', useSQLite: true },
            ROOM_REGISTRY: { className: 'RoomRegistry' },
          },
        },
      },
    },
  },
});
