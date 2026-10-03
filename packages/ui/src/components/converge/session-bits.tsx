import { FlaskConical, History, Radio } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatMicroUsd } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';
import type { ViewSession } from '../../lib/view.ts';
import { Badge } from '../ui/primitives.tsx';

export const FIXTURE_LABEL = 'Fixture agents - no model calls';

export function ModeBadge({ mode, replay = false }: { mode: string; replay?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {replay && (
        <Badge tone="accent">
          <History aria-hidden /> Replay
        </Badge>
      )}
      {mode === 'live' ? (
        <Badge tone="neutral">
          <Radio aria-hidden /> Live
        </Badge>
      ) : (
        <Badge tone="warning">
          <FlaskConical aria-hidden /> {FIXTURE_LABEL}
        </Badge>
      )}
    </span>
  );
}

/** Spent, reserved, and uncertain spend against the ceiling. Amounts are integer micro-USD. */
export function BudgetSummary({ budget, mode }: { budget: ViewSession['budget']; mode: string }) {
  const { spentMicroUsd: spent, uncertainMicroUsd: uncertain, ceilingMicroUsd: ceiling } = budget;
  const reserved = budget.reservedMicroUsd ?? 0;
  const used = spent + reserved + uncertain;
  const ratio = ceiling > 0 ? Math.min(1, used / ceiling) : 0;
  const exhausted = ceiling > 0 && used >= ceiling;
  const seg = (v: number) => `${ceiling > 0 ? Math.min(100, (v / ceiling) * 100) : 0}%`;
  return (
    <div className="flex min-w-[180px] flex-col gap-1 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">Model budget</span>
        <span className={cn('font-medium tabular-nums', exhausted && 'text-danger')}>
          {formatMicroUsd(used)} / {formatMicroUsd(ceiling)}
        </span>
      </div>
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={ceiling}
        aria-valuenow={Math.min(used, ceiling)}
        aria-label="Model budget used"
      >
        <span className="bg-primary" style={{ width: seg(spent) }} />
        <span className="bg-primary/40" style={{ width: seg(reserved) }} />
        <span className="bg-warning" style={{ width: seg(uncertain) }} />
      </div>
      <p className="text-muted-foreground tabular-nums">
        Spent {formatMicroUsd(spent)}
        {reserved > 0 && <> · reserved {formatMicroUsd(reserved)}</>}
        {uncertain > 0 && <> · uncertain {formatMicroUsd(uncertain)}</>}
        {mode === 'fixture' && <> · fixture mode uses no model budget</>}
        {exhausted && <span className="font-medium text-danger"> · budget exhausted</span>}
        {!exhausted && ratio > 0.8 && <span className="text-warning"> · near the ceiling</span>}
      </p>
    </div>
  );
}

export function SectionHeading({ title, description, actions, id }: { title: string; description?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
