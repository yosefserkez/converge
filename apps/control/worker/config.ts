import { z } from 'zod';
import { PriceSnapshot } from '@converge/domain';

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Validated application configuration. Defaults are policy, not platform limits. */
export const AppConfig = z
  .object({
    ENVIRONMENT: z.enum(['local', 'dev', 'prod']),
    PROJECT_SLUG: z.string().regex(/^[a-z0-9-]{3,32}$/),
    AUTH_MODE: z.enum(['local', 'access']),
    ACCESS_ISSUER: z.string(),
    ACCESS_AUD: z.string(),
    OPERATOR_SUBJECTS: z.string().transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
    MODEL_PROVIDER: z.literal('anthropic'),
    MODEL_ID: z.string().min(1),
    MODEL_PRICE_SNAPSHOT: z.string().transform((s, ctx) => {
      try {
        return PriceSnapshot.parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'MODEL_PRICE_SNAPSHOT must be a valid price snapshot JSON' });
        return z.NEVER;
      }
    }),
    LIVE_EXECUTION_ENABLED: bool,
    DEFAULT_MODEL_BUDGET_MICROUSD: int(0, 100_000_000),
    MAX_CONCURRENT_AGENTS: int(1, 3),
    MAX_ACTIVE_CONTAINERS: int(1, 12),
    MAX_CANDIDATES_PER_SESSION: int(1, 16),
    MAX_REPAIR_ATTEMPTS: int(0, 4),
    MAX_AGENT_TURNS: int(1, 60),
    AGENT_DEADLINE_SECONDS: int(60, 3600),
    TOOL_TIMEOUT_SECONDS: int(5, 600),
    LEASE_SECONDS: int(30, 900),
    PREVIEW_TTL_SECONDS: int(30, 900),
    CONTROL_ORIGIN: z.url(),
    PREVIEW_ORIGIN: z.url(),
    BUILD_ID: z.string().min(1),
    REPO_HOST: z.enum(['artifacts', 'local']),
  })
  .superRefine((c, ctx) => {
    if (c.ENVIRONMENT !== 'local' && c.AUTH_MODE !== 'access') {
      ctx.addIssue({ code: 'custom', message: 'deployed environments require AUTH_MODE=access' });
    }
    if (c.ENVIRONMENT !== 'local' && c.REPO_HOST !== 'artifacts') {
      ctx.addIssue({ code: 'custom', message: 'deployed environments require REPO_HOST=artifacts' });
    }
    if (c.AUTH_MODE === 'access' && (!c.ACCESS_ISSUER || !c.ACCESS_AUD || c.OPERATOR_SUBJECTS.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'AUTH_MODE=access requires ACCESS_ISSUER, ACCESS_AUD, OPERATOR_SUBJECTS' });
    }
    if (c.TOOL_TIMEOUT_SECONDS >= c.LEASE_SECONDS) {
      ctx.addIssue({ code: 'custom', message: 'TOOL_TIMEOUT_SECONDS must be shorter than LEASE_SECONDS' });
    }
  });
export type AppConfig = z.infer<typeof AppConfig>;

let cached: { source: unknown; config: AppConfig } | undefined;

export function loadConfig(env: Env): AppConfig {
  if (cached?.source === env) return cached.config;
  const config = AppConfig.parse(env);
  cached = { source: env, config };
  return config;
}
