// Remove temporary resources this project owns. Defaults to a dry run.
//   pnpm cleanup --env dev --dry-run     list what would be deleted
//   pnpm cleanup --env dev --apply       delete it
// Scope: Artifacts repositories in this environment's namespace whose names
// match the Converge session pattern (cv-ses_*). The canonical repository
// (cv-<project>-b-main) is always kept, and so is any session listed with
// --keep <sessionId>. R2 evidence, approvals, and published replays are never
// deleted by this script. No account-level deletes.
import { ENVIRONMENTS, cf, loadEnvLocal, parseArgs, step } from './lib.ts';

loadEnvLocal();
const args = parseArgs();
const names = ENVIRONMENTS[args.env];
const argv = process.argv.slice(2);
const keep = new Set(argv.flatMap((a, i) => (a === '--keep' && argv[i + 1] ? [argv[i + 1]!.replace(/_/g, '-')] : [])));

step(`Artifacts repositories in namespace ${names.namespace} (${args.dryRun ? 'dry run' : 'apply'})`);
const repos: Array<{ name: string }> = [];
let cursor: string | undefined;
do {
  const page = await cf<Array<{ name: string }> & { cursor?: string }>(
    `/artifacts/namespaces/${names.namespace}/repos?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  repos.push(...page);
  cursor = (page as { cursor?: string }).cursor;
} while (cursor);

const SESSION_REPO = /^cv-ses-[a-z0-9]+-[pc]-[a-z0-9-]+$/;
let count = 0;
for (const r of repos) {
  const owned = SESSION_REPO.test(r.name);
  const kept = [...keep].some((k) => r.name.startsWith(`cv-${k}-`));
  if (!owned) {
    console.log(`keep  ${r.name} (canonical or not a session repo)`);
    continue;
  }
  if (kept) {
    console.log(`keep  ${r.name} (--keep)`);
    continue;
  }
  count++;
  if (args.apply) {
    await cf(`/artifacts/namespaces/${names.namespace}/repos/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
    console.log(`deleted ${r.name}`);
  } else {
    console.log(`would delete ${r.name}`);
  }
}
console.log(`\n${count} session repositories ${args.apply ? 'deleted' : 'would be deleted'}.`);
if (args.dryRun) console.log('Dry run only. Re-run with --apply to delete.');
