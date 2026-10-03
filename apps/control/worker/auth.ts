import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { DomainError } from '@converge/domain';
import type { AppConfig } from './config.ts';

export interface Actor {
  subject: string;
  email: string | null;
  mode: 'access' | 'local';
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwks(issuer: string): JWTVerifyGetKey {
  let set = jwksCache.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, set);
  }
  return set;
}

/**
 * Authenticate the operator. In `access` mode the signed Cf-Access-Jwt-Assertion
 * is verified against the team issuer, audience, current keys, and expiry, and
 * the subject/email must be on the explicit allowlist. Header presence alone or
 * an email header is never trusted. `local` mode is rejected by config
 * validation outside ENVIRONMENT=local, and never depends on Host/forwarding headers.
 */
export async function authenticate(req: Request, config: AppConfig, keys?: JWTVerifyGetKey): Promise<Actor> {
  if (config.AUTH_MODE === 'local') {
    if (config.ENVIRONMENT !== 'local') throw new DomainError('FORBIDDEN', 'local auth is not allowed in deployed environments');
    return { subject: 'local-operator', email: null, mode: 'local' };
  }
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new DomainError('UNAUTHENTICATED', 'missing Access assertion');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys ?? jwks(config.ACCESS_ISSUER), {
      issuer: config.ACCESS_ISSUER.replace(/\/$/, ''),
      audience: config.ACCESS_AUD,
      algorithms: ['RS256'],
      clockTolerance: 5,
    }));
  } catch {
    throw new DomainError('UNAUTHENTICATED', 'invalid or expired Access assertion');
  }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  // Service tokens (automation) carry `common_name` = client ID and an empty `sub`.
  const serviceClient = typeof payload.common_name === 'string' && payload.common_name ? payload.common_name : null;
  const subject = typeof payload.sub === 'string' && payload.sub ? payload.sub : serviceClient;
  if (!subject) throw new DomainError('UNAUTHENTICATED', 'Access assertion has no subject');
  const allowed = config.OPERATOR_SUBJECTS;
  if (!allowed.includes(subject.toLowerCase()) && !(email && allowed.includes(email))) {
    throw new DomainError('FORBIDDEN', 'this identity is not an authorized operator');
  }
  return { subject: email ?? (serviceClient ? `service:${serviceClient}` : subject), email, mode: 'access' };
}

/**
 * CSRF defence for browser-authenticated mutations: require an allowed Origin,
 * a JSON body, and a custom Idempotency-Key header (which forces a CORS preflight
 * that this API never grants cross-origin).
 */
export function assertMutationOrigin(req: Request, config: AppConfig): void {
  const origin = req.headers.get('Origin');
  const allowed = new Set([new URL(config.CONTROL_ORIGIN).origin]);
  if (config.ENVIRONMENT === 'local') allowed.add(new URL(req.url).origin);
  if (!origin || !allowed.has(origin)) throw new DomainError('CSRF_REJECTED', 'cross-origin mutation rejected');
  const ct = req.headers.get('Content-Type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) throw new DomainError('CSRF_REJECTED', 'mutations require a JSON body');
}
