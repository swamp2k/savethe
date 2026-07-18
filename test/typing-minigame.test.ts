import { describe, expect, it } from 'vitest';
import { typingGame } from '../src/server/minigames/typing';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

function fresh() {
  return typingGame.onStart(typingGame.createInitialState(config, ctx(0)), ctx(0));
}

interface MpcView {
  role: string;
  passageWords: string[];
  wordsCorrect: number;
  wordsRequired: number;
  totalSupportCompletions: number;
}

interface SupportView extends MpcView {
  myPhraseWords: string[];
  myCompletedCount: number;
}

function mpcView(s: unknown): MpcView {
  return typingGame.getStateForPlayer(s, 'mpc') as MpcView;
}

function supportView(s: unknown, id: string): SupportView {
  return typingGame.getStateForPlayer(s, id) as SupportView;
}

describe('typing test: action schema', () => {
  it('accepts a well-formed type action', () => {
    expect(typingGame.actionSchema.safeParse({ kind: 'type', text: 'hello world' }).success).toBe(true);
    expect(typingGame.actionSchema.safeParse({ kind: 'type', text: '' }).success).toBe(true);
  });

  it('rejects malformed actions', () => {
    expect(typingGame.actionSchema.safeParse({ kind: 'type' }).success).toBe(false);
    expect(typingGame.actionSchema.safeParse({ kind: 'type', text: 'x'.repeat(201) }).success).toBe(false);
    expect(typingGame.actionSchema.safeParse({ kind: 'explode', text: 'x' }).success).toBe(false);
  });
});

