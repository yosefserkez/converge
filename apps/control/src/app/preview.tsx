import { Alert, AlertDescription, AlertTitle, Button, CopyableId, formatCountdown, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@converge/ui';
import { Clock, MonitorPlay, TimerOff } from 'lucide-react';
import { useCommand, useNow } from '../lib/hooks.ts';
import { ErrorNotice } from './feedback.tsx';

export interface PreviewGrant {
  candidateId: string;
  label: string;
  headSha: string;
  url: string;
  expiresAt: number;
}

/** Allocate a time-limited preview of a materialized candidate. */
export function PreviewButton({
  candidate,
  onOpen,
  size = 'sm',
}: {
  candidate: { id: string; label: string; headSha: string | null };
  onOpen: (g: PreviewGrant) => void;
  size?: 'sm' | 'default';
}) {
  const preview = useCommand<{ url: string; expiresAt: number }>(`preview:${candidate.id}:${candidate.headSha}`);
  if (!candidate.headSha) return null;
  const run = () =>
    preview.mutate(
      { path: `/api/candidates/${candidate.id}/preview` },
      { onSuccess: (r) => onOpen({ candidateId: candidate.id, label: candidate.label, headSha: candidate.headSha!, url: r.url, expiresAt: r.expiresAt }) },
    );
  return (
    <span className="inline-flex flex-col gap-1">
      <Button size={size} variant="outline" onClick={run} disabled={preview.isPending} aria-label={`Open a preview of ${candidate.label}`}>
        <MonitorPlay aria-hidden /> {preview.isPending ? 'Preview starts…' : 'Preview'}
      </Button>
      <ErrorNotice error={preview.error} onDismiss={() => preview.reset()} onRetry={run} />
    </span>
  );
}

/**
 * The preview runs on a separate origin in a sandboxed iframe: scripts and
 * forms only, no same-origin access, no top navigation, no popups.
 */
export function PreviewSheet({ grant, onClose, onRenew }: { grant: PreviewGrant | null; onClose: () => void; onRenew: (g: PreviewGrant) => void }) {
  const now = useNow(1000);
  const expired = grant ? now >= grant.expiresAt : false;
  return (
    <Sheet open={grant !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-4xl">
        {grant && (
          <>
            <SheetHeader>
              <SheetTitle>Preview: {grant.label}</SheetTitle>
              <SheetDescription render={<div />}>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    Exact head <CopyableId value={grant.headSha} label="Copy preview head SHA" />
                  </span>
                  {expired ? (
                    <span className="inline-flex items-center gap-1 font-medium text-danger">
                      <TimerOff className="size-3.5" aria-hidden /> Expired
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 tabular-nums" aria-live="off">
                      <Clock className="size-3.5" aria-hidden /> Expires in {formatCountdown(grant.expiresAt - now)}
                    </span>
                  )}
                </span>
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="flex flex-col gap-3">
              {expired ? (
                <Alert tone="warning">
                  <TimerOff aria-hidden />
                  <div className="flex flex-col gap-2">
                    <AlertTitle>This preview expired</AlertTitle>
                    <AlertDescription>Previews have a hard time limit and cannot be extended. Start a new preview of the same commit to look again.</AlertDescription>
                    <div>
                      <PreviewButton candidate={{ id: grant.candidateId, label: grant.label, headSha: grant.headSha }} onOpen={onRenew} />
                    </div>
                  </div>
                </Alert>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    The candidate app runs on the preview origin in a sandbox. It cannot read this page, navigate it, or open windows.
                  </p>
                  <iframe
                    key={grant.url}
                    src={grant.url}
                    title={`Preview of ${grant.label}`}
                    sandbox="allow-scripts allow-forms"
                    referrerPolicy="no-referrer"
                    className="h-[70vh] w-full rounded-md border bg-white"
                  />
                </>
              )}
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
