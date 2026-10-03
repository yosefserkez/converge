import { STOREFRONT_GOAL, STOREFRONT_TASKS } from '@converge/domain/catalog';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  FIXTURE_LABEL,
  formatMicroUsd,
  Input,
  Label,
  parseDollarsToMicroUsd,
} from '@converge/ui';
import { FlaskConical, Play, Radio } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useCommand, useConfig, useProject, useSessions } from '../lib/hooks.ts';
import { linkProps, useNavigate } from '../lib/router.ts';
import { ErrorNotice } from './feedback.tsx';

function NewSessionForm() {
  const config = useConfig();
  const project = useProject();
  const navigate = useNavigate();
  const create = useCommand<{ sessionId: string }>('create-session');
  const liveEnabled = config.data?.liveExecutionEnabled ?? false;
  const [mode, setMode] = useState<'fixture' | 'live'>('fixture');
  const [budgetText, setBudgetText] = useState('');
  const budgetId = useId();
  useEffect(() => {
    if (config.data && budgetText === '') setBudgetText((config.data.defaultBudgetMicroUsd / 1_000_000).toFixed(2));
  }, [config.data, budgetText]);
  const budget = parseDollarsToMicroUsd(budgetText);
  const budgetInvalid = mode === 'live' && (budget === null || budget <= 0 || budget > 100_000_000);
  const seeded = project.data?.seeded ?? false;

  const run = () => {
    if (budgetInvalid) return;
    create.mutate(
      { path: '/api/sessions', body: mode === 'live' && budget ? { mode, modelBudgetMicroUsd: budget } : { mode } },
      { onSuccess: (r) => navigate(`/sessions/${r.sessionId}`) },
    );
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run();
  };

  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>New session</CardTitle>
          <CardDescription>Converge freezes the preset goal, the baseline, the mode, and the budget when you create the session.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium">Mode</legend>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 has-checked:border-primary has-checked:bg-accent/50">
              <input type="radio" name="mode" value="fixture" checked={mode === 'fixture'} onChange={() => setMode('fixture')} className="mt-0.5 accent-[var(--primary)]" />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <FlaskConical className="size-4 text-warning" aria-hidden /> {FIXTURE_LABEL}
                </span>
                <span className="text-xs text-muted-foreground">Checked-in patches replace the agents. Checks, repair, and approval are real.</span>
              </span>
            </label>
            <label className={`flex items-start gap-2.5 rounded-md border p-2.5 has-checked:border-primary has-checked:bg-accent/50 ${liveEnabled ? 'cursor-pointer' : 'opacity-60'}`}>
              <input type="radio" name="mode" value="live" disabled={!liveEnabled} checked={mode === 'live'} onChange={() => setMode('live')} className="mt-0.5 accent-[var(--primary)]" />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <Radio className="size-4" aria-hidden /> Live agents
                </span>
                <span className="text-xs text-muted-foreground">
                  {liveEnabled
                    ? `Three concurrent agents call ${config.data?.modelId ?? 'the model'} within the budget below.`
                    : 'Live execution is off in this environment, or the model key is missing.'}
                </span>
              </span>
            </label>
          </fieldset>
          {mode === 'live' && (
            <div className="flex max-w-xs flex-col gap-1">
              <Label htmlFor={budgetId}>Model budget ceiling (USD)</Label>
              <Input id={budgetId} inputMode="decimal" value={budgetText} onChange={(e) => setBudgetText(e.target.value)} aria-invalid={budgetInvalid} aria-describedby={`${budgetId}-hint`} />
              <p id={`${budgetId}-hint`} className={`text-xs ${budgetInvalid ? 'text-danger' : 'text-muted-foreground'}`}>
                {budgetInvalid ? 'Enter an amount from $0.000001 to $100.' : `Stored as ${budget ?? 0} micro-USD (${formatMicroUsd(budget ?? 0)}).`}
              </p>
            </div>
          )}
          <div className="text-xs">
            <p className="mb-1 font-medium">Goal</p>
            <p className="text-muted-foreground">{STOREFRONT_GOAL}</p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-3">
              {STOREFRONT_TASKS.map((t) => (
                <li key={t.id} className="rounded-md border px-2 py-1.5">
                  <span className="font-medium">{t.title}</span>
                  <span className="block text-muted-foreground">{t.role} agent</span>
                </li>
              ))}
            </ul>
          </div>
          {!seeded && project.data && (
            <Alert tone="warning">
              <FlaskConical aria-hidden />
              <div>
                <AlertTitle>Seed the project first</AlertTitle>
                <AlertDescription>Use the seed button in the sidebar. A session needs the synthetic baseline in the canonical repo.</AlertDescription>
              </div>
            </Alert>
          )}
          <ErrorNotice error={create.error} onDismiss={() => create.reset()} onRetry={run} />
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={create.isPending || budgetInvalid}>
            <Play aria-hidden /> {create.isPending ? 'Wait…' : 'Create session'}
          </Button>
          <span className="text-xs text-muted-foreground">You start the agents from the session page.</span>
        </CardFooter>
      </form>
    </Card>
  );
}

export function HomePage() {
  const sessions = useSessions();
  const latest = sessions.data?.sessions[0];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Coordinate three agents on one goal</h1>
        <p className="text-sm text-muted-foreground">
          Converge finds interactions between agent changes, verifies a repair, and asks you to approve one exact commit.
        </p>
      </div>
      {latest && (
        <p className="text-sm">
          Latest session:{' '}
          <a {...linkProps(`/sessions/${latest.id}`)} className="text-primary hover:underline">
            {latest.id}
          </a>
        </p>
      )}
      <NewSessionForm />
    </div>
  );
}
