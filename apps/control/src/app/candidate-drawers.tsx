import { CHECKS } from '@converge/domain/catalog';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  CELL,
  cellState,
  checkTitle,
  CopyableId,
  describeFailure,
  formatDateTime,
  formatDuration,
  ObservationTable,
  parseSequence,
  proposalName,
  revisionIndex,
  SequenceTable,
  SheetBody,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StateIcon,
  StatusBadge,
  type SessionView,
} from '@converge/ui';
import { useQuery } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { useState } from 'react';
import { queryKeys, useApi, useCommand } from '../lib/hooks.ts';
import { EvidenceView } from './evidence.tsx';
import { ErrorNotice, LoadingBlock } from './feedback.tsx';
import { type PreviewGrant, PreviewButton } from './preview.tsx';

export function useCandidate(candidateId: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.candidate(candidateId), queryFn: () => api.getCandidate(candidateId) });
}

/** One check result. For a failed check this is the counterexample. */
export function CheckDrawerContent({ candidateId, checkId }: { candidateId: string; checkId: string }) {
  const q = useCandidate(candidateId);
  const [showRaw, setShowRaw] = useState(false);
  const def = CHECKS.find((c) => c.id === checkId);
  if (q.isPending) return <SheetBody><LoadingBlock label="The check result loads" rows={3} /></SheetBody>;
  if (q.isError) return <SheetBody><ErrorNotice error={q.error} onRetry={() => void q.refetch()} /></SheetBody>;
  const c = q.data;
  const attempts = c.checks.filter((k) => k.checkId === checkId).sort((a, b) => a.attemptNo - b.attemptNo);
  const latest = attempts.at(-1);
  const state = cellState(latest, c.state);
  const observations = latest?.result?.observations ?? [];
  const failure = describeFailure(observations);
  const steps = parseSequence(observations);
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {state === 'failed' ? 'Counterexample: ' : ''}
          {checkTitle(checkId)}
        </SheetTitle>
        <SheetDescription render={<div />}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1 font-medium">
              <StateIcon style={CELL[state]} className="size-3.5" /> {CELL[state].label}
            </span>
            <span>on {c.label}</span>
            <span className="inline-flex items-center gap-1">
              head <CopyableId value={c.headSha} label="Copy candidate head" />
            </span>
          </span>
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        {def && <p className="text-sm text-muted-foreground">{def.description}</p>}
        {!latest && <p className="text-sm text-muted-foreground">This check has not run on this candidate.</p>}
        {latest && !latest.applicable && (
          <Alert>
            <StateIcon style={CELL.skipped} />
            <div>
              <AlertTitle>Not applicable</AlertTitle>
              <AlertDescription>{latest.applicabilityReason}. A skipped check is not a pass.</AlertDescription>
            </div>
          </Alert>
        )}
        {failure && (
          <Alert tone="danger">
            <StateIcon style={CELL.failed} />
            <div>
              <AlertTitle>A reproducible failure was found</AlertTitle>
              <AlertDescription>
                <p className="text-foreground">Observed: {failure}.</p>
              </AlertDescription>
            </div>
          </Alert>
        )}
        {latest?.result && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Assertions</dt>
              <dd>
                {latest.assertionCount - latest.failedCount} of {latest.assertionCount} passed
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Attempt</dt>
              <dd>{latest.attemptNo}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Ran at</dt>
              <dd>{formatDateTime(latest.result.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{formatDuration(latest.result.finishedAt - latest.result.startedAt)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Harness digest</dt>
              <dd>
                <CopyableId value={latest.result.harnessDigest} label="Copy harness digest" />
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Manifest digest</dt>
              <dd>
                <CopyableId value={latest.result.candidateManifestDigest} label="Copy manifest digest" />
              </dd>
            </div>
          </dl>
        )}
        {steps.length > 0 && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">Request sequence</h4>
            <SequenceTable steps={steps} />
          </section>
        )}
        {observations.length > 0 && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">All observations, failed first</h4>
            <ObservationTable observations={[...observations].sort((a, b) => Number(a.passed) - Number(b.passed))} />
          </section>
        )}
        {attempts.length > 1 && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">Earlier attempts stay in the record</h4>
            <ul className="text-xs">
              {attempts.slice(0, -1).map((a) => (
                <li key={a.id}>
                  Attempt {a.attemptNo}: {a.status} ({a.failedCount} failed of {a.assertionCount})
                </li>
              ))}
            </ul>
          </section>
        )}
        {latest?.evidenceId && (
          <section>
            <button type="button" onClick={() => setShowRaw((v) => !v)} className="cursor-pointer text-xs text-primary hover:underline" aria-expanded={showRaw}>
              {showRaw ? 'Hide raw evidence' : 'Show raw evidence'}
            </button>
            {showRaw && (
              <div className="mt-2">
                <EvidenceView evidenceId={latest.evidenceId} />
              </div>
            )}
          </section>
        )}
      </SheetBody>
    </>
  );
}

