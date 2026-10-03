import { canonicalJson, type Observation } from '@converge/domain';
import { boundString } from './bounded.ts';

function sameValue(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

function boundValue(value: unknown): unknown {
  if (typeof value === 'string') return boundString(value);
  if (value === undefined) return null;
  try {
    const json = canonicalJson(value);
    return json.length > 2048 ? boundString(json) : value;
  } catch {
    return boundString(String(value));
  }
}

/**
 * Collects assertions for one check. Every assertion becomes an observation with
 * expected, observed, and passed. The harness, not the candidate, decides `passed`.
 */
export class Recorder {
  readonly observations: Observation[] = [];

  /** Asserts deep equality (canonical JSON). Returns whether it passed. */
  equal(label: string, expected: unknown, observed: unknown): boolean {
    return this.check(label, expected, observed, sameValue(expected, observed));
  }

  /** Records an assertion whose outcome the caller computed. */
  check(label: string, expected: unknown, observed: unknown, passed: boolean): boolean {
    this.observations.push({ label, expected: boundValue(expected), observed: boundValue(observed), passed });
    return passed;
  }
}
