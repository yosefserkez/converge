import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { shortSha } from '../../lib/format.ts';
import { cn } from '../../lib/utils.ts';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy button. It states the result in text for screen readers. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        setState((await writeClipboard(value)) ? 'copied' : 'failed');
      }}
      className={cn(
        'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
      aria-label={`${label}: ${value}`}
      title={state === 'failed' ? 'Copy failed. Select the text and copy it.' : `${label}`}
    >
      {state === 'copied' ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}

/**
 * A copyable identifier. It shows a short form and keeps the full value in the
 * copy action and the title.
 */
export function CopyableId({
  value,
  short = true,
  length = 7,
  label = 'Copy ID',
  className,
}: {
  value: string | null | undefined;
  short?: boolean;
  length?: number;
  label?: string;
  className?: string;
}) {
  if (!value) return <span className={cn('font-mono text-xs text-muted-foreground', className)}>—</span>;
  const shown = short ? (value.startsWith('sha256:') || /^[0-9a-f]{40,64}$/.test(value) ? shortSha(value, length) : value) : value;
  return (
    <span className={cn('inline-flex max-w-full min-w-0 items-center gap-0.5', className)}>
      <code className="truncate font-mono text-xs" title={value}>
        {shown}
      </code>
      <CopyButton value={value} label={label} />
    </span>
  );
}
