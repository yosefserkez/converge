import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runAgent } from './jobs/agent.ts';
import { type JobParams, errorCode, isStaleFence, makeContext, retrying } from './jobs/context.ts';
import { runIntegrate, runPromote, runSeed, runVerify } from './jobs/infra-jobs.ts';

/**
 * One durable workflow instance per job attempt (ID = `<job>-a<attempt>`).
 * Steps hold only IDs, digests, and R2 references. Every coordinator callback
 * carries job + fence, so a superseded attempt can never change domain state.
 */
export class JobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  override async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload;
    const coordinator = this.env.PROJECTS.getByName(params.projectSlug);
    const lease = await step.do('lease', retrying, () => coordinator.wfLease(params.jobId, params.attemptNo, params.fence));
    if (!lease) return { skipped: true };
    const ctx = makeContext(this.env, step, lease, params);
    try {
      if (lease.kind === 'agent' || lease.kind === 'verify') {
        // Pick the container runtime (storefront image or project snapshot) before first use.
        await step.do('configure runtime', retrying, async () => {
          const runtime = await coordinator.getRuntime();
          await ctx.execution.configure(runtime);
          return runtime;
        });
      }
      switch (lease.kind) {
        case 'seed':
          await runSeed(ctx);
          break;
        case 'agent':
          await runAgent(ctx);
          break;
        case 'integrate':
          await runIntegrate(ctx);
          break;
        case 'verify':
          await runVerify(ctx);
          break;
        case 'promote':
          await runPromote(ctx);
          break;
        default:
          throw new Error(`INVALID_INPUT unsupported job kind ${lease.kind}`);
      }
      return { ok: true };
    } catch (err) {
      if (isStaleFence(err)) return { superseded: true };
      const { code, message } = errorCode(err);
      await step.do('record failure', retrying, () => coordinator.wfFail(lease.jobId, lease.fence, code, message));
      await step.do('cleanup containers', retrying, async () => {
        await ctx.execution.destroyContainer('job failed').catch(() => undefined);
        return { ok: true };
      });
      return { failed: code };
    }
  }
}