describe('typing test: MPC progress', () => {
  it('resolves success when the MPC types the full passage', () => {
    const s = fresh();
    const passage = mpcView(s).passageWords;
    const typed = typingGame.handleMpcAction(s, { kind: 'type', text: `${passage.join(' ')} ` }, ctx(20_000));
    expect(typingGame.evaluate(typed, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('completes the passage without a trailing space after the final word', () => {
    // No reason to make a player type one keystroke they don't need to.
    const s = fresh();
    const passage = mpcView(s).passageWords;
    const typed = typingGame.handleMpcAction(s, { kind: 'type', text: passage.join(' ') }, ctx(20_000));
    expect(mpcView(typed).wordsCorrect).toBe(passage.length);
    expect(typingGame.evaluate(typed, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('does not resolve on partial correct progress', () => {
    const s = fresh();
    const passage = mpcView(s).passageWords;
    const typed = typingGame.handleMpcAction(s, { kind: 'type', text: `${passage.slice(0, 2).join(' ')} ` }, ctx(5000));
    expect(mpcView(typed).wordsCorrect).toBe(2);
    expect(typingGame.evaluate(typed, ctx(0))).toEqual({ status: 'active' });
  });

  it('does not credit an in-progress word until sealed by a trailing space', () => {
    const s = fresh();
    const passage = mpcView(s).passageWords;
    const typed = typingGame.handleMpcAction(s, { kind: 'type', text: passage[0] }, ctx(2000));
    expect(mpcView(typed).wordsCorrect).toBe(0);
  });

  it('stops counting at the first mismatched word', () => {
    const s = fresh();
    const passage = mpcView(s).passageWords;
    const text = `${passage[0]} wrongword ${passage[2] ?? ''} `;
    const typed = typingGame.handleMpcAction(s, { kind: 'type', text }, ctx(3000));
    expect(mpcView(typed).wordsCorrect).toBe(1);
  });

  it('recovers from a correction since progress is recomputed fresh each time', () => {
    let s = fresh();
    const passage = mpcView(s).passageWords;
    s = typingGame.handleMpcAction(s, { kind: 'type', text: `${passage[0]} wrng` }, ctx(2000));
    expect(mpcView(s).wordsCorrect).toBe(1); // word 2 not yet sealed, mismatch doesn't matter yet
    s = typingGame.handleMpcAction(s, { kind: 'type', text: `${passage[0]} ${passage[1]} ` }, ctx(3000));
    expect(mpcView(s).wordsCorrect).toBe(2);
  });

  it('ignores a burst of correct words that arrives faster than plausible', () => {
    const s = fresh();
    const passage = mpcView(s).passageWords;
    // The whole passage claimed correct just 10ms after the challenge started.
    const typed = typingGame.handleMpcAction(s, { kind: 'type', text: `${passage.join(' ')} ` }, ctx(10));
    expect(mpcView(typed).wordsCorrect).toBe(0); // ignored; state unchanged
  });

  it('ignores further actions once the outcome has resolved', () => {
    let s = fresh();
    const passage = mpcView(s).passageWords;
    s = typingGame.handleMpcAction(s, { kind: 'type', text: `${passage.join(' ')} ` }, ctx(3000));
    expect(typingGame.evaluate(s, ctx(0))).toMatchObject({ success: true });
    const before = s;
    const after = typingGame.handleMpcAction(s, { kind: 'type', text: 'anything' }, ctx(4000));
    expect(after).toBe(before);
  });
});

describe('typing test: support bursts', () => {
  it('a support completion lowers the requirement and hands out a new phrase', () => {
    const s = fresh();
    const before = supportView(s, 's1');
    const done = typingGame.handleSupportAction(
      s,
      's1',
      { kind: 'type', text: `${before.myPhraseWords.join(' ')} ` },
      ctx(5000),
    );
    const after = supportView(done, 's1');
    expect(after.myCompletedCount).toBe(1);
    expect(after.totalSupportCompletions).toBe(1);
    expect(after.wordsRequired).toBe(before.wordsRequired - 2);
  });

  it('never lowers the requirement below the floor', () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) {
      const phrase = supportView(s, 's1').myPhraseWords;
      s = typingGame.handleSupportAction(s, 's1', { kind: 'type', text: `${phrase.join(' ')} ` }, ctx(1000 * (i + 1)));
    }
    // passage length 7 -> floor = max(4, ceil(7*0.4)) = 4.
    expect(mpcView(s).wordsRequired).toBe(4);
  });

  it("a support completion can trigger success outright if it lowers the bar to the MPC's existing progress", () => {
    let s = fresh();
    const passage = mpcView(s).passageWords; // length 7
    const partial = `${passage.slice(0, 5).join(' ')} `;
    s = typingGame.handleMpcAction(s, { kind: 'type', text: partial }, ctx(3000));
    expect(mpcView(s).wordsCorrect).toBe(5);
    expect(typingGame.evaluate(s, ctx(0))).toEqual({ status: 'active' });

    const phrase = supportView(s, 's1').myPhraseWords;
    s = typingGame.handleSupportAction(s, 's1', { kind: 'type', text: `${phrase.join(' ')} ` }, ctx(4000));
    expect(mpcView(s).wordsRequired).toBe(5); // 7 - 2
    expect(typingGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it("ignores a support action from a player not in this round's support list", () => {
    const s = fresh();
    const after = typingGame.handleSupportAction(s, 'ghost', { kind: 'type', text: 'save ' }, ctx(1000));
    expect(after).toBe(s);
  });

  it('ignores an implausibly fast support burst the same way as the MPC path', () => {
    const s = fresh();
    const phrase = supportView(s, 's1').myPhraseWords;
    const typed = typingGame.handleSupportAction(s, 's1', { kind: 'type', text: `${phrase.join(' ')} ` }, ctx(5));
    expect(supportView(typed, 's1').myCompletedCount).toBe(0); // ignored
  });
});

describe('typing test: deadline and difficulty', () => {
  it('fails when the overall time budget expires', () => {
    const s = fresh();
    const deadline = typingGame.getNextDeadline(s)!;
    const timedOut = typingGame.onDeadline(s, ctx(deadline));
    expect(typingGame.evaluate(timedOut, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('does not resolve before the deadline with no action taken', () => {
    const s = fresh();
    expect(typingGame.evaluate(s, ctx(0))).toEqual({ status: 'active' });
  });

  it('scales passage length up and time budget down with difficulty, within caps', () => {
    const easy = typingGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)) as {
      passageWords: string[];
      timeBudgetMs: number;
    };
    const hard = typingGame.createInitialState({ ...config, difficulty: 20 }, ctx(0)) as {
      passageWords: string[];
      timeBudgetMs: number;
    };
    expect(easy.passageWords.length).toBe(7);
    expect(hard.passageWords.length).toBe(14); // capped
    expect(easy.timeBudgetMs).toBe(25_000);
    expect(hard.timeBudgetMs).toBe(16_000); // floored
  });
});

describe('typing test: per-player projection', () => {
  it('projects roles correctly', () => {
    const s = fresh();
    expect(mpcView(s).role).toBe('mpc');
    expect(supportView(s, 's1').role).toBe('support');
    const spectator = typingGame.getStateForPlayer(s, 'ghost') as { role: string };
    expect(spectator.role).toBe('spectator');
  });

  it('only exposes a phrase and completion count to support players', () => {
    const s = fresh();
    const mpc = mpcView(s) as unknown as Record<string, unknown>;
    expect(mpc.myPhraseWords).toBeUndefined();
    const support = supportView(s, 's1');
    expect(support.myPhraseWords.length).toBeGreaterThan(0);
    expect(support.myCompletedCount).toBe(0);
  });

  it('does not hide its deadline (no secret timing, unlike the Reaction Test)', () => {
    expect(typingGame.isDeadlineHidden).toBeUndefined();
  });
});
