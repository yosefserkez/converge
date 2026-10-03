import { ArrowDown, ArrowRight, CircleCheck, CircleDot, CircleX, Eye, FileText, Search, Wrench } from 'lucide-react';
import { buildStory, checkTitle, type InteractionStory, type StoryLine, type StoryLink } from '../../lib/story.ts';
import { cn } from '../../lib/utils.ts';
import { proposalName, type SessionView } from '../../lib/view.ts';
import { Card } from '../ui/primitives.tsx';
import { CopyableId } from './copy.tsx';
import { StatusBadge } from './status.tsx';
import { SequenceTable } from './text.tsx';

const LINE_ICON: Record<StoryLine['role'], typeof Eye> = {
  declared: FileText,
  assumed: FileText,
  observed: Search,
  action: Wrench,
  verified: CircleCheck,
};

const LINE_TONE: Record<StoryLine['role'], string> = {
  declared: 'text-muted-foreground',
  assumed: 'text-muted-foreground',
  observed: 'text-danger',
  action: 'text-warning',
  verified: 'text-success',
};

function linkText(link: StoryLink): string {
  if (link.kind === 'intent') return 'Open intent revision';
  if (link.kind === 'check') return 'Open check evidence';
  return 'Open candidate';
}

function StoryLines({ story, onLink }: { story: InteractionStory; onLink?: (l: StoryLink) => void }) {
  return (
    <ol className="flex flex-col gap-2">
      {story.lines.map((line, idx) => {
        const Icon = LINE_ICON[line.role];
        return (
          <li key={idx} className="flex gap-2.5 text-sm">
            <Icon className={cn('mt-0.5 size-4 shrink-0', LINE_TONE[line.role])} aria-hidden />
            <div className="min-w-0">
              <p>
                <span className="font-semibold">{line.label}:</span> <span>{line.text.replace(/[.\s]+$/, "")}.</span>
              </p>
              {line.link && onLink && (
                <button type="button" onClick={() => onLink(line.link!)} className="mt-0.5 cursor-pointer text-xs text-primary hover:underline">
                  {linkText(line.link)}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Anchor graph: failed candidate, then repair proposal, then repaired candidate. */
function RepairGraph({ story, onLink }: { story: InteractionStory; onLink?: (l: StoryLink) => void }) {
  if (!story.failedCandidate) return null;
  const repairHead = story.repair?.revisions.at(-1)?.headSha ?? null;
  const anchor = story.anchorCandidate;
  const separateAnchor = anchor && anchor.id !== story.failedCandidate.id;
  type GraphNode = { key: string; title: string; caption: string; sha: string | null; tone: string; icon: typeof Eye; link?: StoryLink };
  const nodes: GraphNode[] = [
    {
      key: 'failed',
      title: story.failedCandidate.label,
      caption: separateAnchor ? 'First failed candidate' : 'Anchor candidate (failed)',
      sha: story.failedCandidate.headSha,
      tone: 'border-danger/40 bg-danger-soft/50',
      icon: CircleX,
      link: { kind: 'candidate', candidateId: story.failedCandidate.id },
    },
    ...(separateAnchor
      ? [
          {
            key: 'anchor',
            title: anchor.label,
            caption: `Anchor candidate (${anchor.state})`,
            sha: anchor.headSha,
            tone: 'border-danger/40 bg-danger-soft/30',
            icon: CircleX,
            link: { kind: 'candidate' as const, candidateId: anchor.id },
          },
        ]
      : []),
    {
      key: 'repair',
      title: story.repair ? story.repair.title : 'No repair yet',
      caption: story.repair ? `Repair proposal (${story.repair.status})` : 'Request a repair to continue',
      sha: repairHead,
      tone: story.repair?.status === 'sealed' ? 'border-warning/40 bg-warning-soft/50' : 'border-dashed',
      icon: Wrench,
      ...(story.repair ? { link: { kind: 'intent' as const, proposalId: story.repair.id } } : {}),
    },
    {
      key: 'final',
      title: story.resolvedCandidate?.label ?? 'Repaired candidate',
      caption: story.resolvedCandidate ? `Final candidate (${story.resolvedCandidate.state})` : 'Not planned yet',
      sha: story.resolvedCandidate?.headSha ?? null,
      tone: story.resolvedCandidate?.state === 'passed' ? 'border-success/40 bg-success-soft/50' : 'border-dashed',
      icon: story.resolvedCandidate?.state === 'passed' ? CircleCheck : CircleDot,
      ...(story.resolvedCandidate ? { link: { kind: 'candidate' as const, candidateId: story.resolvedCandidate.id } } : {}),
    },
  ];
  return (
    <ol className="flex flex-col items-stretch gap-1 md:flex-row md:items-center" aria-label="Repair lineage">
      {nodes.map((n, i) => {
        const Icon = n.icon;
        return (
          <li key={n.key} className="contents">
            <div className={cn('min-w-0 flex-1 rounded-md border p-2.5 text-xs', n.tone)}>
              <p className="flex items-center gap-1.5 font-semibold">
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{n.title}</span>
              </p>
              <p className="text-muted-foreground">{n.caption}</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <CopyableId value={n.sha} label="Copy commit SHA" />
                {n.link && onLink && (
                  <button type="button" onClick={() => onLink(n.link!)} className="cursor-pointer text-primary hover:underline">
                    Open
                  </button>
                )}
              </div>
            </div>
            {i < nodes.length - 1 && (
              <span aria-hidden className="flex justify-center text-muted-foreground">
                <ArrowDown className="size-4 md:hidden" />
                <ArrowRight className="hidden size-4 md:block" />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function InteractionCard({ story, onLink }: { story: InteractionStory; onLink?: (l: StoryLink) => void }) {
  const i = story.interaction;
  const leftHead = story.left?.revisions.at(-1);
  const rightHead = story.right?.revisions.at(-1);
  return (
    <Card className={cn(story.outcome === 'confirmed' && 'border-danger/40', story.outcome === 'resolved' && 'border-success/40')}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{story.headline}</h3>
          <p className="text-xs text-muted-foreground">
            {story.left ? proposalName(story.left) : 'Unknown'} and {story.right ? proposalName(story.right) : 'unknown'}
            {i.contractKey ? (
              <>
                {' '}
                · contract <code className="font-mono">{i.contractKey}</code>
              </>
            ) : null}
            {i.failedCheck ? ` · ${checkTitle(i.failedCheck.checkId)}` : ''}
          </p>
        </div>
        <StatusBadge kind="interaction" value={i.state} />
      </div>
      <div className="flex flex-col gap-4 px-4 py-3">
        <StoryLines story={story} onLink={onLink} />
        {story.sequence.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Request sequence (protected HTTP reproducer)</h4>
            <SequenceTable steps={story.sequence} />
          </section>
        )}
        <section>
          <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Commits</h4>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {story.left && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">{proposalName(story.left)} revision</dt>
                <dd>
                  <CopyableId value={leftHead?.headSha} label="Copy revision SHA" />
                </dd>
              </div>
            )}
            {story.right && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">{proposalName(story.right)} revision</dt>
                <dd>
                  <CopyableId value={rightHead?.headSha} label="Copy revision SHA" />
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section>
          <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Repair status</h4>
          <RepairGraph story={story} onLink={onLink} />
        </section>
        <p className="text-xs text-muted-foreground">{i.explanation}</p>
      </div>
    </Card>
  );
}

export function InteractionReview({ view, onLink }: { view: Pick<SessionView, 'interactions' | 'proposals' | 'candidates'>; onLink?: (l: StoryLink) => void }) {
  if (view.interactions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No interactions found. Converge compares declared intents when agents publish them.
      </p>
    );
  }
  const order = { confirmed: 0, resolved: 1, predicted: 2, unknown: 3 } as Record<string, number>;
  const stories = [...view.interactions].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9)).map((i) => buildStory(view, i));
  return (
    <div className="flex flex-col gap-3">
      {stories.map((s) => (
        <InteractionCard key={s.interaction.id} story={s} onLink={onLink} />
      ))}
    </div>
  );
}
