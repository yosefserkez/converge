import { spawn } from 'node:child_process';
import { DomainError } from '@converge/domain';
import type { Redactor } from './redact.ts';

export interface GitConfigEntry {
  readonly key: string;
  readonly value: string;
}

export interface GitEnvOptions {
  readonly gitDir: string;
  readonly home: string;
  readonly config: readonly GitConfigEntry[];
  /** Extra non-secret variables, e.g. deterministic commit identity and dates. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * Builds the complete child environment. Nothing is inherited from the
 * broker process except PATH, so stray GIT_* variables, proxies, or tracing
 * flags cannot change behaviour or leak headers. Config, including the
 * per-remote Authorization header, travels via GIT_CONFIG_COUNT/KEY/VALUE:
 * it is never written to disk and never appears in argv.
 */
export function buildGitEnv(opts: GitEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: opts.home,
    XDG_CONFIG_HOME: opts.home,
    GIT_DIR: opts.gitDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
    ...opts.extra,
  };
  env.GIT_CONFIG_COUNT = String(opts.config.length);
  opts.config.forEach((entry, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = entry.key;
    env[`GIT_CONFIG_VALUE_${i}`] = entry.value;
  });
  return env;
}

export interface RunOptions {
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly redactor: Redactor;
  readonly stdin?: string | Buffer;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Exit codes treated as a result instead of a failure (0 is always accepted). */
  readonly okExitCodes?: readonly number[];
  /** When true, stdout over the limit is truncated instead of failing the command. */
  readonly truncateOutput?: boolean;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/** Runs `git` with an argv array. No shell is ever involved. */
export function runGit(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const subcommand = args.find((a) => !a.startsWith('-')) ?? 'git';

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const out: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let stderr = '';
    let failure: DomainError | undefined;

    const kill = (err: DomainError): void => {
      failure ??= err;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => kill(new DomainError('DEPENDENCY_UNAVAILABLE', `git ${subcommand} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxOut - outBytes;
      if (chunk.length <= room) {
        out.push(chunk);
        outBytes += chunk.length;
        return;
      }
      if (opts.truncateOutput) {
        out.push(chunk.subarray(0, room));
        outBytes = maxOut;
        truncated = true;
        child.kill('SIGKILL');
      } else {
        kill(new DomainError('LIMIT_EXCEEDED', `git ${subcommand} output exceeded ${maxOut} bytes`));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
    });
    child.stdin.on('error', () => {
      /* child exited before reading all input; the exit code reports it */
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new DomainError('INTERNAL', `failed to start git: ${opts.redactor.redact(err.message)}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const exit = code ?? -1;
      const result: RunResult = { code: exit, stdout: Buffer.concat(out), stderr: opts.redactor.redact(stderr), truncated };
      if (truncated || exit === 0 || opts.okExitCodes?.includes(exit)) return resolve(result);
      reject(gitFailure(subcommand, exit, result.stderr));
    });
  });
}

function gitFailure(subcommand: string, code: number, stderr: string): DomainError {
  const tail = stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 500);
  return new DomainError('DEPENDENCY_UNAVAILABLE', `git ${subcommand} failed (exit ${code})${tail ? `: ${tail}` : ''}`, {
    gitExitCode: code,
  });
}
