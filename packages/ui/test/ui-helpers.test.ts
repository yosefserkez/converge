import { describe, expect, it } from 'vitest';
import { formatCountdown, formatMicroUsd, parseDollarsToMicroUsd, shortSha } from '../src/lib/format.ts';
import { cellState, rowSummary } from '../src/lib/matrix.ts';
import { describeFailure, parseSequence } from '../src/lib/story.ts';
import { maxConcurrency } from '../src/lib/timeline.ts';
import { sampleReplay, sampleSnapshot } from '../src/sample/sample-data.ts';
import { budgetExhausted, fromReplay, fromSnapshot, reviewCandidate } from '../src/lib/view.ts';

describe('money', () => {
  it('formats integer micro-USD as dollars', () => {
    expect(formatMicroUsd(0)).toBe('$0.00');
    expect(formatMicroUsd(1_284_317)).toBe('$1.28');
    expect(formatMicroUsd(5_000_000)).toBe('$5.00');
    expect(formatMicroUsd(1_234_567_890)).toBe('$1,234.57');
    expect(formatMicroUsd(2_500)).toBe('$0.0025');
    expect(formatMicroUsd(-500_000)).toBe('-$0.50');
    expect(formatMicroUsd(null)).toBe('$0.00');
  });

  it('parses dollar input to integer micro-USD without float error', () => {
    expect(parseDollarsToMicroUsd('5')).toBe(5_000_000);
    expect(parseDollarsToMicroUsd('$0.10')).toBe(100_000);
    expect(parseDollarsToMicroUsd('1.000001')).toBe(1_000_001);
    expect(parseDollarsToMicroUsd('0.29')).toBe(290_000);
    expect(parseDollarsToMicroUsd('-1')).toBeNull();
    expect(parseDollarsToMicroUsd('1.2345678')).toBeNull();
    expect(parseDollarsToMicroUsd('abc')).toBeNull();
  });
});

describe('identifiers and time', () => {
  it('shortens Git object IDs and digests', () => {
    expect(shortSha('1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d')).toBe('1a2b3c4');
    expect(shortSha('sha256:abcdef0123456789')).toBe('abcdef0');
    expect(shortSha(null)).toBe('—');
  });

  it('counts down in m:ss and stops at zero', () => {
    expect(formatCountdown(90_000)).toBe('1:30');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(-10)).toBe('0:00');
  });
});

describe('matrix cell state', () => {
  it('keeps skipped, failed, error, and not-run distinct', () => {
    expect(cellState({ status: 'passed', applicable: true }, 'passed')).toBe('passed');
    expect(cellState({ status: 'failed', applicable: true }, 'failed')).toBe('failed');
    expect(cellState({ status: 'error', applicable: true }, 'failed')).toBe('error');
    expect(cellState({ status: 'skipped', applicable: false }, 'passed')).toBe('skipped');
    expect(cellState({ status: 'passed', applicable: false }, 'passed')).toBe('skipped');
    expect(cellState({ status: 'running', applicable: true }, 'testing')).toBe('running');
    expect(cellState({ status: 'pending', applicable: true }, 'testing')).toBe('pending');
    expect(cellState({ status: 'pending', applicable: true }, 'text_conflict')).toBe('not_run');
    expect(cellState(undefined, 'testing')).toBe('pending');
    expect(cellState(undefined, 'planned')).toBe('not_run');
    expect(cellState({ status: 'weird', applicable: true }, 'passed')).toBe('error');
  });

  it('never counts a skipped check as a pass', () => {
    expect(rowSummary(['passed', 'skipped', 'failed', 'not_run'])).toEqual({ passed: 1, failed: 1, error: 0, skipped: 1, open: 1 });
  });
});

describe('interaction story', () => {
  const obs = [
    { label: 'seq1 step1 member-1 backpack status', expected: 200, observed: 200, passed: true },
    { label: 'seq1 step1 member-1 backpack unitPriceCents', expected: 8000, observed: 8000, passed: true },
    { label: 'seq1 step2 regular-1 backpack unitPriceCents', expected: 10000, observed: 8000, passed: false },
  ];

  it('parses the request sequence in order', () => {
    const steps = parseSequence([...obs].reverse());
    expect(steps.map((s) => `${s.sequence}.${s.step}`)).toEqual(['1.1', '1.1', '1.2']);
    expect(steps[2]).toMatchObject({ customer: 'regular-1', product: 'backpack', observed: 8000, passed: false });
  });

  it('describes the failure in plain words', () => {
    expect(describeFailure(obs)).toBe('after a member quote, a regular customer received 8000 instead of 10000');
    expect(describeFailure([{ label: 'x', expected: 1, observed: 2, passed: false }])).toBe('x: expected 1, observed 2');
    expect(describeFailure(obs.slice(0, 2))).toBeNull();
  });
});

describe('timeline', () => {
  it('counts concurrent lanes, not spans', () => {
    expect(
      maxConcurrency([
        { lane: 'a', start: 0, end: 10 },
        { lane: 'a', start: 2, end: 4 },
        { lane: 'b', start: 5, end: 15 },
        { lane: 'c', start: 9, end: 20 },
      ]),
    ).toBe(3);
    expect(maxConcurrency([{ lane: 'a', start: 0, end: 5 }, { lane: 'b', start: 5, end: 9 }])).toBe(1);
  });
});

describe('view model', () => {
  it('builds the same review target from a snapshot and its replay', () => {
    const op = fromSnapshot(sampleSnapshot('promoted'));
    const rp = fromReplay(sampleReplay('promoted'));
    expect(reviewCandidate(op)?.id).toBe('cand_repaired');
    expect(reviewCandidate(rp)?.id).toBe('cand_repaired');
    expect(rp.readOnly).toBe(true);
    expect(rp.interactions[0]?.failedCheck?.observations.length).toBe(op.interactions[0]?.failedCheck?.observations.length);
  });

  it('flags an exhausted budget', () => {
    expect(budgetExhausted(fromSnapshot(sampleSnapshot('failed-agent')))).toBe(true);
    expect(budgetExhausted(fromSnapshot(sampleSnapshot('ready')))).toBe(false);
  });
});
