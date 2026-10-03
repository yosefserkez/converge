// Concurrency evidence from recorded activity: per-agent span totals and the
// time when two or more agents had model or tool work in flight at once.
//   node --experimental-strip-types scripts/dev/concurrency.ts <sessionId>
import { apiFor } from '../api.ts';
import { loadEnvLocal } from '../lib.ts';

loadEnvLocal();
const api = apiFor('dev');
const s = await api.get(`/api/sessions/${process.argv[2]}`);
const title = new Map(s.proposals.map((p: any) => [p.id, p.title]));
const spans = s.activity.filter((a: any) => a.finishedAt && a.proposalId && a.kind !== 'fixture');
const byAgent = new Map<string, { model: number; tool: number; calls: number; first: number; last: number }>();
for (const a of spans) {
  const k = title.get(a.proposalId) as string;
  const e = byAgent.get(k) ?? { model: 0, tool: 0, calls: 0, first: Infinity, last: 0 };
  e[a.kind as 'model' | 'tool'] += a.finishedAt - a.startedAt;
  if (a.kind === 'model') e.calls++;
  e.first = Math.min(e.first, a.startedAt);
  e.last = Math.max(e.last, a.finishedAt);
  byAgent.set(k, e);
}
for (const [k, e] of byAgent) {
  console.log(`${k.padEnd(18)} model calls ${String(e.calls).padStart(3)}  model ${(e.model / 1000).toFixed(1)}s  tools ${(e.tool / 1000).toFixed(1)}s  window ${new Date(e.first).toISOString().slice(11, 19)}-${new Date(e.last).toISOString().slice(11, 19)}`);
}
// Sweep line over agent-level busy intervals (model or tool), counting distinct agents.
const points: Array<[number, number, string]> = [];
for (const a of spans) {
  points.push([a.startedAt, 1, a.proposalId], [a.finishedAt, -1, a.proposalId]);
}
points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
const active = new Map<string, number>();
let last = points[0]?.[0] ?? 0;
const overlap: Record<number, number> = {};
for (const [t, d, p] of points) {
  const agents = [...active.values()].filter((n) => n > 0).length;
  overlap[agents] = (overlap[agents] ?? 0) + (t - last);
  active.set(p, (active.get(p) ?? 0) + d);
  last = t;
}
console.log(`time with >=2 agents busy at once: ${(((overlap[2] ?? 0) + (overlap[3] ?? 0) + (overlap[4] ?? 0)) / 1000).toFixed(1)}s; with 3+: ${(((overlap[3] ?? 0) + (overlap[4] ?? 0)) / 1000).toFixed(1)}s`);
console.log(`model ${s.session.modelId}; spent ${(s.session.budget.spent / 1e6).toFixed(4)} USD, uncertain ${(s.session.budget.uncertain / 1e6).toFixed(4)} USD, reserved ${(s.session.budget.reserved / 1e6).toFixed(4)} USD, ceiling ${(s.session.budget.ceilingMicroUsd / 1e6).toFixed(2)} USD`);
