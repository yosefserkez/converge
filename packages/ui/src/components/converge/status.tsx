import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  Clock,
  GitMerge,
  LoaderCircle,
  PauseCircle,
  Rocket,
  type LucideIcon,
} from 'lucide-react';
import { humanize } from '../../lib/format.ts';
import { CELL_LABEL, type CellState } from '../../lib/matrix.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/primitives.tsx';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'outline';
interface StatusStyle {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  spin?: boolean;
}

const SESSION: Record<string, StatusStyle> = {
  created: { tone: 'neutral', icon: CircleDashed, label: 'Not started' },
  preflight: { tone: 'accent', icon: LoaderCircle, label: 'Preflight', spin: true },
  running: { tone: 'accent', icon: LoaderCircle, label: 'Agents running', spin: true },
  validating: { tone: 'accent', icon: LoaderCircle, label: 'Checks in progress', spin: true },
  repairing: { tone: 'warning', icon: LoaderCircle, label: 'Repair in progress', spin: true },
  ready: { tone: 'success', icon: CircleCheck, label: 'Ready for review' },
  promoted: { tone: 'success', icon: Rocket, label: 'Promoted' },
  needs_attention: { tone: 'warning', icon: CircleAlert, label: 'Needs attention' },
  failed: { tone: 'danger', icon: CircleX, label: 'Failed' },
  cancelled: { tone: 'neutral', icon: Ban, label: 'Cancelled' },
};

const PROPOSAL: Record<string, StatusStyle> = {
  pending: { tone: 'neutral', icon: Clock, label: 'Pending' },
  working: { tone: 'accent', icon: LoaderCircle, label: 'Working', spin: true },
  sealed: { tone: 'success', icon: CircleCheck, label: 'Sealed' },
  blocked: { tone: 'danger', icon: CircleX, label: 'Blocked' },
  cancelled: { tone: 'neutral', icon: Ban, label: 'Cancelled' },
};

const CANDIDATE: Record<string, StatusStyle> = {
  planned: { tone: 'neutral', icon: CircleDashed, label: 'Planned' },
  assembling: { tone: 'accent', icon: GitMerge, label: 'Merge in progress' },
  testing: { tone: 'accent', icon: LoaderCircle, label: 'Checks in progress', spin: true },
  passed: { tone: 'success', icon: CircleCheck, label: 'Passed' },
  failed: { tone: 'danger', icon: CircleX, label: 'Failed' },
  text_conflict: { tone: 'danger', icon: GitMerge, label: 'Text conflict' },
  error: { tone: 'danger', icon: CircleAlert, label: 'Error' },
  cancelled: { tone: 'neutral', icon: Ban, label: 'Cancelled' },
};

const JOB: Record<string, StatusStyle> = {
  queued: { tone: 'neutral', icon: Clock, label: 'Queued' },
  leased: { tone: 'accent', icon: LoaderCircle, label: 'Leased', spin: true },
  running: { tone: 'accent', icon: LoaderCircle, label: 'Running', spin: true },
  succeeded: { tone: 'success', icon: CircleCheck, label: 'Finished' },
  failed: { tone: 'danger', icon: CircleX, label: 'Failed' },
  cancelled: { tone: 'neutral', icon: Ban, label: 'Cancelled' },
  expired: { tone: 'danger', icon: PauseCircle, label: 'Lease expired' },
};

export const CELL: Record<CellState, StatusStyle> = {
  not_run: { tone: 'outline', icon: CircleDashed, label: CELL_LABEL.not_run },
  pending: { tone: 'neutral', icon: Clock, label: CELL_LABEL.pending },
  running: { tone: 'accent', icon: LoaderCircle, label: CELL_LABEL.running, spin: true },
  passed: { tone: 'success', icon: CircleCheck, label: CELL_LABEL.passed },
  failed: { tone: 'danger', icon: CircleX, label: CELL_LABEL.failed },
  skipped: { tone: 'outline', icon: CircleMinus, label: CELL_LABEL.skipped },
  error: { tone: 'warning', icon: CircleAlert, label: CELL_LABEL.error },
};

const INTERACTION: Record<string, StatusStyle> = {
  predicted: { tone: 'warning', icon: CircleDot, label: 'Predicted' },
  confirmed: { tone: 'danger', icon: CircleX, label: 'Confirmed failure' },
  resolved: { tone: 'success', icon: CircleCheck, label: 'Resolved' },
  unknown: { tone: 'neutral', icon: CircleDashed, label: 'Inconclusive' },
};

const PROMOTION: Record<string, StatusStyle> = {
  pending: { tone: 'accent', icon: Clock, label: 'Promotion queued' },
  running: { tone: 'accent', icon: LoaderCircle, label: 'Promotion running', spin: true },
  succeeded: { tone: 'success', icon: Rocket, label: 'Promoted' },
  stale: { tone: 'warning', icon: CircleAlert, label: 'Stale: main changed' },
  failed: { tone: 'danger', icon: CircleX, label: 'Promotion failed' },
};

const TABLES = { session: SESSION, proposal: PROPOSAL, candidate: CANDIDATE, job: JOB, interaction: INTERACTION, promotion: PROMOTION };
export type StatusKind = keyof typeof TABLES;

export function statusStyle(kind: StatusKind, value: string): StatusStyle {
  return TABLES[kind][value] ?? { tone: 'neutral', icon: CircleDot, label: humanize(value) };
}

export function StatusBadge({ kind, value, label, className }: { kind: StatusKind; value: string; label?: string; className?: string }) {
  const s = statusStyle(kind, value);
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} className={className}>
      <Icon aria-hidden className={cn(s.spin && 'motion-safe:animate-spin')} />
      {label ?? s.label}
    </Badge>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  accent: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  outline: 'text-muted-foreground',
};

export function StateIcon({ style, className }: { style: StatusStyle; className?: string }) {
  const Icon = style.icon;
  return <Icon aria-hidden className={cn('size-4 shrink-0', TONE_TEXT[style.tone], style.spin && 'motion-safe:animate-spin', className)} />;
}
