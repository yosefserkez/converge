import type { ConfigDto, SessionSnapshot } from '@converge/ui';
import * as sample from '@converge/ui/sample';
import { type Api, ApiError } from './api.ts';

// Sample mode (`?sample=<variant>`): a fake Api over sample data. No request
// reaches the control plane. The UI shows a "Sample data" banner in this mode.

const SAMPLE_CONFIG: ConfigDto = {
  environment: 'local',
  projectSlug: 'storefront',
  buildId: 'sample',
  authMode: 'local',
  operator: 'operator@example.com',
  liveExecutionEnabled: true,
  modelId: 'claude-opus-5-5',
  defaultBudgetMicroUsd: 5_000_000,
  limits: { maxConcurrentAgents: 3, maxCandidatesPerSession: 8, maxRepairAttempts: 2, maxAgentTurns: 30, previewTtlSeconds: 90 },
  previewOrigin: 'https://converge-preview.example.workers.dev',
};

const notFound = (what: string) => new ApiError({ status: 404, code: 'NOT_FOUND', message: `${what} is not in the sample data.`, retryable: false });
const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export function createSampleApi(variant: sample.SampleVariant): Api {
  const snap: SessionSnapshot = sample.sampleSnapshot(variant);
  return {
    sample: true,
    getConfig: () => delay(SAMPLE_CONFIG),
    getProject: () =>
      delay({
        seeded: true,
        slug: 'storefront',
        canonicalRepo: snap.project!.canonicalRepo,
        defaultBranch: 'main',
        observedMainSha: snap.project!.observedMainSha,
        presetBaselineSha: snap.session.baselineSha,
        seedJobStatus: 'succeeded',
        presetCompatible: true,
      }),
    listSessions: () =>
      delay({
        sessions: [
          { id: snap.session.id, mode: snap.session.mode, status: snap.session.status, objective: snap.session.objective, createdAt: snap.session.createdAt, finishedAt: snap.session.finishedAt },
          { id: 'ses_sample_older00000000000000', mode: 'fixture', status: 'cancelled', objective: snap.session.objective, createdAt: snap.session.createdAt - 86_400_000, finishedAt: snap.session.createdAt - 86_000_000 },
        ],
      }),
    getSnapshot: (id) => (id === snap.session.id ? delay(snap) : Promise.reject(notFound('This session'))),
    getEvents: (_id, after) => delay(after === 0 ? sample.sampleEvents(snap) : { events: [], cursor: after, hasMore: false }),
    getProposal: (id) => {
      const p = sample.sampleProposalDetail(snap, id);
      return p ? delay(p) : Promise.reject(notFound('This proposal'));
    },
    getCandidate: (id) => {
      const c = sample.sampleCandidateDetail(snap, id);
      return c ? delay(c) : Promise.reject(notFound('This candidate'));
    },
    getEvidence: (id) => {
      const e = sample.sampleEvidence(snap, id);
      return e ? delay(e) : Promise.reject(notFound('This evidence'));
    },
    command: async <T>(path: string): Promise<T> => {
      await delay(null, 300);
      if (path.endsWith('/preview')) {
        const html = '<!doctype html><title>Sample preview</title><body style="font:14px system-ui;padding:24px"><h1>Sample preview</h1><p>A real preview shows the candidate storefront from the preview origin.</p></body>';
        return { previewId: 'prev_sample', url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, expiresAt: Date.now() + 45_000 } as T;
      }
      if (path.endsWith('/publish-replay')) return { replayId: 'rpl_sample00000000000000000000', digest: 'sha256:sample' } as T;
      throw new ApiError({
        status: 409,
        code: 'SAMPLE_MODE',
        message: 'Sample data: this action did not reach the API. Remove ?sample from the URL to use the control plane.',
        retryable: false,
        requestId: 'sample',
      });
    },
  };
}

export const SAMPLE_VARIANTS = sample.SAMPLE_VARIANTS;
export type SampleVariant = sample.SampleVariant;
