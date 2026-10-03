import { Card, CardContent, CardHeader, CardTitle, formatMicroUsd } from '@converge/ui';
import { useConfig } from '../lib/hooks.ts';
import { ErrorNotice, LoadingBlock } from './feedback.tsx';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-b py-2 last:border-b-0 sm:grid-cols-[220px_1fr]">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{value}</dd>
    </div>
  );
}

export function SettingsPage() {
  const config = useConfig();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Settings and limits</h1>
        <p className="text-sm text-muted-foreground">Read-only. The deployment configuration sets these values.</p>
      </div>
      {config.isPending && <LoadingBlock label="The configuration loads" rows={2} />}
      <ErrorNotice error={config.error} onRetry={() => void config.refetch()} />
      {config.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Environment</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Environment" value={config.data.environment} />
                <Row label="Project" value={config.data.projectSlug} />
                <Row label="Build" value={<code className="font-mono text-xs">{config.data.buildId}</code>} />
                <Row label="Operator" value={config.data.operator} />
                <Row label="Sign-in mode" value={config.data.authMode === 'local' ? 'Local development bypass' : 'Cloudflare Access'} />
                <Row label="Preview origin" value={<code className="font-mono text-xs">{config.data.previewOrigin}</code>} />
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Model and budget</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Live execution" value={config.data.liveExecutionEnabled ? 'On' : 'Off (fixture mode only)'} />
                <Row label="Model" value={<code className="font-mono text-xs">{config.data.modelId}</code>} />
                <Row label="Default budget ceiling" value={`${formatMicroUsd(config.data.defaultBudgetMicroUsd)} per session`} />
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Limits</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Concurrent agents" value={config.data.limits.maxConcurrentAgents} />
                <Row label="Candidates per session" value={config.data.limits.maxCandidatesPerSession} />
                <Row label="Repair attempts" value={config.data.limits.maxRepairAttempts} />
                <Row label="Agent turns" value={config.data.limits.maxAgentTurns} />
                <Row label="Preview lifetime" value={`${config.data.limits.previewTtlSeconds} s`} />
              </dl>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
