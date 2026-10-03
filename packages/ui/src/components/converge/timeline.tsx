import { formatClock, formatDuration } from '../../lib/format.ts';
import { maxConcurrency } from '../../lib/timeline.ts';
import { cn } from '../../lib/utils.ts';
import { proposalName, type SessionView, type ViewActivity } from '../../lib/view.ts';

const KIND_CLASS: Record<string, string> = {
  model: 'bg-primary text-primary-foreground',
  tool: 'bg-foreground/45 text-background',
  fixture: 'fixture-hatch bg-warning-soft text-warning border border-warning/50',
};

const KIND_LABEL: Record<string, string> = { model: 'Model call', tool: 'Tool call', fixture: 'Fixture step (no model call)' };

export function ConcurrencyTimeline({ view, now }: { view: Pick<SessionView, 'activity' | 'proposals' | 'session'>; now: number }) {
  const spans = view.activity;
  if (spans.length === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No agent activity recorded yet.</p>;
  }
  const endOf = (a: ViewActivity) => a.finishedAt ?? view.session.finishedAt ?? now;
  const start = Math.min(...spans.map((a) => a.startedAt));
  const end = Math.max(start + 1000, ...spans.map(endOf));
  const total = end - start;
  const pct = (t: number) => ((t - start) / total) * 100;
  const lanes = [
    ...view.proposals.map((p) => ({ id: p.id as string | null, name: proposalName(p), title: p.title })),
    ...(spans.some((a) => a.proposalId === null) ? [{ id: null, name: 'Platform', title: 'Platform jobs' }] : []),
  ].filter((l) => spans.some((a) => a.proposalId === l.id));
  const peak = maxConcurrency(spans.map((a) => ({ lane: a.proposalId ?? 'platform', start: a.startedAt, end: endOf(a) })));
  const kinds = [...new Set(spans.map((a) => a.kind))];
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="font-medium">
          {peak > 1 ? `Up to ${peak} agents worked at the same time` : 'Agents did not overlap in this window'}
          <span className="font-normal text-muted-foreground"> · {formatDuration(total)} of real time</span>
        </p>
        <ul className="flex flex-wrap items-center gap-3 text-muted-foreground" aria-label="Legend">
          {kinds.map((k) => (
            <li key={k} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('inline-block h-2.5 w-5 rounded-sm', KIND_CLASS[k] ?? 'bg-muted-foreground')} />
              {KIND_LABEL[k] ?? k}
            </li>
          ))}
        </ul>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card p-3">
        <div className="min-w-[560px]">
          <div className="relative ml-28 h-4 text-[10px] text-muted-foreground" aria-hidden>
            {ticks.map((t) => (
              <span
                key={t}
                className={cn('absolute top-0 whitespace-nowrap', t === 1 ? '-translate-x-full' : t > 0 && '-translate-x-1/2')}
                style={{ left: `${t * 100}%` }}
              >
                {t === 0 ? formatClock(start) : `+${formatDuration(total * t)}`}
              </span>
            ))}
          </div>
          <ul className="flex flex-col gap-1.5">
            {lanes.map((lane) => {
              const laneSpans = spans.filter((a) => a.proposalId === lane.id);
              return (
                <li key={lane.id ?? 'platform'} className="flex items-center gap-2">
                  <span className="w-26 shrink-0 truncate text-xs font-medium" title={lane.title}>
                    {lane.name}
                  </span>
                  <div className="relative h-6 flex-1 rounded bg-muted/50" role="list" aria-label={`${lane.title} activity`}>
                    {ticks.slice(1, -1).map((t) => (
                      <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${t * 100}%` }} />
                    ))}
                    {laneSpans.map((a, idx) => {
                      const left = pct(a.startedAt);
                      const width = Math.max(pct(endOf(a)) - left, 0.4);
                      const open = a.finishedAt === null;
                      const text = `${KIND_LABEL[a.kind] ?? a.kind}: ${a.label}. ${formatClock(a.startedAt)}${open ? ', still open' : ` to ${formatClock(a.finishedAt!)}, ${formatDuration(a.finishedAt! - a.startedAt)}`}`;
                      return (
                        <div
                          key={a.id ?? `${a.startedAt}-${idx}`}
                          role="listitem"
                          aria-label={text}
                          title={text}
                          className={cn(
                            'absolute top-0.5 bottom-0.5 overflow-hidden rounded-sm px-1 text-[10px] leading-5 whitespace-nowrap',
                            KIND_CLASS[a.kind] ?? 'bg-muted-foreground',
                            open && 'motion-safe:animate-pulse',
                          )}
                          style={{ left: `${left}%`, width: `${width}%`, minWidth: 3 }}
                        >
                          {width > 9 ? (a.kind === 'fixture' ? `Fixture: ${a.label}` : a.label) : ''}
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Times are real recorded timestamps. Each lane is one agent; overlap means concurrent work.</p>
    </div>
  );
}
