import { useCallback, useSyncExternalStore } from 'react';

// A small path router. The Worker serves the SPA for every non-API path.

export type Route = { name: 'home' } | { name: 'session'; sessionId: string } | { name: 'settings' } | { name: 'not_found' };

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' };
  if (pathname === '/settings') return { name: 'settings' };
  const m = /^\/sessions\/([A-Za-z0-9_-]{1,64})\/?$/.exec(pathname);
  if (m) return { name: 'session', sessionId: m[1]! };
  return { name: 'not_found' };
}

const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
};

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, () => window.location.pathname);
  return parseRoute(path);
}

/** Navigate inside the SPA. The query string (for example ?sample=ready) stays. */
export function navigate(path: string) {
  const url = `${path}${window.location.search}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}

export function useNavigate() {
  return useCallback((path: string) => navigate(path), []);
}

/** Props for an <a> that navigates inside the SPA and still works with a middle click. */
export function linkProps(path: string) {
  return {
    href: `${path}${typeof window !== 'undefined' ? window.location.search : ''}`,
    onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
