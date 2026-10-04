// Plain types shared by the coordinator, jobs, and the execution container.
// No Worker imports here: browser type checks follow these files.

export type Runtime = { kind: 'storefront' } | { kind: 'project'; snapshotId: string };

/** Serve command for the candidate app. `{port}` and `{stateDir}` are filled in by the container. */
export interface ServeSpec {
  argv: string[];
  readyPath: string;
}
