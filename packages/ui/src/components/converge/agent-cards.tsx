import { Bot, ChevronRight, Cpu, FlaskConical, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatAgo, formatValue } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';
import { proposalName, type SessionView, type ViewActivity, type ViewProposal } from '../../lib/view.ts';
import { Badge, Card } from '../ui/primitives.tsx';
import { CopyableId } from './copy.tsx';
import { StatusBadge } from './status.tsx';

export interface ActivityState {
  text: string;
  tone: 'neutral' | 'accent' | 'success' | 'danger' | 'warning';
  kind?: string;
}

/** Real activity state from the job and the open activity span. */
export function activityState(p: ViewProposal, activity: readonly ViewActivity[], now: number): ActivityState {
  const mine = activity.filter((a) => a.proposalId === p.id);
  const open = [...mine].reverse().find((a) => a.finishedAt === null);
  const last = mine.length ? mine.reduce((a, b) => (Math.max(b.startedAt, b.finishedAt ?? 0) > Math.max(a.startedAt, a.finishedAt ?? 0) ? b : a)) : null;
  const job = p.job;
  if (job && (job.status === 'failed' || job.status === 'expired')) {
    return { text: `Agent failed${job.errorCode ? `: ${job.errorCode}` : ''}`, tone: 'danger' };
  }
  if (p.status === 'blocked') return { text: 'Agent blocked', tone: 'danger' };
  if (open && (!job || job.status === 'running' || job.status === 'leased')) {
    if (open.kind === 'model') return { text: `Model call in progress (${open.label})`, tone: 'accent', kind: 'model' };
    if (open.kind === 'tool') return { text: `Tool in progress: ${open.label}`, tone: 'accent', kind: 'tool' };
    return { text: `Fixture step in progress: ${open.label}`, tone: 'accent', kind: 'fixture' };
  }
  if (job?.status === 'queued') return { text: 'Queued', tone: 'neutral' };
  if (job?.status === 'running' || job?.status === 'leased') {
    return { text: last ? `Running · last activity ${formatAgo(last.finishedAt ?? last.startedAt, now)}` : 'Running', tone: 'accent' };
  }
  if (job?.status === 'cancelled' || p.status === 'cancelled') return { text: 'Cancelled', tone: 'neutral' };
  if (p.status === 'sealed') return { text: 'Finished and sealed', tone: 'success' };
  if (job?.status === 'succeeded') return { text: 'Finished', tone: 'success' };
  if (!job && p.status === 'pending') return { text: 'Not started', tone: 'neutral' };
  return { text: p.status, tone: 'neutral' };
}

const TONE_TEXT: Record<ActivityState['tone'], string> = {
  neutral: 'text-muted-foreground',
  accent: 'text-info',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
};

function ActivityIcon({ kind }: { kind?: string }) {
  if (kind === 'model') return <Cpu className="size-3.5" aria-hidden />;
  if (kind === 'tool') return <Wrench className="size-3.5" aria-hidden />;
  if (kind === 'fixture') return <FlaskConical className="size-3.5" aria-hidden />;
  return <Bot className="size-3.5" aria-hidden />;
}

export function AgentCard({
  proposal: p,
  view,
  now,
  onOpen,
  actions,
}: {
  proposal: ViewProposal;
  view: Pick<SessionView, 'activity'>;
  now: number;
  onOpen?: (proposalId: string) => void;
  actions?: ReactNode;
}) {
  const act = activityState(p, view.activity, now);
  const head = p.revisions.length ? p.revisions[p.revisions.length - 1]! : null;
  const intent = p.intent;
  return (
    <Card className={cn('flex min-w-0 flex-col', act.tone === 'danger' && 'border-danger/40')}>
      <div className="flex items-start justify-between gap-2 px-3.5 pt-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{p.kind === 'repair' ? 'Repair agent' : `${proposalName(p)} agent`}</p>
          <h3 className="truncate text-sm font-semibold">
            {onOpen ? (
              <button type="button" onClick={() => onOpen(p.id)} className="cursor-pointer text-left hover:underline focus-visible:underline">
                {p.title}
              </button>
            ) : (
              p.title
            )}
          </h3>
        </div>
        <StatusBadge kind="proposal" value={p.status} />
      </div>
      <div className="flex flex-1 flex-col gap-2.5 px-3.5 py-2.5 text-xs">
        <p className="line-clamp-2 text-muted-foreground">{intent?.objective ?? p.objective ?? 'No intent declared yet.'}</p>
        {intent && intent.contractChanges.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Declares</p>
            <ul className="flex flex-col gap-1">
              {intent.contractChanges.map((c) => (
                <li key={c.key} className="font-mono text-[11px] leading-4">
                  {c.key}: {formatValue(c.before)} → <span className="text-foreground">{formatValue(c.after)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {intent && intent.assumptions.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Assumes</p>
            <ul className="flex flex-col gap-1">
              {intent.assumptions.map((a) => (
                <li key={`${a.key}-${a.operator}`} className="font-mono text-[11px] leading-4">
                  {a.key} {a.operator.replace('_', ' ')} {formatValue(a.expected)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.progress && (
          <div>
            <p className="mb-0.5 font-medium">Latest progress</p>
            <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground">
              {p.progress.message} <span className="whitespace-nowrap">· {formatAgo(p.progress.at, now)}</span>
            </p>
          </div>
        )}
        <p className={cn('flex items-center gap-1.5 font-medium', TONE_TEXT[act.tone])}>
          <ActivityIcon kind={act.kind} />
          {act.text}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3.5 py-2 text-xs">
        {head ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Badge tone="outline">r{head.revisionNo}</Badge>
            <CopyableId value={head.headSha} label="Copy revision head SHA" />
          </span>
        ) : (
          <span className="text-muted-foreground">No sealed revision</span>
        )}
        <span className="flex items-center gap-1">
          {actions}
          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-primary hover:underline"
              aria-label={`Open details for ${p.title}`}
            >
              Details <ChevronRight className="size-3.5" aria-hidden />
            </button>
          )}
        </span>
      </div>
    </Card>
  );
}

export function AgentCards({
  view,
  now,
  onOpen,
  renderActions,
}: {
  view: Pick<SessionView, 'proposals' | 'activity'>;
  now: number;
  onOpen?: (proposalId: string) => void;
  renderActions?: (p: ViewProposal) => ReactNode;
}) {
  const features = view.proposals.filter((p) => p.kind === 'feature');
  const repairs = view.proposals.filter((p) => p.kind === 'repair');
  if (view.proposals.length === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No agents are assigned to this session yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {features.map((p) => (
          <AgentCard key={p.id} proposal={p} view={view} now={now} onOpen={onOpen} actions={renderActions?.(p)} />
        ))}
      </div>
      {repairs.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {repairs.map((p) => (
            <AgentCard key={p.id} proposal={p} view={view} now={now} onOpen={onOpen} actions={renderActions?.(p)} />
          ))}
        </div>
      )}
    </div>
  );
}
