import { CHECKS } from '@converge/domain/catalog';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CELL,
  cellState,
  CopyableId,
  formatDateTime,
  proposalName,
  reviewCandidate,
  revisionIndex,
  shortSha,
  StateIcon,
  StatusBadge,
  type SessionView,
} from '@converge/ui';
import { CircleCheck, GitCommitHorizontal, Rocket, TriangleAlert, X } from 'lucide-react';
import { useCommand } from '../lib/hooks.ts';
import { useCandidate } from './candidate-drawers.tsx';
import { ErrorNotice, LoadingBlock } from './feedback.tsx';
import { type PreviewGrant, PreviewButton } from './preview.tsx';

const LIMITATIONS = [
  'The protected checks cover the synthetic storefront contract only. A pass does not prove arbitrary software correct.',
  'Converge detects interactions from declared intents and the selected candidate combinations. It does not test every combination.',
  'Approval covers this exact commit, this validation manifest, and the expected main. Any change needs a new review.',
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function FinalReview({
  view,
  onOpenEvidence,
  onOpenCheck,
  onPreview,
}: {
  view: SessionView;
  onOpenEvidence: (evidenceId: string, title: string) => void;
  onOpenCheck: (candidateId: string, checkId: string) => void;
  onPreview: (g: PreviewGrant) => void;
}) {
  const candidate = reviewCandidate(view);
  if (!candidate) {
    const latestFull = [...view.candidates].filter((c) => c.fullGoal).sort((a, b) => b.createdAt - a.createdAt)[0];
    return (
      <Card className="p-4 text-sm">
        <p className="font-medium">No commit is ready for approval yet</p>
        <p className="text-muted-foreground">
          {latestFull
            ? `The latest full-goal candidate, ${latestFull.label}, is ${latestFull.state.replace('_', ' ')}. Approval needs a full-goal candidate that passes every applicable check.`
            : 'Approval needs a full-goal candidate that passes every applicable check. Converge plans one when all agents seal a revision.'}
        </p>
      </Card>
    );
  }
  return <ReviewBody key={candidate.id} view={view} candidateId={candidate.id} onOpenEvidence={onOpenEvidence} onOpenCheck={onOpenCheck} onPreview={onPreview} />;
}

function ReviewBody({
  view,
  candidateId,
  onOpenEvidence,
  onOpenCheck,
  onPreview,
}: {
  view: SessionView;
  candidateId: string;
  onOpenEvidence: (evidenceId: string, title: string) => void;
  onOpenCheck: (candidateId: string, checkId: string) => void;
  onPreview: (g: PreviewGrant) => void;
}) {
  const q = useCandidate(candidateId);
  const approve = useCommand<{ approvalId: string }>(`approve:${candidateId}`);
  const reject = useCommand<{ approvalId: string }>(`reject:${candidateId}`);
  const approvals = view.approvals.filter((a) => a.candidateId === candidateId || (!a.candidateId && a.headSha === q.data?.headSha));
  const approval = [...approvals].reverse().find((a) => a.headSha === q.data?.headSha);
  const promoteKey = approval?.id ?? 'none';
  const promote = useCommand<{ promotionId: string; state: string }>(`promote:${promoteKey}`);

  if (q.isPending) return <LoadingBlock label="The final review loads" rows={3} />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const head = c.headSha!;
  const short = shortSha(head);
  const observedMain = view.project?.observedMainSha ?? c.observedMainSha;
  const promotion = approval ? view.promotions.find((p) => p.approvalId === approval.id) : undefined;
  const promoted = promotion?.state === 'succeeded';
  const stale = !promoted && observedMain !== c.expectedMainSha;
  const revs = revisionIndex(view);
  const body = (decision: 'approve' | 'reject') => ({ headSha: head, expectedMainSha: c.expectedMainSha, validationDigest: c.validationDigest!, decision });
  const runApprove = () => approve.mutate({ path: `/api/candidates/${c.id}/approve`, body: body('approve') });
  const runReject = () => reject.mutate({ path: `/api/candidates/${c.id}/approve`, body: body('reject') });
  const runPromote = () => approval?.id && promote.mutate({ path: `/api/approvals/${approval.id}/promote` });
  const approvalExpired = approval?.expiresAt ? approval.expiresAt < Date.now() : false;

  return (
    <Card className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{promoted ? 'Main now equals the approved commit' : stale ? 'Main changed after this candidate was built' : 'Ready to approve this commit'}</h3>
          <p className="text-sm text-muted-foreground">{c.label}</p>
        </div>
        <StatusBadge kind="candidate" value={c.state} />
      </div>

      <Section title="Original goals">
        <p className="text-sm">{view.session.objective}</p>
        <ul className="grid gap-1.5 text-xs sm:grid-cols-3">
          {view.proposals
            .filter((p) => p.kind === 'feature')
            .map((p) => (
              <li key={p.id} className="rounded-md border p-2">
                <p className="font-medium">{p.title}</p>
                <p className="line-clamp-3 text-muted-foreground">{p.objective ?? p.intent?.objective}</p>
              </li>
            ))}
        </ul>
      </Section>

      <Section title="Included revisions, in merge order">
        <ol className="flex flex-col gap-1 text-xs">
          {c.members.map((m) => {
            const r = revs.get(m);
            return (
              <li key={m} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
                <span className="font-medium">{r ? `${proposalName(r.proposal)} r${r.revision.revisionNo}` : m}</span>
                <CopyableId value={r?.revision.headSha} label="Copy revision head" />
                {r?.revision.diffEvidenceId && (
                  <button type="button" className="ml-auto cursor-pointer text-primary hover:underline" onClick={() => onOpenEvidence(r.revision.diffEvidenceId!, `Diff: ${r.proposal.title} r${r.revision.revisionNo}`)}>
                    View diff
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title="Check results">
        <ul className="grid gap-1 text-xs sm:grid-cols-2">
          {CHECKS.map((k) => {
            const run = c.checks.filter((x) => x.checkId === k.id).at(-1);
            const st = cellState(run, c.state);
            return (
              <li key={k.id}>
                <button type="button" onClick={() => onOpenCheck(c.id, k.id)} className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left hover:bg-muted">
                  <span>
                    {k.title}
                    {st === 'skipped' && run && <span className="block text-muted-foreground">{run.applicabilityReason}</span>}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <StateIcon style={CELL[st]} className="size-3.5" /> {CELL[st].label}
                    {run && run.assertionCount > 0 && <span className="text-muted-foreground">({run.assertionCount - run.failedCount}/{run.assertionCount})</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Limitations">
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {LIMITATIONS.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {view.session.mode === 'fixture' && <li>Fixture mode: checked-in patches replaced the agents. No model made these changes.</li>}
        </ul>
      </Section>

      <Section title="Exact source">
        <dl className="grid grid-cols-1 gap-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-32 text-muted-foreground">Candidate head</dt>
            <dd className="flex items-center gap-1">
              <GitCommitHorizontal className="size-3.5" aria-hidden />
              <CopyableId value={head} short={false} label="Copy candidate head SHA" />
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-32 text-muted-foreground">Expected main</dt>
            <dd>
              <CopyableId value={c.expectedMainSha} short={false} label="Copy expected main SHA" />
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-32 text-muted-foreground">Observed main</dt>
            <dd className="flex items-center gap-1.5">
              <CopyableId value={observedMain} short={false} label="Copy observed main SHA" />
              {!promoted && (stale ? <Badge tone="warning">Different</Badge> : <Badge tone="success">Matches</Badge>)}
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-32 text-muted-foreground">Validation digest</dt>
            <dd>
              <CopyableId value={c.validationDigest} label="Copy validation digest" />
            </dd>
          </div>
        </dl>
      </Section>

      <div className="flex flex-col gap-3 border-t pt-4">
        {stale && (
          <Alert tone="warning">
            <TriangleAlert aria-hidden />
            <div>
              <AlertTitle>Main changed. This candidate needs a rebuild.</AlertTitle>
              <AlertDescription>
                Main moved from {shortSha(c.expectedMainSha)} to {shortSha(observedMain)} after Converge built this candidate. Approval and promotion are blocked. Start a new session from the current main to rebuild and verify again.
              </AlertDescription>
            </div>
          </Alert>
        )}

        {!approval && !stale && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" onClick={runApprove} disabled={approve.isPending || reject.isPending || !c.validationDigest}>
              <CircleCheck aria-hidden /> {approve.isPending ? 'Approval sent…' : `Approve commit ${short} for promotion to main`}
            </Button>
            <Button size="lg" variant="outline" onClick={runReject} disabled={approve.isPending || reject.isPending}>
              <X aria-hidden /> Reject commit {short}
            </Button>
            <PreviewButton candidate={c} onOpen={onPreview} size="default" />
          </div>
        )}
        {!approval && !stale && <p className="text-xs text-muted-foreground">Approval records your decision about commit {short} only. Promotion is a separate step.</p>}
        <ErrorNotice error={approve.error} onDismiss={() => approve.reset()} onRetry={runApprove} />
        <ErrorNotice error={reject.error} onDismiss={() => reject.reset()} onRetry={runReject} />

        {approval && approval.decision === 'reject' && (
          <Alert>
            <X aria-hidden />
            <div>
              <AlertTitle>You rejected commit {short}</AlertTitle>
              <AlertDescription>Recorded {formatDateTime(approval.createdAt)}. Nothing changes on main.</AlertDescription>
            </div>
          </Alert>
        )}

        {approval && approval.decision === 'approve' && !promotion && (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-sm text-success">
              <CircleCheck className="size-4" aria-hidden /> Commit {short} approved {formatDateTime(approval.createdAt)}
              {approval.expiresAt ? ` · approval valid until ${formatDateTime(approval.expiresAt)}` : ''}
            </p>
            {approvalExpired ? (
              <p className="text-sm text-warning">This approval expired. Review the candidate again to promote it.</p>
            ) : (
              <div>
                <Button size="lg" onClick={runPromote} disabled={promote.isPending || stale}>
                  <Rocket aria-hidden /> {promote.isPending ? 'Promotion sent…' : `Promote commit ${short} to main`}
                </Button>
                <p className="mt-1 text-xs text-muted-foreground">Promotion moves main from {shortSha(c.expectedMainSha)} to {short} only if main has not changed.</p>
              </div>
            )}
          </div>
        )}
        <ErrorNotice error={promote.error} onDismiss={() => promote.reset()} onRetry={runPromote} />

        {promotion && (
          <Alert tone={promotion.state === 'succeeded' ? 'success' : promotion.state === 'failed' || promotion.state === 'stale' ? 'warning' : 'info'}>
            {promotion.state === 'succeeded' ? <Rocket aria-hidden /> : <TriangleAlert aria-hidden />}
            <div className="flex flex-col gap-1">
              <AlertTitle>
                {promotion.state === 'succeeded'
                  ? `Main now equals approved commit ${shortSha(promotion.targetSha)}`
                  : promotion.state === 'stale'
                    ? 'Promotion stopped: main changed before the update'
                    : promotion.state === 'failed'
                      ? 'Promotion failed'
                      : 'Promotion in progress'}
              </AlertTitle>
              <AlertDescription>
                <span className="flex flex-wrap items-center gap-1 text-xs">
                  Before <CopyableId value={promotion.beforeSha} /> · target <CopyableId value={promotion.targetSha} /> · observed main{' '}
                  <CopyableId value={promotion.observedRemoteSha ?? observedMain} />
                </span>
              </AlertDescription>
            </div>
          </Alert>
        )}
      </div>
    </Card>
  );
}
