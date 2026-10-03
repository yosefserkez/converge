import { describe, expect, it } from 'vitest';
import { freshCoordinator, lease, agentJobFor, ok, snapshot, sql, startedSession, type Coordinator } from './helpers.ts';

const CEILING = 1_000_000;

interface Balances {
  reserved: number;
  spent: number;
  uncertain: number;
  total: number;
}

async function ledgerOf(stub: Coordinator, sessionId: string): Promise<Balances> {
  const { reserved, spent, uncertain, total } = (await snapshot(stub, sessionId)).session.budget;
  return { reserved, spent, uncertain, total };
}

function expectNonNegative(b: Balances) {
  expect(b.reserved).toBeGreaterThanOrEqual(0);
  expect(b.spent).toBeGreaterThanOrEqual(0);
  expect(b.uncertain).toBeGreaterThanOrEqual(0);
}

describe('model budget ledger', () => {
  it('reserves within the ceiling, refuses over it, and settles idempotently', async () => {
    const stub = freshCoordinator('budget');
    const { sessionId } = await startedSession(stub);
    await sql(stub, 'UPDATE session SET model_budget_microusd = ? WHERE id = ?', CEILING, sessionId);
    const { job } = await agentJobFor(stub, 'pricing');
    const l = await lease(stub, job.id);

    const first = await stub.wfBudgetReserve(l.jobId, l.fence, 'turn-1', 400_000);
    expect(first.ok).toBe(true);
    expect(first.balances).toEqual({ reserved: 400_000, spent: 0, uncertain: 0, total: 400_000 });

    // A repeated reserve for the same operation does not reserve twice.
    const repeat = await stub.wfBudgetReserve(l.jobId, l.fence, 'turn-1', 400_000);
    expect(repeat).toEqual(first);

    const over = await stub.wfBudgetReserve(l.jobId, l.fence, 'turn-2', 700_000);
    expect(over.ok).toBe(false);
    expect(over.balances.total).toBe(400_000);
    const blocked = await sql<{ type: string; payload_json: string }>(
      stub,
      "SELECT type, payload_json FROM event WHERE session_id = ? AND type = 'budget.blocked'",
      sessionId,
    );
    expect(blocked).toHaveLength(1);
    expect(JSON.parse(blocked[0]!.payload_json)).toMatchObject({ requested: 700_000, ceiling: CEILING });

    // Settle releases the reservation and records the observed spend.
    await stub.wfBudgetSettle(l.jobId, 'turn-1', { kind: 'settled', costMicroUsd: 300_000, usage: { inputTokens: 1000, outputTokens: 50 } });
    expect(await ledgerOf(stub, sessionId)).toEqual({ reserved: 0, spent: 300_000, uncertain: 0, total: 300_000 });

    // A duplicate settle, or a settle with another outcome, changes nothing.
    await stub.wfBudgetSettle(l.jobId, 'turn-1', { kind: 'settled', costMicroUsd: 999_999, usage: {} });
    await stub.wfBudgetSettle(l.jobId, 'turn-1', { kind: 'released' });
    expect(await ledgerOf(stub, sessionId)).toEqual({ reserved: 0, spent: 300_000, uncertain: 0, total: 300_000 });

    // An ambiguous provider outcome moves the reservation to uncertain; it is never free.
    const second = await stub.wfBudgetReserve(l.jobId, l.fence, 'turn-3', 500_000);
    expect(second.ok).toBe(true);
    await stub.wfBudgetSettle(l.jobId, 'turn-3', { kind: 'uncertain' });
    expect(await ledgerOf(stub, sessionId)).toEqual({ reserved: 0, spent: 300_000, uncertain: 500_000, total: 800_000 });

    // Uncertain spend still counts against the ceiling.
    expect((await stub.wfBudgetReserve(l.jobId, l.fence, 'turn-4', 300_000)).ok).toBe(false);
    const released = await stub.wfBudgetReserve(l.jobId, l.fence, 'turn-5', 200_000);
    expect(released.ok).toBe(true);
    await stub.wfBudgetSettle(l.jobId, 'turn-5', { kind: 'released' });

    // Settling an unknown reservation is a no-op.
    await stub.wfBudgetSettle(l.jobId, 'never-reserved', { kind: 'settled', costMicroUsd: 5, usage: {} });

    const final = await ledgerOf(stub, sessionId);
    expect(final).toEqual({ reserved: 0, spent: 300_000, uncertain: 500_000, total: 800_000 });
    expectNonNegative(final);

    // Every prefix of the ledger keeps all three balances non-negative.
    const rows = await sql<{ reserved_delta_microusd: number; spent_delta_microusd: number; uncertain_delta_microusd: number }>(
      stub,
      'SELECT reserved_delta_microusd, spent_delta_microusd, uncertain_delta_microusd FROM budget_entry WHERE session_id = ? ORDER BY created_at, rowid',
      sessionId,
    );
    expect(rows).toHaveLength(6);
    const running = { reserved: 0, spent: 0, uncertain: 0, total: 0 };
    for (const r of rows) {
      running.reserved += r.reserved_delta_microusd;
      running.spent += r.spent_delta_microusd;
      running.uncertain += r.uncertain_delta_microusd;
      expectNonNegative(running);
    }
  });
});

describe('cancellation and the ledger', () => {
  it('books a reservation that is in flight at cancel time as uncertain, never as free', async () => {
    const stub = freshCoordinator('budget-cancel');
    const { sessionId } = await startedSession(stub);
    await sql(stub, 'UPDATE session SET model_budget_microusd = ? WHERE id = ?', CEILING, sessionId);
    const { job } = await agentJobFor(stub, 'pricing');
    const l = await lease(stub, job.id);
    expect((await stub.wfBudgetReserve(l.jobId, l.fence, 'in-flight', 250_000)).ok).toBe(true);

    await ok(stub, 'cancelSession', { sessionId });
    const b = await ledgerOf(stub, sessionId);
    expect(b).toEqual({ reserved: 0, spent: 0, uncertain: 250_000, total: 250_000 });

    // A late settle from the terminated attempt does not change the booked outcome.
    await stub.wfBudgetSettle(l.jobId, 'in-flight', { kind: 'released' });
    expect(await ledgerOf(stub, sessionId)).toEqual(b);
  });
});
