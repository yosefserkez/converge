import { z } from 'zod';
import { DomainError } from './errors.ts';

// Integer micro-USD model budget ledger (brief §12). Three independently
// summed balances: reserved, spent (observed estimate), uncertain.

const MicroUsd = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const PriceSnapshot = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  inputMicroUsdPerMTok: MicroUsd,
  outputMicroUsdPerMTok: MicroUsd,
  cacheReadMicroUsdPerMTok: MicroUsd.optional(),
  cacheWriteMicroUsdPerMTok: MicroUsd.optional(),
  capturedAt: z.number().int(),
});
export type PriceSnapshot = z.infer<typeof PriceSnapshot>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const PER_MTOK = 1_000_000;

function tokens(n: number | undefined, label: string): number {
  const v = n ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new DomainError('INVALID_INPUT', `${label} must be a non-negative integer`);
  return v;
}

function ceilCost(microUsdTimesTokens: number): number {
  if (!Number.isSafeInteger(microUsdTimesTokens)) throw new DomainError('INVALID_INPUT', 'cost overflow');
  return Math.ceil(microUsdTimesTokens / PER_MTOK);
}

/** Conservative ceiling for one provider request. */
export function estimateMaxCost(snapshot: PriceSnapshot, maxInputTokens: number, maxOutputTokens: number): number {
  return ceilCost(
    tokens(maxInputTokens, 'maxInputTokens') * snapshot.inputMicroUsdPerMTok +
      tokens(maxOutputTokens, 'maxOutputTokens') * snapshot.outputMicroUsdPerMTok,
  );
}

/** Cost estimate from reported usage. Missing cache rates fall back to the input rate. */
export function usageCost(snapshot: PriceSnapshot, usage: TokenUsage): number {
  return ceilCost(
    tokens(usage.inputTokens, 'inputTokens') * snapshot.inputMicroUsdPerMTok +
      tokens(usage.outputTokens, 'outputTokens') * snapshot.outputMicroUsdPerMTok +
      tokens(usage.cacheReadTokens, 'cacheReadTokens') * (snapshot.cacheReadMicroUsdPerMTok ?? snapshot.inputMicroUsdPerMTok) +
      tokens(usage.cacheWriteTokens, 'cacheWriteTokens') * (snapshot.cacheWriteMicroUsdPerMTok ?? snapshot.inputMicroUsdPerMTok),
  );
}

const Delta = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const LedgerEntry = z.object({
  kind: z.enum(['reserve', 'settle', 'release', 'uncertain', 'reconcile']),
  reservationId: z.string().min(1),
  reservedDelta: Delta,
  spentDelta: Delta,
  uncertainDelta: Delta,
  note: z.string().max(500).optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export interface Reservation {
  reservationId: string;
  amountMicroUsd: number;
}

export interface Balances {
  reserved: number;
  spent: number;
  uncertain: number;
  total: number;
}

function amount(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new DomainError('INVALID_INPUT', `${label} must be a non-negative integer micro-USD`);
  return n;
}

export function reserveEntry(reservationId: string, amountMicroUsd: number): LedgerEntry {
  return { kind: 'reserve', reservationId, reservedDelta: amount(amountMicroUsd, 'amount'), spentDelta: 0, uncertainDelta: 0 };
}

/** Success: release the reservation and record the calculated usage estimate. */
export function settleEntry(reservation: Reservation, actualCostMicroUsd: number): LedgerEntry {
  return {
    kind: 'settle',
    reservationId: reservation.reservationId,
    reservedDelta: -amount(reservation.amountMicroUsd, 'reservation'),
    spentDelta: amount(actualCostMicroUsd, 'actualCost'),
    uncertainDelta: 0,
  };
}

/** Definitely uncharged (for example, cancelled before send). */
export function releaseEntry(reservation: Reservation): LedgerEntry {
  return {
    kind: 'release',
    reservationId: reservation.reservationId,
    reservedDelta: -amount(reservation.amountMicroUsd, 'reservation'),
    spentDelta: 0,
    uncertainDelta: 0,
  };
}

/** Ambiguous provider outcome: never assume it was free. */
export function uncertainEntry(reservation: Reservation): LedgerEntry {
  const a = amount(reservation.amountMicroUsd, 'reservation');
  return { kind: 'uncertain', reservationId: reservation.reservationId, reservedDelta: -a, spentDelta: 0, uncertainDelta: a };
}

/** Auditable adjustment, e.g. an uncertain charge later confirmed as spent. */
export function reconcileEntry(
  reservationId: string,
  deltas: { reserved?: number; spent?: number; uncertain?: number },
  note: string,
): LedgerEntry {
  return LedgerEntry.parse({
    kind: 'reconcile',
    reservationId,
    reservedDelta: deltas.reserved ?? 0,
    spentDelta: deltas.spent ?? 0,
    uncertainDelta: deltas.uncertain ?? 0,
    note,
  });
}

/**
 * Fold the ledger. Throws if any balance would go negative, or a reservation is
 * reused, closed twice, or closed with a different amount than it reserved.
 */
export function balances(entries: readonly LedgerEntry[]): Balances {
  let reserved = 0;
  let spent = 0;
  let uncertain = 0;
  const open = new Map<string, number>();
  const closed = new Set<string>();
  for (const [i, e] of entries.entries()) {
    if (e.kind === 'reserve') {
      if (open.has(e.reservationId) || closed.has(e.reservationId)) {
        throw new DomainError('INVALID_STATE', `reservation ${e.reservationId} already exists`, { index: i });
      }
      open.set(e.reservationId, e.reservedDelta);
    } else if (e.kind !== 'reconcile') {
      const held = open.get(e.reservationId);
      if (held === undefined) {
        throw new DomainError('INVALID_STATE', `reservation ${e.reservationId} is not open`, { index: i });
      }
      if (-e.reservedDelta !== held) {
        throw new DomainError('INVALID_STATE', `entry ${i} closes ${-e.reservedDelta} of reservation ${e.reservationId} holding ${held}`, {
          index: i,
        });
      }
      open.delete(e.reservationId);
      closed.add(e.reservationId);
    }
    reserved += e.reservedDelta;
    spent += e.spentDelta;
    uncertain += e.uncertainDelta;
    if (reserved < 0 || spent < 0 || uncertain < 0) {
      throw new DomainError('INVALID_STATE', `ledger balance would go negative at entry ${i}`, { index: i, reserved, spent, uncertain });
    }
  }
  return { reserved, spent, uncertain, total: reserved + spent + uncertain };
}

export function canReserve(current: Balances, ceilingMicroUsd: number, amountMicroUsd: number): boolean {
  amount(ceilingMicroUsd, 'ceiling');
  amount(amountMicroUsd, 'amount');
  return current.total + amountMicroUsd <= ceilingMicroUsd;
}
