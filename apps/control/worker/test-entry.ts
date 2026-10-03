// Test entry for the Workers Vitest pool. It exposes only the coordinator and a
// stub job workflow, so the tests need no containers and no Artifacts binding.
import { WorkflowEntrypoint } from 'cloudflare:workers';

export { ProjectCoordinator } from './coordinator/index.ts';

/** Stub for the JOBS binding. The tests drive each job through the coordinator callbacks. */
export class JobWorkflow extends WorkflowEntrypoint<Env, unknown> {
  override async run(): Promise<unknown> {
    return { stub: true };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('converge test entry', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
