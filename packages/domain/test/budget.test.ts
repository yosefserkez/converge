import { describe, expect, it } from 'vitest';
import {
  balances,
  canReserve,
  DomainError,
  estimateMaxCost,
  LedgerEntry,
  PriceSnapshot,
  reconcileEntry,
  releaseEntry,
  reserveEntry,
  settleEntry,
  uncertainEntry,
  usageCost,
} from '../src/index.ts';

const snapshot = PriceSnapshot.parse({
  provider: 'anthropic',
  modelId: 'model-x',
  inputMicroUsdPerMTok: 3_000_000, // $3 / MTok
  outputMicroUsdPerMTok: 15_000_000, // $15 / MTok
  cacheReadMicroUsdPerMTok: 300_000,
  capturedAt: 1,
});

describe('cost math', () => {
  it('estimates a conservative integer ceiling', () => {
    expect(estimateMaxCost(snapshot, 10_000, 2_000)).toBe(60_000);
    // 1 input token at $3/MTok = 3 micro-USD exactly; 1 output token = 15.
    expect(estimateMaxCost(snapshot, 1, 1)).toBe(18);
    const odd = { ...snapshot, inputMicroUsdPerMTok: 1 };
    expect(estimateMaxCost(odd, 1, 0)).toBe(1); // ceil(1e-6) -> 1
  });

  it('prices usage including cache tokens and falls back to the input rate', () => {
    expect(usageCost(snapshot, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10_000 })).toBe(3000 + 1500 + 3000);
    expect(usageCost(snapshot, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 })).toBe(3000);
    expect(Number.isInteger(usageCost(snapshot, { inputTokens: 7, outputTokens: 3 }))).toBe(true);
  });

  it('rejects negative or fractional token counts', () => {
    expect(() => estimateMaxCost(snapshot, -1, 0)).toThrow(DomainError);
    expect(() => usageCost(snapshot, { inputTokens: 1.5, outputTokens: 0 })).toThrow(DomainError);
  });
});

describe('ledger', () => {
  const r1 = { reservationId: 'res-1', amountMicroUsd: 60_000 };
  const r2 = { reservationId: 'res-2', amountMicroUsd: 40_000 };

  it('reserve then settle releases the reservation and adds spend', () => {
    const b = balances([reserveEntry(r1.reservationId, r1.amountMicroUsd), settleEntry(r1, 12_345)]);
    expect(b).toEqual({ reserved: 0, spent: 12_345, uncertain: 0, total: 12_345 });
  });

  it('release returns the reservation', () => {
    expect(balances([reserveEntry('res-1', 60_000), releaseEntry(r1)]).total).toBe(0);
  });

  it('uncertain moves the reservation into uncertain charges, then reconciles', () => {
    const entries: LedgerEntry[] = [reserveEntry('res-1', 60_000), reserveEntry('res-2', 40_000), uncertainEntry(r1)];
    expect(balances(entries)).toEqual({ reserved: 40_000, spent: 0, uncertain: 60_000, total: 100_000 });
    entries.push(reconcileEntry('res-1', { uncertain: -60_000, spent: 20_000 }, 'provider usage report'));
    expect(balances(entries)).toEqual({ reserved: 40_000, spent: 20_000, uncertain: 0, total: 60_000 });
  });

  it('never lets a balance go negative', () => {
    expect(() => balances([reconcileEntry('res-1', { spent: -1 }, 'bad')])).toThrow(DomainError);
    expect(() => balances([reserveEntry('res-1', 10), uncertainEntry(r1)])).toThrow(DomainError);
  });

  it('rejects double settlement, unknown reservations, and reused ids', () => {
    expect(() => balances([reserveEntry('res-1', 60_000), settleEntry(r1, 1), settleEntry(r1, 1)])).toThrow(/not open/);
    expect(() => balances([releaseEntry(r2)])).toThrow(/not open/);
    expect(() => balances([reserveEntry('res-1', 1), releaseEntry({ reservationId: 'res-1', amountMicroUsd: 1 }), reserveEntry('res-1', 1)])).toThrow(
      /already exists/,
    );
  });

  it('rejects negative constructor amounts', () => {
    expect(() => reserveEntry('res-1', -5)).toThrow(DomainError);
    expect(() => settleEntry(r1, -1)).toThrow(DomainError);
  });

  it('enforces the ceiling on reserved + spent + uncertain', () => {
    const b = balances([reserveEntry('res-1', 60_000), uncertainEntry(r1), reserveEntry('res-2', 30_000)]);
    expect(canReserve(b, 100_000, 10_000)).toBe(true);
    expect(canReserve(b, 100_000, 10_001)).toBe(false);
  });
});
