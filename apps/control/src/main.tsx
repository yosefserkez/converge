import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app.tsx';
import { type Api, httpApi } from './lib/api.ts';
import { ApiContext } from './lib/hooks.ts';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2000 },
    mutations: { retry: false },
  },
});

async function boot() {
  // `?sample=<state>` renders built-in sample data without a backend. It is labelled in the UI.
  const sampleParam = new URLSearchParams(window.location.search).get('sample');
  let api: Api = httpApi;
  let sample: { variant: string; variants: readonly string[] } | null = null;
  if (sampleParam) {
    const mod = await import('./lib/sample-api.ts');
    const variant = (mod.SAMPLE_VARIANTS as readonly string[]).includes(sampleParam) ? (sampleParam as (typeof mod.SAMPLE_VARIANTS)[number]) : 'ready';
    api = mod.createSampleApi(variant);
    sample = { variant, variants: mod.SAMPLE_VARIANTS };
    if (window.location.pathname === '/') {
      const sessionPath = `/sessions/${(await api.listSessions()).sessions[0]!.id}`;
      window.history.replaceState(null, '', `${sessionPath}${window.location.search}`);
    }
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ApiContext.Provider value={api}>
        <QueryClientProvider client={queryClient}>
          <App sample={sample} />
        </QueryClientProvider>
      </ApiContext.Provider>
    </StrictMode>,
  );
}

void boot();
