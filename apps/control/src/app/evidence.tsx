import { Badge, CopyableId, evidenceText, SafeTextBlock, formatValue } from '@converge/ui';
import { ShieldCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys, useApi } from '../lib/hooks.ts';
import { ErrorNotice, LoadingBlock } from './feedback.tsx';

/** Fetch and show one registered evidence object as escaped text. */
export function EvidenceView({ evidenceId, diff = false }: { evidenceId: string; diff?: boolean }) {
  const api = useApi();
  const q = useQuery({ queryKey: queryKeys.evidence(evidenceId), queryFn: () => api.getEvidence(evidenceId), staleTime: Infinity });
  if (q.isPending) return <LoadingBlock label="Evidence loads" rows={1} />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const e = q.data;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone={e.verified ? 'success' : 'warning'}>
          <ShieldCheck aria-hidden /> {e.verified ? 'Digest verified' : 'Not verified'}
        </Badge>
        <span>{e.kind}</span>
        <span>{formatValue(e.bytes)} bytes</span>
        <CopyableId value={e.sha256} label="Copy evidence digest" />
      </p>
      <SafeTextBlock text={evidenceText(e.content)} diff={diff} className="max-h-[60vh]" />
    </div>
  );
}
