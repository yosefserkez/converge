import { Sheet, SheetContent, SheetTitle, cn } from '@converge/ui';
import { FlaskConical, Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { linkProps, useRoute } from '../lib/router.ts';
import { EmptyState } from './feedback.tsx';
import { HomePage } from './home.tsx';
import { SessionPage } from './session-page.tsx';
import { SettingsPage } from './settings.tsx';
import { SidebarContent } from './sidebar.tsx';

function SampleBanner({ variant, variants }: { variant: string; variants: readonly string[] }) {
  const href = (v: string) => {
    const u = new URL(window.location.href);
    u.searchParams.set('sample', v);
    return `${u.pathname}${u.search}`;
  };
  return (
    <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning-soft px-4 py-1.5 text-xs">
      <span className="inline-flex items-center gap-1.5 font-semibold text-warning">
        <FlaskConical className="size-3.5" aria-hidden /> Sample data
      </span>
      <span className="text-muted-foreground">This page shows built-in sample data, not a recording. No request reaches the API.</span>
      <nav aria-label="Sample states" className="flex flex-wrap gap-2">
        {variants.map((v) => (
          <a key={v} href={href(v)} aria-current={v === variant ? 'true' : undefined} className={cn('rounded px-1 hover:underline', v === variant && 'bg-card font-semibold')}>
            {v}
          </a>
        ))}
      </nav>
    </div>
  );
}

export function App({ sample }: { sample: { variant: string; variants: readonly string[] } | null }) {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [route]);

  return (
    <div className="flex min-h-dvh flex-col">
      {sample && <SampleBanner variant={sample.variant} variants={sample.variants} />}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-card focus:px-2 focus:py-1">
        Skip to content
      </a>
      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r bg-sidebar md:block" aria-label="Project and sessions">
          <SidebarContent route={route} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b bg-sidebar px-4 py-2 md:hidden">
            <a {...linkProps('/')} className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="inline-block size-4 rounded bg-primary" /> Converge
            </a>
            <button type="button" onClick={() => setMenuOpen(true)} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-muted" aria-label="Open the project and session menu">
              <Menu className="size-4" aria-hidden /> Menu
            </button>
          </div>
          <main id="main" className="w-full max-w-[1400px] flex-1 px-4 py-5 md:px-6">
            {route.name === 'home' && <HomePage />}
            {route.name === 'settings' && <SettingsPage />}
            {route.name === 'session' && <SessionPage key={route.sessionId} sessionId={route.sessionId} />}
            {route.name === 'not_found' && (
              <EmptyState
                title="Page not found"
                action={
                  <a {...linkProps('/')} className="text-sm text-primary hover:underline">
                    Go to sessions
                  </a>
                }
              />
            )}
          </main>
        </div>
      </div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent className="max-w-xs">
          <SheetTitle className="sr-only">Project and sessions</SheetTitle>
          <SidebarContent route={route} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
