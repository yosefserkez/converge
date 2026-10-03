// Integration matrix cell states. Pure; unit tests in packages/ui/test.

export type CellState = 'not_run' | 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';

export interface CellInput {
  status: string;
  applicable: boolean;
}

const NOT_STARTED = new Set(['planned', 'assembling']);
const STOPPED = new Set(['text_conflict', 'error', 'cancelled']);

/**
 * Map one check run (or its absence) to a display state.
 * A skipped check is never a pass. A missing run is "not run" unless the
 * candidate is in testing, where it is pending.
 */
export function cellState(check: CellInput | undefined, candidateState: string): CellState {
  if (!check) {
    if (candidateState === 'testing') return 'pending';
    return 'not_run';
  }
  if (!check.applicable || check.status === 'skipped') return 'skipped';
  switch (check.status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'error':
      return 'error';
    case 'running':
      return 'running';
    case 'pending':
      return NOT_STARTED.has(candidateState) || STOPPED.has(candidateState) ? 'not_run' : 'pending';
    default:
      return 'error';
  }
}

export const CELL_LABEL: Record<CellState, string> = {
  not_run: 'Not yet run',
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Not applicable',
  error: 'Error',
};

/** Summary counts for a candidate row. */
export function rowSummary(states: readonly CellState[]) {
  const count = (s: CellState) => states.filter((x) => x === s).length;
  return { passed: count('passed'), failed: count('failed'), error: count('error'), skipped: count('skipped'), open: count('pending') + count('running') + count('not_run') };
}
