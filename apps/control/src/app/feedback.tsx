import { Alert, AlertDescription, AlertTitle, Button, CopyableId, Skeleton } from '@converge/ui';
import { CircleAlert, CloudOff, LoaderCircle, RefreshCw, ShieldAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api.ts';

function titleFor(e: ApiError): string {
  if (e.status === 0) return 'The control plane is unreachable';
  if (e.status === 401 || e.status === 403) return 'Not authorized';
  if (e.status === 409) return 'The request conflicts with the current state';
  if (e.status === 422) return 'The request data is not valid';
  if (e.status === 429) return 'A limit stopped this request';
  if (e.status === 503) return 'A service is unavailable';
  return 'The request failed';
}

function Blockers({ details }: { details: unknown }) {
  const blockers = (details as { blockers?: Array<{ code: string; reason: string }> } | null)?.blockers;
  const d = details as { expectedMainSha?: string; observedMainSha?: string } | null;
  return (
    <>
      {Array.isArray(blockers) && blockers.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {blockers.map((b) => (
            <li key={b.code + b.reason}>
              <code className="font-mono text-xs">{b.code}</code>: {b.reason}
            </li>
          ))}
        </ul>
      )}
      {d?.expectedMainSha && (
        <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          Expected main <CopyableId value={d.expectedMainSha} /> · observed main <CopyableId value={d.observedMainSha ?? null} />
        </p>
      )}
    </>
  );
}

/** A durable inline error. It stays until the operator dismisses it or the action succeeds. */
export function ErrorNotice({ error, onRetry, onDismiss, className }: { error: unknown; onRetry?: () => void; onDismiss?: () => void; className?: string }) {
  if (!error) return null;
  const e =
    error instanceof ApiError
      ? error
      : new ApiError({ status: 0, code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : String(error), retryable: false });
  const Icon = e.status === 0 ? CloudOff : e.status === 401 || e.status === 403 ? ShieldAlert : CircleAlert;
  return (
    <Alert tone="danger" className={className}>
      <Icon aria-hidden />
      <div className="min-w-0 flex-1">
        <AlertTitle>{titleFor(e)}</AlertTitle>
        <AlertDescription>
          <p className="text-foreground">{e.message}</p>
          <Blockers details={e.details} />
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
            <code className="font-mono">{e.code}</code>
            {e.status > 0 && <span>HTTP {e.status}</span>}
            {e.requestId && (
              <span className="inline-flex items-center gap-1">
                request <CopyableId value={e.requestId} short={false} label="Copy request ID" />
              </span>
            )}
          </p>
        </AlertDescription>
        {(onRetry || e.status === 401) && (
          <div className="mt-2 flex gap-2">
            {e.status === 401 || e.status === 403 ? (
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                Reload and sign in
              </Button>
            ) : (
              onRetry &&
              (e.retryable || e.status === 0) && (
                <Button size="sm" variant="outline" onClick={onRetry}>
                  <RefreshCw aria-hidden /> Try again
                </Button>
              )
            )}
          </div>
        )}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="-mt-0.5 -mr-1 size-6 shrink-0 cursor-pointer rounded text-muted-foreground hover:bg-muted" aria-label="Dismiss error">
          <X className="mx-auto size-4" aria-hidden />
        </button>
      )}
    </Alert>
  );
}

export function LoadingBlock({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden /> {label}
      </p>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-6">
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}
