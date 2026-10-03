import { CHECKS } from '@converge/domain/catalog';
import {
  AgentCards,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  BudgetSummary,
  CELL,
  ConcurrencyTimeline,
  CopyableId,
  formatClock,
  formatDateTime,
  formatDuration,
  fromReplay,
  IntegrationMatrix,
  IntentDetails,
  InteractionReview,
  ModeBadge,
  ObservationTable,
  revisionIndex,
  proposalName,
  reviewCandidate,
  SectionHeading,
  sessionOutcome,
  SequenceTable,
  parseSequence,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  shortSha,
  Skeleton,
  StateIcon,
  StatusBadge,
  type CellSelection,
  type PublicReplay,
  type SessionView,
  type StoryLink,
} from '@converge/ui';
import { CircleAlert, Eye, FlaskConical, History, Rocket } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

// Read-only public replay. It reads only GET /api/replays/:id on this origin.
// It never calls control-plane routes, starts work, or allocates resources.

type Load = { state: 'loading' } | { state: 'error'; message: string; notFound: boolean } | { state: 'ready'; replay: PublicReplay; sample: boolean };

function replayIdFromPath(): string | null {
  const m = /^\/replay\/([A-Za-z0-9_-]{1,64})\/?$/.exec(window.location.pathname);
  return m ? m[1]! : null;
}

