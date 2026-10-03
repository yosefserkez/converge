import {
  Alert,
  AlertDescription,
  AlertTitle,
  BudgetSummary,
  Button,
  CopyableId,
  formatAgo,
  formatCountdown,
  ModeBadge,
  StatusBadge,
  budgetExhausted,
  isActive,
  sessionOutcome,
  type SessionView,
} from '@converge/ui';
import { Ban, CircleCheck, CloudOff, LoaderCircle, Play, Wallet, Wifi } from 'lucide-react';
import { type Connection, useCommand } from '../lib/hooks.ts';
import { ErrorNotice } from './feedback.tsx';
import { PublishReplay } from './publish-replay.tsx';

export function ConnectionStatus({ connection, onRetry, now }: { connection: Connection; onRetry: () => void; now: number }) {
  if (connection.state === 'retrying') {
    return (
      <span role="status" className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
        <CloudOff className="size-3.5" aria-hidden />
        Disconnected, retrying{connection.nextRetryAt ? ` in ${formatCountdown(connection.nextRetryAt - now)}` : ''}
        <button type="button" onClick={onRetry} className="cursor-pointer text-primary underline-offset-2 hover:underline">
          Retry now
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Wifi className={connection.state === 'live' ? 'size-3.5 text-success' : 'size-3.5'} aria-hidden />
      {connection.state === 'connecting' ? 'Connection starts' : connection.state === 'live' ? 'Live: updates every 1 s' : 'Idle, slower updates'}
      {connection.lastOkAt ? ` · updated ${formatAgo(connection.lastOkAt, now)}` : ''}
    </span>
  );
}

export function SessionHeader({ view, connection, onRetry, now, previewOrigin }: { view: SessionView; connection: Connection; onRetry: () => void; now: number; previewOrigin: string | null }) {
  const s = view.session;
  const id = s.id!;
  const start = useCommand(`start:${id}`);
  const cancel = useCommand(`cancel:${id}`);
  const jobsInFlight = view.jobs.some((j) => j.status === 'queued' || j.status === 'leased' || j.status === 'running');
  const cancelling = (s.status === 'cancelled' && jobsInFlight) || (cancel.isSuccess && s.status !== 'cancelled') || cancel.isPending;
  const canCancel = isActive(s.status) || s.status === 'ready';
  const exhausted = budgetExhausted(view);
  const outcome = sessionOutcome(view);
  const failedAgents = view.proposals.filter((p) => p.job && (p.job.status === 'failed' || p.job.status === 'expired'));

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <ModeBadge mode={s.mode} />
            <StatusBadge kind="session" value={s.status} />
            <ConnectionStatus connection={connection} onRetry={onRetry} now={now} />
          </div>
          <h1 className="text-lg leading-snug font-semibold">{outcome}</h1>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{s.objective}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              Session <CopyableId value={id} short={false} label="Copy session ID" />
            </span>
            <span className="inline-flex items-center gap-1">
              Baseline <CopyableId value={s.baselineSha} label="Copy baseline SHA" />
            </span>
            {s.modelId && s.mode === 'live' && (
              <span>
                Model <code className="font-mono">{s.modelId}</code>
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex flex-wrap gap-2">
            {s.status === 'created' && (
              <Button onClick={() => start.mutate({ path: `/api/sessions/${id}/start` })} disabled={start.isPending}>
                <Play aria-hidden /> {start.isPending ? 'Start sent…' : 'Start agents'}
              </Button>
            )}
            {canCancel && !cancelling && s.status !== 'cancelled' && (
              <Button variant="destructive" onClick={() => cancel.mutate({ path: `/api/sessions/${id}/cancel` })}>
                <Ban aria-hidden /> Cancel session
              </Button>
            )}
            {!isActive(s.status) && !cancelling && previewOrigin !== null && <PublishReplay sessionId={id} previewOrigin={previewOrigin} status={s.status} />}
          </div>
          <BudgetSummary budget={s.budget} mode={s.mode} />
        </div>
      </div>
      <ErrorNotice error={start.error} onDismiss={() => start.reset()} onRetry={() => start.mutate({ path: `/api/sessions/${id}/start` })} />
      <ErrorNotice error={cancel.error} onDismiss={() => cancel.reset()} onRetry={() => cancel.mutate({ path: `/api/sessions/${id}/cancel` })} />
      {cancelling && (
        <Alert tone="warning">
          <LoaderCircle className="motion-safe:animate-spin" aria-hidden />
          <div>
            <AlertTitle>Cancellation in progress</AlertTitle>
            <AlertDescription>Converge recorded the cancellation. Running jobs stop at their next safe point. This page updates when they stop.</AlertDescription>
          </div>
        </Alert>
      )}
      {exhausted && (
        <Alert tone="danger">
          <Wallet aria-hidden />
          <div>
            <AlertTitle>Model budget exhausted</AlertTitle>
            <AlertDescription>
              No new model calls start in this session. Finished revisions and evidence stay valid. Create a new session with a larger ceiling to continue.
            </AlertDescription>
          </div>
        </Alert>
      )}
      {failedAgents.length > 0 && !exhausted && (
        <Alert tone="danger">
          <CloudOff aria-hidden />
          <div>
            <AlertTitle>{failedAgents.length === 1 ? `The ${failedAgents[0]!.title} agent failed` : `${failedAgents.length} agents failed`}</AlertTitle>
            <AlertDescription>Open the agent card to see the error. Use “Retry agent” to start a new attempt with the same inputs.</AlertDescription>
          </div>
        </Alert>
      )}
      {s.reason && (s.status === 'needs_attention' || s.status === 'failed') && (
        <p className="text-sm">
          <span className="font-medium">Reason:</span> {s.reason}
        </p>
      )}
      {s.status === 'promoted' && (
        <Alert tone="success">
          <CircleCheck aria-hidden />
          <div>
            <AlertTitle>Promoted</AlertTitle>
            <AlertDescription>Main now equals the approved commit. See the final review below.</AlertDescription>
          </div>
        </Alert>
      )}
    </header>
  );
}
