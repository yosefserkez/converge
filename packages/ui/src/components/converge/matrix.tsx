import { CHECKS } from '@converge/domain/catalog';
import type { ReactNode } from 'react';
import { cellState, type CellState } from '../../lib/matrix.ts';
import { cn } from '../../lib/utils.ts';
import { proposalName, revisionIndex, type SessionView, type ViewCandidate, type ViewCheck } from '../../lib/view.ts';
import { Badge } from '../ui/primitives.tsx';
import { CopyableId } from './copy.tsx';
import { CELL, StateIcon, StatusBadge } from './status.tsx';

const SHORT: Record<CellState, string> = {
  not_run: 'Not run',
  pending: 'Pending',
  running: 'Running',
  passed: 'Pass',
  failed: 'Fail',
  skipped: 'N/A',
  error: 'Error',
};

const CELL_CLASS: Record<CellState, string> = {
  not_run: 'text-muted-foreground',
  pending: 'text-muted-foreground',
  running: 'text-info',
  passed: 'text-success bg-success-soft/60',
  failed: 'text-danger bg-danger-soft font-semibold',
  skipped: 'text-muted-foreground',
  error: 'text-warning bg-warning-soft/70 font-semibold',
};

export interface CellSelection {
  candidate: ViewCandidate;
  checkId: string;
  check: ViewCheck | undefined;
  state: CellState;
}

export function IntegrationMatrix({
  view,
  onSelectCell,
  renderRowActions,
}: {
  view: Pick<SessionView, 'candidates' | 'proposals'>;
  onSelectCell?: (sel: CellSelection) => void;
  renderRowActions?: (c: ViewCandidate) => ReactNode;
}) {
  const revs = revisionIndex(view);
  if (view.candidates.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No candidates yet. Converge plans candidates when every agent seals a revision.
      </p>
    );
  }
  const labelOf = (id: string) => view.candidates.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[880px] border-collapse text-left text-xs">
        <caption className="sr-only">Integration matrix. Rows are candidate combinations. Columns are protected checks.</caption>
        <thead>
          <tr className="border-b bg-muted/40">
            <th scope="col" className="sticky left-0 z-10 w-[170px] bg-muted/95 sm:w-[300px] px-3 py-2 font-medium">
              Candidate
            </th>
            {CHECKS.map((k) => (
              <th key={k.id} scope="col" className="px-2 py-2 font-medium" title={k.description}>
                <span className="block">{k.title}</span>
                <span className="block font-mono text-[10px] font-normal text-muted-foreground">{k.id}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.candidates.map((c) => {
            const members = c.members.map((m) => revs.get(m));
            return (
              <tr key={c.id} className="border-b last:border-b-0">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 align-top font-normal">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{c.label}</span>
                    <StatusBadge kind="candidate" value={c.state} />
                    {c.fullGoal && <Badge tone="accent">Full goal</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                    {members.length === 0 ? (
                      <span>No changes (baseline)</span>
                    ) : (
                      members.map((m, i) => (
                        <Badge key={c.members[i]} tone="outline">
                          {m ? `${proposalName(m.proposal)} r${m.revision.revisionNo}` : c.members[i]}
                        </Badge>
                      ))
                    )}
                  </div>
                  {c.anchorCandidateId && <p className="mt-1 text-muted-foreground">Repair of {labelOf(c.anchorCandidateId)}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {c.headSha ? <CopyableId value={c.headSha} label="Copy candidate head SHA" /> : <span className="text-muted-foreground">Not materialized</span>}
                    {renderRowActions?.(c)}
                  </div>
                </th>
                {CHECKS.map((k) => {
                  const check = c.checks.find((x) => x.checkId === k.id);
                  const state = cellState(check, c.state);
                  const style = CELL[state];
                  const reason = state === 'skipped' ? (check?.applicabilityReason ?? 'not applicable') : null;
                  const detail =
                    check && (state === 'failed' || state === 'passed' || state === 'error')
                      ? `${check.assertionCount - check.failedCount}/${check.assertionCount} assertions`
                      : null;
                  const clickable = !!onSelectCell && !!check && state !== 'not_run' && state !== 'pending';
                  const label = `${c.label}, ${k.title}: ${style.label}${reason ? `, ${reason}` : ''}${detail ? `, ${detail}` : ''}`;
                  const body = (
                    <>
                      <span className="flex items-center gap-1">
                        <StateIcon style={style} className="size-3.5" />
                        {SHORT[state]}
                      </span>
                      {detail && <span className="block text-[10px] font-normal opacity-80">{detail}</span>}
                      {reason && <span className="block text-[10px] leading-3 font-normal">{reason}</span>}
                    </>
                  );
                  return (
                    <td key={k.id} className="p-1 align-top">
                      {clickable ? (
                        <button
                          type="button"
                          onClick={() => onSelectCell!({ candidate: c, checkId: k.id, check, state })}
                          className={cn(
                            'w-full cursor-pointer rounded-md px-2 py-1.5 text-left hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring',
                            CELL_CLASS[state],
                          )}
                          aria-label={`${label}. ${state === 'failed' ? 'Open the counterexample.' : 'Open the result.'}`}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className={cn('rounded-md px-2 py-1.5', CELL_CLASS[state])} aria-label={label} role="img">
                          {body}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