function useReplay(): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    const id = replayIdFromPath();
    const sample = new URLSearchParams(window.location.search).has('sample') || id === 'sample';
    let cancelled = false;
    (async () => {
      if (sample) {
        const mod = await import('@converge/ui/sample');
        if (!cancelled) setLoad({ state: 'ready', replay: mod.sampleReplay('promoted'), sample: true });
        return;
      }
      if (!id) {
        setLoad({ state: 'error', message: 'This address does not name a replay. A replay link looks like /replay/rpl_….', notFound: true });
        return;
      }
      try {
        const res = await fetch(`/api/replays/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
        if (res.status === 404) throw Object.assign(new Error('No published replay has this ID. Check the link.'), { notFound: true });
        if (!res.ok) throw new Error(`The replay service answered with status ${res.status}. Try again soon.`);
        const replay = (await res.json()) as PublicReplay;
        if (replay.schemaVersion !== 1) throw new Error('This replay uses a format this viewer does not support.');
        if (!cancelled) setLoad({ state: 'ready', replay, sample: false });
      } catch (e) {
        if (cancelled) return;
        const notFound = Boolean((e as { notFound?: boolean }).notFound);
        const message = e instanceof TypeError ? 'The replay service did not respond. Check the connection and reload.' : e instanceof Error ? e.message : String(e);
        setLoad({ state: 'error', message, notFound });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return load;
}

type Panel = { kind: 'agent'; proposalId: string } | { kind: 'check'; candidateId: string; checkId: string } | { kind: 'candidate'; candidateId: string };

function CheckPanel({ view, candidateId, checkId }: { view: SessionView; candidateId: string; checkId: string }) {
  const c = view.candidates.find((x) => x.id === candidateId);
  const check = c?.checks.find((k) => k.checkId === checkId);
  const def = CHECKS.find((k) => k.id === checkId);
  const interaction = view.interactions.find((i) => i.failedCandidateId === candidateId && i.failedCheck?.checkId === checkId);
  const observations = interaction?.failedCheck?.observations ?? [];
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {check?.status === 'failed' ? 'Counterexample: ' : ''}
          {def?.title ?? checkId}
        </SheetTitle>
        <SheetDescription>on {c?.label ?? candidateId}</SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-3 text-sm">
        {def && <p className="text-muted-foreground">{def.description}</p>}
        {check && (
          <p>
            Status: <span className="font-medium">{check.applicable ? check.status : `not applicable (${check.applicabilityReason})`}</span>
            {check.assertionCount > 0 && ` · ${check.assertionCount - check.failedCount} of ${check.assertionCount} assertions passed`}
          </p>
        )}
        {observations.length > 0 ? (
          <>
            <SequenceTable steps={parseSequence(observations)} />
            <ObservationTable observations={observations} />
          </>
        ) : (
          <p className="text-muted-foreground">The public replay keeps observations only for the check that confirmed an interaction.</p>
        )}
      </SheetBody>
    </>
  );
}

function CandidatePanel({ view, candidateId }: { view: SessionView; candidateId: string }) {
  const c = view.candidates.find((x) => x.id === candidateId);
  if (!c) return null;
  const revs = revisionIndex(view);
  return (
    <>
      <SheetHeader>
        <SheetTitle>{c.label}</SheetTitle>
        <SheetDescription render={<div />}>
          <StatusBadge kind="candidate" value={c.state} />
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-3 text-sm">
        <p className="flex items-center gap-1 text-xs">
          Head <CopyableId value={c.headSha} short={false} label="Copy candidate head" />
        </p>
        <ol className="flex flex-col gap-1 text-xs">
          {c.members.map((m) => {
            const r = revs.get(m);
            return (
              <li key={m} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
                <span className="font-medium">{r ? `${proposalName(r.proposal)} r${r.revision.revisionNo}` : m}</span>
                <CopyableId value={r?.revision.headSha} />
              </li>
            );
          })}
        </ol>
      </SheetBody>
    </>
  );
}

function ReplayView({ replay, sample }: { replay: PublicReplay; sample: boolean }) {
  const view = useMemo(() => fromReplay(replay), [replay]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const s = view.session;
  const end = s.finishedAt ?? Math.max(s.createdAt, ...view.activity.map((a) => a.finishedAt ?? a.startedAt));
  const panelProposal = panel?.kind === 'agent' ? view.proposals.find((p) => p.id === panel.proposalId) : undefined;
  const finalCandidate = reviewCandidate(view);
  const promotion = view.promotions.find((p) => p.state === 'succeeded') ?? view.promotions.at(-1);
  const approval = view.approvals.at(-1);
  const openLink = (l: StoryLink) => {
    if (l.kind === 'intent') setPanel({ kind: 'agent', proposalId: l.proposalId });
    else if (l.kind === 'check') setPanel({ kind: 'check', candidateId: l.candidateId, checkId: l.checkId });
    else setPanel({ kind: 'candidate', candidateId: l.candidateId });
  };

  return (
    <div className="flex min-h-dvh flex-col">
      {sample && (
        <div role="note" className="flex items-center gap-2 border-b border-warning/40 bg-warning-soft px-4 py-1.5 text-xs">
          <FlaskConical className="size-3.5 text-warning" aria-hidden />
          <span className="font-semibold text-warning">Sample data</span>
          <span className="text-muted-foreground">This replay is built-in sample data, not a recording.</span>
        </div>
      )}
      <div className="border-b bg-sidebar">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs md:px-6">
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="inline-block size-4 rounded bg-primary" /> Converge
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Eye className="size-3.5" aria-hidden /> Read-only replay. Nothing on this page starts work.
          </span>
        </div>
      </div>
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-5 md:px-6">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <ModeBadge mode={replay.originalMode} replay />
            <StatusBadge kind="session" value={s.status} />
          </div>
          <h1 className="text-lg font-semibold">{sessionOutcome(view)}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{s.objective}</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <div>
                <dt className="text-muted-foreground">Recorded</dt>
                <dd>{formatDateTime(replay.recordedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Published</dt>
                <dd>{formatDateTime(replay.publishedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Original mode</dt>
                <dd>{replay.originalMode === 'live' ? `Live agents${s.modelId ? ` (${s.modelId})` : ''}` : 'Fixture agents - no model calls'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Duration</dt>
                <dd>{formatDuration(end - s.createdAt)} real time</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Baseline</dt>
                <dd>
                  <CopyableId value={s.baselineSha} label="Copy baseline SHA" />
                </dd>
              </div>
            </dl>
            {replay.originalMode === 'live' && <BudgetSummary budget={s.budget} mode={replay.originalMode} />}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <History className="size-3.5" aria-hidden /> All times are real recorded timestamps. This replay shows the final state; it does not compress or replay time.
          </p>
        </header>

        <section aria-labelledby="r-agents">
          <SectionHeading id="r-agents" title="Agents" description="Assignment, declared contract changes, and assumptions." />
          <AgentCards view={view} now={end} onOpen={(id) => setPanel({ kind: 'agent', proposalId: id })} />
        </section>

        <section aria-labelledby="r-matrix">
          <SectionHeading id="r-matrix" title="Integration matrix" description="Candidate combinations and protected checks. A skipped check is not a pass." />
          <IntegrationMatrix view={view} onSelectCell={(sel: CellSelection) => setPanel({ kind: 'check', candidateId: sel.candidate.id, checkId: sel.checkId })} />
        </section>

        <section aria-labelledby="r-interaction">
          <SectionHeading id="r-interaction" title="Interaction and failure review" />
          <InteractionReview view={view} onLink={openLink} />
        </section>

        <section aria-labelledby="r-timeline">
          <SectionHeading id="r-timeline" title="Concurrency timeline" />
          <ConcurrencyTimeline view={view} now={end} />
        </section>

        <section aria-labelledby="r-outcome">
          <SectionHeading id="r-outcome" title="Human review" />
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm">
            {finalCandidate ? (
              <p className="flex flex-wrap items-center gap-1">
                Reviewed candidate <span className="font-medium">{finalCandidate.label}</span> at <CopyableId value={finalCandidate.headSha} short={false} label="Copy reviewed head" />
              </p>
            ) : (
              <p className="text-muted-foreground">No candidate reached review.</p>
            )}
            {approval ? (
              <p>
                {approval.decision === 'approve' ? 'A human approved' : 'A human rejected'} commit {shortSha(approval.headSha)} at {formatClock(approval.createdAt)}.
              </p>
            ) : (
              <p className="text-muted-foreground">No approval was recorded.</p>
            )}
            {promotion && (
              <Alert tone={promotion.state === 'succeeded' ? 'success' : 'warning'}>
                {promotion.state === 'succeeded' ? <Rocket aria-hidden /> : <CircleAlert aria-hidden />}
                <div>
                  <AlertTitle>{promotion.state === 'succeeded' ? `Main now equals approved commit ${shortSha(promotion.targetSha)}` : `Promotion ${promotion.state}`}</AlertTitle>
                  <AlertDescription>
                    <span className="flex flex-wrap items-center gap-1 text-xs">
                      Before <CopyableId value={promotion.beforeSha} /> · target <CopyableId value={promotion.targetSha} />
                    </span>
                  </AlertDescription>
                </div>
              </Alert>
            )}
          </div>
        </section>

        <section aria-labelledby="r-events">
          <details className="rounded-lg border bg-card">
            <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold" id="r-events">
              Public event log ({replay.events.length})
            </summary>
            <ol className="max-h-[50vh] overflow-y-auto border-t font-mono text-xs">
              {replay.events.map((e) => (
                <li key={e.seq} className="flex gap-2 border-b px-4 py-1 last:border-b-0">
                  <span className="shrink-0 text-muted-foreground">{formatClock(e.createdAt)}</span>
                  <span className="shrink-0 font-semibold">{e.type}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{typeof e.payload.message === 'string' ? e.payload.message : ''}</span>
                </li>
              ))}
            </ol>
          </details>
        </section>

        <footer className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
          <Badge tone="outline">Replay {replay.replayId}</Badge>
          <span>A redacted public copy. It holds no credentials, private model messages, or operator identity.</span>
        </footer>
      </main>

      <Sheet open={panel !== null} onOpenChange={(o) => !o && setPanel(null)}>
        <SheetContent>
          {panel?.kind === 'agent' && panelProposal && (
            <>
              <SheetHeader>
                <SheetTitle>{panelProposal.title}</SheetTitle>
                <SheetDescription render={<div />}>
                  <StatusBadge kind="proposal" value={panelProposal.status} />
                </SheetDescription>
              </SheetHeader>
              <SheetBody className="flex flex-col gap-3">
                {panelProposal.summary && <p className="text-sm">{panelProposal.summary}</p>}
                {panelProposal.intent ? <IntentDetails intent={panelProposal.intent} /> : <p className="text-sm text-muted-foreground">No intent recorded.</p>}
                <ul className="flex flex-col gap-1 text-xs">
                  {panelProposal.revisions.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <Badge tone="outline">r{r.revisionNo}</Badge> <CopyableId value={r.headSha} />
                    </li>
                  ))}
                </ul>
              </SheetBody>
            </>
          )}
          {panel?.kind === 'check' && <CheckPanel view={view} candidateId={panel.candidateId} checkId={panel.checkId} />}
          {panel?.kind === 'candidate' && <CandidatePanel view={view} candidateId={panel.candidateId} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function ReplayApp() {
  const load = useReplay();
  if (load.state === 'loading') {
    return (
      <main className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-6" role="status" aria-live="polite">
        <p className="text-sm text-muted-foreground">The replay loads…</p>
        <Skeleton className="h-24" />
        <Skeleton className="h-48" />
      </main>
    );
  }
  if (load.state === 'error') {
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <Alert tone={load.notFound ? 'warning' : 'danger'}>
          <StateIcon style={CELL.error} />
          <div>
            <AlertTitle>{load.notFound ? 'Replay not found' : 'The replay is unavailable'}</AlertTitle>
            <AlertDescription>{load.message}</AlertDescription>
          </div>
        </Alert>
      </main>
    );
  }
  return <ReplayView replay={load.replay} sample={load.sample} />;
}
