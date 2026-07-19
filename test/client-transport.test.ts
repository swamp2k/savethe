import { describe, expect, it, vi } from 'vitest';
import { canSendGameplay, sendRaw, type SocketLike } from '../src/client/transport';

const GAME_START = { type: 'game.start' } as const;

describe('client gameplay transport', () => {
  it('sends gameplay actions over an open socket', () => {
    const send = vi.fn();
    const socket: SocketLike = { readyState: 1, send };

    expect(sendRaw(socket, GAME_START, 1)).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify(GAME_START));
  });

  it('does not send or queue a gameplay action when the socket is not open', () => {
    const send = vi.fn();
    const socket: SocketLike = { readyState: 0, send };

    expect(sendRaw(socket, GAME_START, 1)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps gameplay blocked until a reconnect has opened and restored state', () => {
    expect(canSendGameplay('reconnecting', false)).toBe(false);
    expect(canSendGameplay('connected', false)).toBe(false);
    expect(canSendGameplay('connected', true)).toBe(true);
  });
});
