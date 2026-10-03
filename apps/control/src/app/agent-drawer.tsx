import {
  Badge,
  CopyableId,
  formatClock,
  formatDateTime,
  formatDuration,
  IntentDetails,
  NativeSelect,
  SheetBody,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type SessionView,
  type ViewProposal,
} from '@converge/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys, useApi } from '../lib/hooks.ts';
import { EvidenceView } from './evidence.tsx';
import { ErrorNotice, LoadingBlock } from './feedback.tsx';

const LOG_LIMIT = 200;

function IntentTab({ proposal }: { proposal: ViewProposal }) {
  const api = useApi();
  const q = useQuery({ queryKey: queryKeys.proposal(proposal.id), queryFn: () => api.getProposal(proposal.id) });
  const [version, setVersion] = useState<number | null>(null);
  if (q.isPending) return <LoadingBlock label="The intent history loads" rows={2} />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const intents = q.data.intents;
  if (intents.length === 0) return <p className="text-sm text-muted-foreground">The agent has not declared an intent yet.</p>;
  const selected = intents.find((i) => i.version === version) ?? intents[intents.length - 1]!;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="intent-version" className="font-medium">
          Intent version
        </label>
        <NativeSelect id="intent-version" className="w-auto" value={selected.version} onChange={(e) => setVersion(Number(e.target.value))}>
          {intents.map((i) => (
            <option key={i.version} value={i.version}>
              v{i.version} · {formatDateTime(i.createdAt)}
              {i.version === intents[intents.length - 1]!.version ? ' (latest)' : ''}
            </option>
          ))}
        </NativeSelect>
        <CopyableId value={selected.digest} label="Copy intent digest" />
      </div>
      <IntentDetails intent={selected.intent} />
    </div>
  );
}

function ChangesTab({ proposal }: { proposal: ViewProposal }) {
  const [openDiff, setOpenDiff] = useState<string | null>(proposal.revisions.at(-1)?.diffEvidenceId ?? null);
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Changed paths (declared)</h4>
        <ul className="font-mono text-xs">
          {(proposal.intent?.affectedPaths ?? []).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">Editable paths: {proposal.editablePaths.join(', ')}</p>
      </section>
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Sealed revisions</h4>
        {proposal.revisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sealed revision yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {proposal.revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                <Badge tone="outline">r{r.revisionNo}</Badge>
                head <CopyableId value={r.headSha} label="Copy revision head" />
                base <CopyableId value={r.baseSha} label="Copy revision base" />
                <span className="text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                {r.diffEvidenceId && (
                  <button type="button" className="ml-auto cursor-pointer text-primary hover:underline" onClick={() => setOpenDiff(r.diffEvidenceId!)} aria-pressed={openDiff === r.diffEvidenceId}>
                    Show diff
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {openDiff && (
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Diff evidence</h4>
          <EvidenceView evidenceId={openDiff} diff />
        </section>
      )}
    </div>
  );
}

function LogsTab({ proposal, view }: { proposal: ViewProposal; view: SessionView }) {
  const api = useApi();
  const sessionId = view.session.id!;
  const q = useQuery({
    queryKey: [...queryKeys.log(sessionId), view.watermark],
    queryFn: () => api.getEvents(sessionId, 0, 500),
  });
  const spans = view.activity.filter((a) => a.proposalId === proposal.id);
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Events (latest {LOG_LIMIT})</h4>
        {q.isPending && <LoadingBlock label="Events load" rows={1} />}
        {q.isError && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (
          <ol className="max-h-[40vh] overflow-y-auto rounded-md border font-mono text-xs">
            {q.data.events
              .filter((e) => e.entityId === proposal.id)
              .slice(-LOG_LIMIT)
              .map((e) => (
                <li key={e.seq} className="flex gap-2 border-b px-2.5 py-1 last:border-b-0">
                  <span className="shrink-0 text-muted-foreground">{formatClock(e.createdAt)}</span>
                  <span className="shrink-0 font-semibold">{e.type}</span>
                  <span className="min-w-0 break-words whitespace-pre-wrap text-muted-foreground">
                    {typeof e.payload.message === 'string' ? e.payload.message : JSON.stringify(e.payload).slice(0, 400)}
                  </span>
                </li>
              ))}
          </ol>
        )}
        {q.data?.hasMore && <p className="mt-1 text-xs text-muted-foreground">More than 500 session events exist. The list shows the first 500.</p>}
      </section>
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Activity spans ({spans.length})</h4>
        <ol className="max-h-[30vh] overflow-y-auto rounded-md border font-mono text-xs">
          {spans.slice(-LOG_LIMIT).map((a, i) => (
            <li key={a.id ?? i} className="flex gap-2 border-b px-2.5 py-1 last:border-b-0">
              <span className="shrink-0 text-muted-foreground">{formatClock(a.startedAt)}</span>
              <span className="shrink-0">{a.kind === 'fixture' ? 'fixture (no model call)' : a.kind}</span>
              <span className="min-w-0 truncate">{a.label}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{a.finishedAt ? formatDuration(a.finishedAt - a.startedAt) : 'open'}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function AgentDrawerContent({ proposal, view }: { proposal: ViewProposal; view: SessionView }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{proposal.title}</SheetTitle>
        <SheetDescription render={<div />}>
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="proposal" value={proposal.status} />
            {proposal.job && <StatusBadge kind="job" value={proposal.job.status} label={`Job attempt ${proposal.job.attemptNo}: ${proposal.job.status}`} />}
            {proposal.job?.errorCode && <code className="font-mono text-xs text-danger">{proposal.job.errorCode}</code>}
          </span>
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        {proposal.summary && <p className="mb-3 text-sm">{proposal.summary}</p>}
        <Tabs defaultValue="intent">
          <TabsList>
            <TabsTrigger value="intent">Intent</TabsTrigger>
            <TabsTrigger value="changes">Changes</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="intent">
            <IntentTab proposal={proposal} />
          </TabsContent>
          <TabsContent value="changes">
            <ChangesTab proposal={proposal} />
          </TabsContent>
          <TabsContent value="logs">
            <LogsTab proposal={proposal} view={view} />
          </TabsContent>
        </Tabs>
      </SheetBody>
    </>
  );
}
