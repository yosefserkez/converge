import { Button, CopyableId, formatAgo, StatusBadge, cn } from '@converge/ui';
import { Database, FolderGit2, LoaderCircle, Plus, Settings } from 'lucide-react';
import { useCommand, useNow, useProject, useSessions } from '../lib/hooks.ts';
import { linkProps, type Route } from '../lib/router.ts';
import { ErrorNotice } from './feedback.tsx';

function ProjectBlock() {
  const project = useProject();
  const seed = useCommand<{ jobId?: string }>('seed');
  const p = project.data;
  return (
    <section aria-labelledby="project-heading" className="flex flex-col gap-1.5">
      <h2 id="project-heading" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FolderGit2 className="size-3.5" aria-hidden /> Project
      </h2>
      {project.isPending && <p className="text-xs text-muted-foreground">The project loads…</p>}
      {project.isError && <ErrorNotice error={project.error} onRetry={() => void project.refetch()} />}
      {p && (
        <div className="flex flex-col gap-1 text-xs">
          <p className="font-medium">{p.slug}</p>
          {'canonicalRepo' in p && (
            <p className="text-muted-foreground">
              Repo <span className="font-mono text-foreground">{p.canonicalRepo}</span>
            </p>
          )}
          {'observedMainSha' in p && p.observedMainSha ? (
            <p className="flex items-center gap-1 text-muted-foreground">
              main <CopyableId value={p.observedMainSha} label="Copy observed main SHA" />
            </p>
          ) : null}
          {'seedJobStatus' in p && p.seedJobStatus === 'running' && (
            <p className="flex items-center gap-1 text-info">
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden /> Seed of the synthetic project in progress
            </p>
          )}
          {!p.seeded && (
            <>
              <p className="text-muted-foreground">The synthetic storefront is not seeded yet.</p>
              <Button size="sm" onClick={() => seed.mutate({ path: '/api/admin/seed' })} disabled={seed.isPending}>
                <Database aria-hidden /> {seed.isPending ? 'Seed sent…' : 'Seed the project'}
              </Button>
            </>
          )}
          {'presetCompatible' in p && p.seeded && !p.presetCompatible && (
            <p className="text-warning">Main moved away from the preset baseline. New sessions use the preset baseline only.</p>
          )}
          <ErrorNotice error={seed.error} onDismiss={() => seed.reset()} onRetry={() => seed.mutate({ path: '/api/admin/seed' })} />
          {seed.isSuccess && <p className="text-success">Seed accepted. Progress shows here.</p>}
        </div>
      )}
    </section>
  );
}

function SessionHistory({ route }: { route: Route }) {
  const sessions = useSessions();
  const now = useNow(15_000);
  const currentId = route.name === 'session' ? route.sessionId : null;
  return (
    <section aria-labelledby="history-heading" className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h2 id="history-heading" className="text-xs font-medium text-muted-foreground">
          Sessions
        </h2>
        <a {...linkProps('/')} className="inline-flex items-center gap-0.5 rounded px-1 text-xs text-primary hover:underline">
          <Plus className="size-3.5" aria-hidden /> New
        </a>
      </div>
      {sessions.isPending && <p className="text-xs text-muted-foreground">Sessions load…</p>}
      {sessions.isError && <ErrorNotice error={sessions.error} onRetry={() => void sessions.refetch()} />}
      {sessions.data && sessions.data.sessions.length === 0 && <p className="text-xs text-muted-foreground">No sessions yet.</p>}
      <ul className="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {sessions.data?.sessions.map((s) => (
          <li key={s.id}>
            <a
              {...linkProps(`/sessions/${s.id}`)}
              aria-current={s.id === currentId ? 'page' : undefined}
              className={cn('flex flex-col gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-muted', s.id === currentId && 'bg-accent text-accent-foreground')}
            >
              <span className="flex items-center justify-between gap-1">
                <StatusBadge kind="session" value={s.status} />
                <span className="text-muted-foreground">{formatAgo(s.createdAt, now)}</span>
              </span>
              <span className="truncate text-muted-foreground">{s.mode === 'live' ? 'Live' : 'Fixture'} · {s.id}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SidebarContent({ route }: { route: Route }) {
  return (
    <div className="flex h-full flex-col gap-5 p-3">
      <a {...linkProps('/')} className="flex items-center gap-2 px-1 font-semibold">
        <span aria-hidden className="inline-block size-5 rounded bg-primary" />
        Converge
      </a>
      <ProjectBlock />
      <SessionHistory route={route} />
      <a
        {...linkProps('/settings')}
        aria-current={route.name === 'settings' ? 'page' : undefined}
        className={cn('flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-muted', route.name === 'settings' && 'bg-accent text-accent-foreground')}
      >
        <Settings className="size-3.5" aria-hidden /> Settings and limits
      </a>
    </div>
  );
}

