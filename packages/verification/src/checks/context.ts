import type { Capability } from '@converge/domain';
import type { InstancePool } from '../instances.ts';
import type { Recorder } from '../recorder.ts';

export interface CheckContext {
  rec: Recorder;
  pool: InstancePool;
  capabilities: ReadonlySet<Capability>;
}

export type CheckImpl = (ctx: CheckContext) => Promise<void>;
