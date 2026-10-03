import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, canonicalSet, digestOf, Digest } from '../src/index.ts';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('normalizes -0 to 0', () => {
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(CanonicalJsonError);
  });

  it('drops undefined properties and rejects undefined array items', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
  });

  it('rejects non-plain objects', () => {
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
  });

  it('normalizes only explicit sets', () => {
    expect(canonicalSet(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('digestOf', () => {
  it('is stable across key order and well formed', async () => {
    const a = await digestOf({ x: 1, y: [1, 2] });
    const b = await digestOf({ y: [1, 2], x: 1 });
    expect(a).toBe(b);
    expect(Digest.safeParse(a).success).toBe(true);
  });

  it('matches a known vector', async () => {
    // sha256 of the two bytes "{}"
    expect(await digestOf({})).toBe('sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('changes when array order changes', async () => {
    expect(await digestOf([1, 2])).not.toBe(await digestOf([2, 1]));
  });
});