/** A candidate: membership, exact head, checks, and the next actions. */
export function CandidateDrawerContent({
  candidateId,
  view,
  onOpenCheck,
  onPreview,
}: {
  candidateId: string;
  view: SessionView;
  onOpenCheck: (checkId: string) => void;
  onPreview: (g: PreviewGrant) => void;
}) {
  const q = useCandidate(candidateId);
  const repair = useCommand<{ proposalId: string }>(`repair:${candidateId}`);
  if (q.isPending) return <SheetBody><LoadingBlock label="The candidate loads" rows={3} /></SheetBody>;
  if (q.isError) return <SheetBody><ErrorNotice error={q.error} onRetry={() => void q.refetch()} /></SheetBody>;
  const c = q.data;
  const revs = revisionIndex(view);
  const hasRepair = view.proposals.some((p) => p.kind === 'repair' && p.baseCandidateId === c.id);
  const runRepair = () => repair.mutate({ path: `/api/candidates/${c.id}/repair` });
  return (
    <>
      <SheetHeader>
        <SheetTitle>{c.label}</SheetTitle>
        <SheetDescription render={<div />}>
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="candidate" value={c.state} />
            {c.fullGoal && <Badge tone="accent">Full goal</Badge>}
            {c.promotable && <Badge tone="success">Promotable</Badge>}
          </span>
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex items-center gap-1">
            <dt className="text-muted-foreground">Head</dt>
            <dd>
              <CopyableId value={c.headSha} short={false} label="Copy candidate head" />
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-muted-foreground">Expected main</dt>
            <dd>
              <CopyableId value={c.expectedMainSha} label="Copy expected main" />
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-muted-foreground">Manifest</dt>
            <dd>
              <CopyableId value={c.manifestDigest} label="Copy manifest digest" />
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-muted-foreground">Validation</dt>
            <dd>{c.validationDigest ? <CopyableId value={c.validationDigest} label="Copy validation digest" /> : <span className="text-muted-foreground">not frozen</span>}</dd>
          </div>
        </dl>
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Members in merge order</h4>
          {c.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes. This is the baseline.</p>
          ) : (
            <ol className="flex flex-col gap-1 text-xs">
              {c.members.map((m) => {
                const r = revs.get(m);
                return (
                  <li key={m} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
                    <span className="font-medium">{r ? `${proposalName(r.proposal)} r${r.revision.revisionNo}` : m}</span>
                    <CopyableId value={r?.revision.headSha} label="Copy revision head" />
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Checks</h4>
          <ul className="flex flex-col gap-1">
            {CHECKS.map((k) => {
              const run = c.checks.filter((x) => x.checkId === k.id).at(-1);
              const st = cellState(run, c.state);
              return (
                <li key={k.id}>
                  <button type="button" onClick={() => onOpenCheck(k.id)} className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-muted">
                    <span>{k.title}</span>
                    <span className="inline-flex items-center gap-1">
                      <StateIcon style={CELL[st]} className="size-3.5" /> {CELL[st].label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        <div className="flex flex-wrap items-start gap-2">
          <PreviewButton candidate={c} onOpen={onPreview} size="default" />
          {c.state === 'failed' && !hasRepair && (
            <Button variant="outline" onClick={runRepair} disabled={repair.isPending}>
              <Wrench aria-hidden /> {repair.isPending ? 'Request sent…' : 'Request repair'}
            </Button>
          )}
        </div>
        <ErrorNotice error={repair.error} onDismiss={() => repair.reset()} onRetry={runRepair} />
        {repair.isSuccess && <p className="text-sm text-success">Repair requested. A repair agent card appears when it starts.</p>}
      </SheetBody>
    </>
  );
}
