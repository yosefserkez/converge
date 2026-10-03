import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fromSnapshot, isActive, type EventsPage, type SessionSnapshot, type SessionView } from '@converge/ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type Api, ApiError, httpApi, newIdempotencyKey } from './api.ts';

export const ApiContext = createContext<Api>(httpApi);
export const useApi = () => useContext(ApiContext);

/** The current time, updated on an interval, for countdowns and "ago" labels. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const queryKeys = {
  config: ['config'] as const,
  project: ['project'] as const,
  sessions: ['sessions'] as const,
  snapshot: (id: string) => ['snapshot', id] as const,
  proposal: (id: string) => ['proposal', id] as const,
  candidate: (id: string) => ['candidate', id] as const,
  evidence: (id: string) => ['evidence', id] as const,
  log: (id: string) => ['log', id] as const,
};

export function useConfig() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: 60_000 });
}

export function useProject() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.project, queryFn: () => api.getProject(), refetchInterval: (q) => (q.state.data && 'seedJobStatus' in q.state.data && q.state.data.seedJobStatus === 'running' ? 2000 : 30_000) });
}

export function useSessions() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.sessions, queryFn: () => api.listSessions(), refetchInterval: 15_000 });
}

/**
 * One command per user action. The hook keeps the Idempotency-Key for a retry
 * of the same action after a network or retryable error, and makes a new key
 * after success or a final error.
 */
export function useCommand<T = unknown>(actionKey: string) {
  const api = useApi();
  const qc = useQueryClient();
  const keyRef = useRef<{ action: string; key: string } | null>(null);
  return useMutation<T, ApiError, { path: string; body?: object }>({
    mutationFn: ({ path, body }) => {
      if (!keyRef.current || keyRef.current.action !== actionKey) keyRef.current = { action: actionKey, key: newIdempotencyKey() };
      return api.command<T>(path, body ?? {}, keyRef.current.key);
    },
    onSuccess: () => {
      keyRef.current = null;
      void qc.invalidateQueries();
    },
    onError: (e) => {
      const retrySameKey = e instanceof ApiError && (e.status === 0 || e.retryable);
      if (!retrySameKey) keyRef.current = null;
    },
  });
}

export type Connection = { state: 'connecting' | 'live' | 'idle' | 'retrying'; failures: number; nextRetryAt: number | null; lastOkAt: number | null };
type SessionEvent = EventsPage['events'][number];

const MAX_EVENTS = 500;

/**
 * Snapshot plus cursor polling. About 1 s while the session has work in flight,
 * slower when idle, exponential backoff when requests fail. New events
 * invalidate the snapshot. Events are deduplicated by seq.
 */
export function useSessionLive(sessionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const snapshot = useQuery({
    queryKey: queryKeys.snapshot(sessionId),
    queryFn: () => api.getSnapshot(sessionId),
    retry: (count, err) => count < 2 && !(err instanceof ApiError && [401, 403, 404].includes(err.status)),
    refetchOnWindowFocus: false,
  });
  const [connection, setConnection] = useState<Connection>({ state: 'connecting', failures: 0, nextRetryAt: null, lastOkAt: null });
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const cursor = useRef<number | null>(null);
  const seen = useRef(new Set<number>());
  const busy = useRef(true);
  const wake = useRef<() => void>(() => {});

  const data = snapshot.data;
  useEffect(() => {
    if (data && cursor.current === null) cursor.current = data.watermark;
    if (data) busy.current = hasWorkInFlight(data);
  }, [data]);

  useEffect(() => {
    cursor.current = null;
    seen.current = new Set();
    setEvents([]);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let idleTicks = 0;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };
    wake.current = () => schedule(0);
    async function tick() {
      if (stopped) return;
      if (cursor.current === null) {
        const cached = qc.getQueryData<SessionSnapshot>(queryKeys.snapshot(sessionId));
        if (!cached) return schedule(400);
        cursor.current = cached.watermark;
      }
      try {
        const page = await api.getEvents(sessionId, cursor.current, 200);
        if (stopped) return;
        failures = 0;
        const fresh = page.events.filter((e) => !seen.current.has(e.seq));
        for (const e of fresh) seen.current.add(e.seq);
        cursor.current = Math.max(cursor.current ?? 0, page.cursor);
        if (fresh.length) {
          idleTicks = 0;
          setEvents((prev) => [...prev, ...fresh].slice(-MAX_EVENTS));
          void qc.invalidateQueries({ queryKey: queryKeys.snapshot(sessionId) });
          void qc.invalidateQueries({ queryKey: queryKeys.sessions });
        } else {
          idleTicks++;
        }
        const active = busy.current && document.visibilityState === 'visible';
        const ms = page.hasMore ? 0 : active ? 1000 : Math.min(15_000, 2000 * 2 ** Math.min(idleTicks, 3));
        setConnection({ state: active ? 'live' : 'idle', failures: 0, nextRetryAt: null, lastOkAt: Date.now() });
        schedule(ms);
      } catch (e) {
        if (stopped) return;
        failures++;
        const ms = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
        setConnection((c) => ({ state: 'retrying', failures, nextRetryAt: Date.now() + ms, lastOkAt: c.lastOkAt }));
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return; // do not hammer a sign-in wall
        schedule(ms);
      }
    }
    const onVisible = () => document.visibilityState === 'visible' && schedule(0);
    document.addEventListener('visibilitychange', onVisible);
    schedule(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api, qc, sessionId]);

  const retryNow = useCallback(() => {
    void snapshot.refetch();
    wake.current();
  }, [snapshot]);

  const view: SessionView | undefined = useMemo(() => (data ? fromSnapshot(data, api.sample ? 'sample' : 'operator') : undefined), [data, api.sample]);
  return { snapshot, view, events, connection, retryNow };
}

function hasWorkInFlight(s: SessionSnapshot): boolean {
  if (isActive(s.session.status)) return true;
  if (s.jobs.some((j) => j.status === 'queued' || j.status === 'leased' || j.status === 'running')) return true;
  return s.promotions.some((p) => p.state === 'pending' || p.state === 'running');
}
