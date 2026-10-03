import type { Observation } from '@converge/domain';
import { CircleCheck, CircleX } from 'lucide-react';
import { formatValue } from '../../lib/format.ts';
import type { SequenceStep } from '../../lib/story.ts';
import { customerTier } from '../../lib/story.ts';
import type { ViewIntent } from '../../lib/view.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/primitives.tsx';

const MAX_LINES = 2000;

/**
 * Monospace text from logs, diffs, or model output. React escapes the text;
 * this component never renders HTML. Long text is cut at a fixed line count.
 */
export function SafeTextBlock({ text, className, diff = false, maxLines = MAX_LINES }: { text: string; className?: string; diff?: boolean; maxLines?: number }) {
  const lines = text.split('\n');
  const cut = lines.length > maxLines;
  const shown = cut ? lines.slice(0, maxLines) : lines;
  return (
    <div className={cn('overflow-auto rounded-md border bg-muted/40', className)}>
      <pre className="min-w-fit p-3 font-mono text-xs leading-5">
        {diff
          ? shown.map((line, i) => (
              <div
                key={i}
                className={cn(
                  'px-1 whitespace-pre',
                  line.startsWith('+') && !line.startsWith('+++') && 'bg-success-soft text-success',
                  line.startsWith('-') && !line.startsWith('---') && 'bg-danger-soft text-danger',
                  line.startsWith('@@') && 'text-info',
                  (line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')) && 'font-semibold text-foreground',
                )}
              >
                {line || ' '}
              </div>
            ))
          : shown.join('\n')}
      </pre>
      {cut && <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">Output cut at {maxLines} lines.</p>}
    </div>
  );
}

/** Text for a JSON or string evidence body. */
export function evidenceText(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function ObservationTable({ observations, onlyFailed = false }: { observations: readonly Observation[]; onlyFailed?: boolean }) {
  const rows = onlyFailed ? observations.filter((o) => !o.passed) : observations;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No observations recorded.</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Assertion</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Expected</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Observed</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o, i) => (
            <tr key={`${o.label}-${i}`} className={cn('border-t', !o.passed && 'bg-danger-soft/60')}>
              <td className="px-2.5 py-1.5 font-mono">{o.label}</td>
              <td className="px-2.5 py-1.5 font-mono">{formatValue(o.expected)}</td>
              <td className={cn('px-2.5 py-1.5 font-mono', !o.passed && 'font-semibold text-danger')}>{formatValue(o.observed)}</td>
              <td className="px-2.5 py-1.5">
                <PassFail passed={o.passed} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PassFail({ passed }: { passed: boolean }) {
  return passed ? (
    <span className="inline-flex items-center gap-1 text-success">
      <CircleCheck className="size-3.5" aria-hidden /> Pass
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-danger">
      <CircleX className="size-3.5" aria-hidden /> Fail
    </span>
  );
}

/** The request sequence of a reproducer, one row per request in order. */
export function SequenceTable({ steps }: { steps: readonly SequenceStep[] }) {
  const rows = steps.filter((s) => s.field !== 'status');
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Request sequence of the reproducer</caption>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Process</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Request</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Customer</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Expected</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Observed</th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={`${s.sequence}-${s.step}-${s.field}`} className={cn('border-t', !s.passed && 'bg-danger-soft/60')}>
              <td className="px-2.5 py-1.5 text-muted-foreground">Fresh process {s.sequence}</td>
              <td className="px-2.5 py-1.5 font-mono">
                #{s.step} POST /api/quote {s.product} · {s.field}
              </td>
              <td className="px-2.5 py-1.5">
                {s.customer} <span className="text-muted-foreground">({customerTier(s.customer)})</span>
              </td>
              <td className="px-2.5 py-1.5 font-mono">{formatValue(s.expected)}</td>
              <td className={cn('px-2.5 py-1.5 font-mono', !s.passed && 'font-semibold text-danger')}>{formatValue(s.observed)}</td>
              <td className="px-2.5 py-1.5">
                <PassFail passed={s.passed} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Declared intent: objective, contract changes, assumptions, paths, invariants. */
export function IntentDetails({ intent }: { intent: ViewIntent }) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Objective</h4>
        <p className="whitespace-pre-wrap">{intent.objective}</p>
      </section>
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Contract changes</h4>
        {intent.contractChanges.length === 0 ? (
          <p className="text-muted-foreground">None declared.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {intent.contractChanges.map((c) => (
              <li key={c.key} className="rounded-md border p-2.5">
                <p className="font-mono text-xs">{c.key}</p>
                <p className="mt-1 font-mono text-xs">
                  <span className="text-danger line-through decoration-danger/50">{formatValue(c.before)}</span>
                  {' → '}
                  <span className="text-success">{formatValue(c.after)}</span>
                </p>
                <p className="mt-1 text-muted-foreground">{c.explanation}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Assumptions</h4>
        {intent.assumptions.length === 0 ? (
          <p className="text-muted-foreground">None declared.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {intent.assumptions.map((a) => (
              <li key={`${a.key}-${a.operator}`} className="rounded-md border p-2.5">
                <p className="font-mono text-xs">
                  {a.key} <Badge tone="outline">{a.operator.replace('_', ' ')}</Badge> {formatValue(a.expected)}
                </p>
                <p className="mt-1 text-muted-foreground">{a.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="mb-1 text-xs font-medium text-muted-foreground">Changed paths</h4>
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {intent.affectedPaths.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>
      {intent.preservedInvariants && intent.preservedInvariants.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Preserved invariants</h4>
          <ul className="list-disc pl-5">
            {intent.preservedInvariants.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
