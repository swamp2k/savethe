import type { Env } from '../src/server/index';

// Type the `env` provided by @cloudflare/vitest-pool-workers with our bindings.
declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation requires an interface
  interface ProvidedEnv extends Env {}
}
