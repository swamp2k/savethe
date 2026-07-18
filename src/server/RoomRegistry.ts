import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

/**
 * A single global singleton Durable Object (accessed via `idFromName('singleton')`)
 * that counts active rooms across the whole deployment. `GameRoom` instances have
 * no visibility into each other, so a room cap (hardening: bound the total
 * Durable Object / storage footprint someone could spin up) needs somewhere
 * shared to live. `cap` is a parameter rather than a class constant so tests can
 * exercise the reserve/release boundary without creating hundreds of real rooms.
 *
 * A DO's methods run one at a time against its own state, so `tryReserve` /
 * `release` are naturally race-free without any extra locking.
 */
export class RoomRegistry extends DurableObject<Env> {
  async tryReserve(cap: number): Promise<boolean> {
    const count = (await this.ctx.storage.get<number>('count')) ?? 0;
    if (count >= cap) return false;
    await this.ctx.storage.put('count', count + 1);
    return true;
  }

  async release(): Promise<void> {
    const count = (await this.ctx.storage.get<number>('count')) ?? 0;
    await this.ctx.storage.put('count', Math.max(0, count - 1));
  }

  async count(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }
}
