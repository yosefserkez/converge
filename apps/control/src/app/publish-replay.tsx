import { Button, CopyButton } from '@converge/ui';
import { ExternalLink, Share2 } from 'lucide-react';
import { useCommand } from '../lib/hooks.ts';
import { ErrorNotice } from './feedback.tsx';

/** Publish a redacted read-only replay and show its public URL. */
export function PublishReplay({ sessionId, previewOrigin, status }: { sessionId: string; previewOrigin: string; status: string }) {
  const publish = useCommand<{ replayId: string }>(`publish:${sessionId}`);
  const url = publish.data ? `${previewOrigin.replace(/\/$/, '')}/replay/${publish.data.replayId}` : null;
  const run = () => publish.mutate({ path: `/api/sessions/${sessionId}/publish-replay` });
  return (
    <div className="flex max-w-md flex-col items-end gap-1.5">
      {!url && (
        <Button variant="outline" onClick={run} disabled={publish.isPending} title={status === 'ready' ? 'The replay records the session as it is now' : undefined}>
          <Share2 aria-hidden /> {publish.isPending ? 'Wait…' : 'Publish replay'}
        </Button>
      )}
      {url && (
        <div className="flex w-full flex-col gap-1 rounded-md border bg-success-soft/60 p-2 text-xs">
          <p className="font-medium text-success">Replay published. Anyone with this link can view it.</p>
          <div className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono" title={url}>
              {url}
            </code>
            <CopyButton value={url} label="Copy replay URL" />
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex size-6 items-center justify-center rounded hover:bg-muted" aria-label="Open the replay in a new tab">
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </div>
        </div>
      )}
      <ErrorNotice error={publish.error} onDismiss={() => publish.reset()} onRetry={run} />
    </div>
  );
}
