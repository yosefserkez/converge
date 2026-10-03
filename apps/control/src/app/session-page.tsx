import {
  AgentCards,
  Button,
  ConcurrencyTimeline,
  IntegrationMatrix,
  InteractionReview,
  SectionHeading,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  type CellSelection,
  type StoryLink,
  type ViewProposal,
} from '@converge/ui';
import { RotateCcw, Wrench } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { useCommand, useConfig, useNow, useSessionLive } from '../lib/hooks.ts';
import { linkProps } from '../lib/router.ts';
import { AgentDrawerContent } from './agent-drawer.tsx';
import { CandidateDrawerContent, CheckDrawerContent } from './candidate-drawers.tsx';
import { EvidenceView } from './evidence.tsx';
import { EmptyState, ErrorNotice, LoadingBlock } from './feedback.tsx';
import { FinalReview } from './final-review.tsx';
import { type PreviewGrant, PreviewButton, PreviewSheet } from './preview.tsx';
import { SessionHeader } from './session-header.tsx';

type Drawer =
  | { kind: 'agent'; proposalId: string }
  | { kind: 'check'; candidateId: string; checkId: string }
  | { kind: 'candidate'; candidateId: string }
  | { kind: 'evidence'; evidenceId: string; title: string };

function RetryAgentButton({ proposal }: { proposal: ViewProposal }) {
  const job = proposal.job;
  const retry = useCommand(`retry:${job?.id}:${job?.attemptNo}`);
  if (!job || (job.status !== 'failed' && job.status !== 'expired')) return null;
  const run = () => retry.mutate({ path: `/api/jobs/${job.id}/retry` });
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={run} disabled={retry.isPending}>
        <RotateCcw aria-hidden /> {retry.isPending ? 'Retry sent…' : 'Retry agent'}
      </Button>
      <ErrorNotice error={retry.error} onDismiss={() => retry.reset()} onRetry={run} className="max-w-xs text-xs" />
    </span>
  );
}

function RepairButton({ candidateId }: { candidateId: string }) {
  const repair = useCommand(`repair:${candidateId}`);
  const run = () => repair.mutate({ path: `/api/candidates/${candidateId}/repair` });
  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant="outline" onClick={run} disabled={repair.isPending || repair.isSuccess}>
        <Wrench aria-hidden /> {repair.isSuccess ? 'Repair requested' : repair.isPending ? 'Request sent…' : 'Request repair'}
      </Button>
      <ErrorNotice error={repair.error} onDismiss={() => repair.reset()} onRetry={run} className="max-w-xs text-xs" />
    </span>
  );
}

export function SessionPage({ sessionId }: { sessionId: string }) {
  const { snapshot, view, connection, retryNow } = useSessionLive(sessionId);
  const config = useConfig();
  const now = useNow(1000);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [preview, setPreview] = useState<PreviewGrant | null>(null);

  if (snapshot.isPending) return <LoadingBlock label="The session loads" rows={4} />;
  if (snapshot.isError || !view) {
    const e = snapshot.error;
    if (e instanceof ApiError && e.status === 404) {
      return (
        <EmptyState
          title="This session does not exist"
          action={
            <a {...linkProps('/')} className="text-sm text-primary hover:underline">
              Create a new session
            </a>
          }
        >
          Check the link, or pick a session from the history.
        </EmptyState>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold">The session is unavailable</h1>
        <ErrorNotice error={e} onRetry={() => void snapshot.refetch()} />
      </div>
    );
  }

  const openLink = (l: StoryLink) => {
    if (l.kind === 'intent') setDrawer({ kind: 'agent', proposalId: l.proposalId });
    else if (l.kind === 'check') setDrawer({ kind: 'check', candidateId: l.candidateId, checkId: l.checkId });
    else setDrawer({ kind: 'candidate', candidateId: l.candidateId });
  };
  const onSelectCell = (sel: CellSelection) => setDrawer({ kind: 'check', candidateId: sel.candidate.id, checkId: sel.checkId });
  const repairedBases = new Set(view.proposals.filter((p) => p.kind === 'repair').map((p) => p.baseCandidateId));
  const drawerProposal = drawer?.kind === 'agent' ? view.proposals.find((p) => p.id === drawer.proposalId) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <SessionHeader view={view} connection={connection} onRetry={retryNow} now={now} previewOrigin={config.data?.previewOrigin ?? null} />

      <section aria-labelledby="agents-heading">
        <SectionHeading id="agents-heading" title="Agents" description="Each agent works in its own fork from the same baseline. Open a card for its intent, changes, and logs." />
        <AgentCards view={view} now={now} onOpen={(id) => setDrawer({ kind: 'agent', proposalId: id })} renderActions={(p) => <RetryAgentButton proposal={p} />} />
      </section>

      <section aria-labelledby="matrix-heading">
        <SectionHeading
          id="matrix-heading"
          title="Integration matrix"
          description="Rows are candidate combinations at exact commits. Columns are protected checks. Select a failed cell for its counterexample."
        />
        <IntegrationMatrix
          view={view}
          onSelectCell={onSelectCell}
          renderRowActions={(c) => (
            <>
              <button type="button" onClick={() => setDrawer({ kind: 'candidate', candidateId: c.id })} className="cursor-pointer text-primary hover:underline">
                Details
              </button>
              <PreviewButton candidate={c} onOpen={setPreview} />
              {c.state === 'failed' && !repairedBases.has(c.id) && c.members.length > 1 && <RepairButton candidateId={c.id} />}
            </>
          )}
        />
      </section>

      <section aria-labelledby="interaction-heading">
        <SectionHeading id="interaction-heading" title="Interaction and failure review" description="Declared changes, assumptions, observed behavior, and the repair, each linked to its evidence." />
        <InteractionReview view={view} onLink={openLink} />
      </section>

      <section aria-labelledby="timeline-heading">
        <SectionHeading id="timeline-heading" title="Concurrency timeline" description="Real model, tool, and fixture spans per agent." />
        <ConcurrencyTimeline view={view} now={now} />
      </section>

      <section aria-labelledby="review-heading" id="final-review">
        <SectionHeading id="review-heading" title="Final review" description="Approve one exact commit. Promotion is a separate step." />
        <FinalReview
          view={view}
          onOpenEvidence={(evidenceId, title) => setDrawer({ kind: 'evidence', evidenceId, title })}
          onOpenCheck={(candidateId, checkId) => setDrawer({ kind: 'check', candidateId, checkId })}
          onPreview={setPreview}
        />
      </section>

      <Sheet open={drawer !== null} onOpenChange={(o) => !o && setDrawer(null)}>
        <SheetContent>
          {drawer?.kind === 'agent' && drawerProposal && <AgentDrawerContent proposal={drawerProposal} view={view} />}
          {drawer?.kind === 'check' && <CheckDrawerContent key={`${drawer.candidateId}:${drawer.checkId}`} candidateId={drawer.candidateId} checkId={drawer.checkId} />}
          {drawer?.kind === 'candidate' && (
            <CandidateDrawerContent
              candidateId={drawer.candidateId}
              view={view}
              onOpenCheck={(checkId) => setDrawer({ kind: 'check', candidateId: drawer.candidateId, checkId })}
              onPreview={setPreview}
            />
          )}
          {drawer?.kind === 'evidence' && (
            <>
              <SheetHeader>
                <SheetTitle>{drawer.title}</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <EvidenceView evidenceId={drawer.evidenceId} diff={drawer.title.startsWith('Diff')} />
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
      <PreviewSheet grant={preview} onClose={() => setPreview(null)} onRenew={setPreview} />
    </div>
  );
}
