import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_MODES,
  isAllocationMode,
  isSkuCondition,
  isUserRole,
  roleAtLeast,
} from './enums';
import { decodeJson, decodeJsonObject, encodeJson } from './json';

describe('roleAtLeast', () => {
  it('treats roles as an ordered hierarchy', () => {
    expect(roleAtLeast('admin', 'viewer')).toBe(true);
    expect(roleAtLeast('editor', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });

  it('denies escalation', () => {
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('viewer', 'admin')).toBe(false);
    expect(roleAtLeast('editor', 'admin')).toBe(false);
  });
});

describe('value-set guards', () => {
  it('accepts exactly the declared values', () => {
    expect(ALLOCATION_MODES).toEqual(['fixed', 'pooled']);
    expect(isAllocationMode('fixed')).toBe(true);
    expect(isAllocationMode('pooled')).toBe(true);
    expect(isSkuCondition('NM')).toBe(true);
    expect(isUserRole('admin')).toBe(true);
  });

  it('rejects anything else, including non-strings', () => {
    expect(isAllocationMode('mirrored')).toBe(false);
    expect(isAllocationMode('')).toBe(false);
    expect(isSkuCondition('nm')).toBe(false); // case-sensitive by design
    expect(isUserRole('superuser')).toBe(false);
    expect(isAllocationMode(null)).toBe(false);
    expect(isAllocationMode(undefined)).toBe(false);
    expect(isAllocationMode(42)).toBe(false);
  });
});

describe('JSON column helpers', () => {
  it('round-trips values', () => {
    const config = { shopDomain: 'example.myshopify.com', locationId: '123' };
    expect(decodeJson(encodeJson(config), {})).toEqual(config);
  });

  it('falls back rather than throwing on malformed or empty input', () => {
    // A corrupt audit payload must never take down a request path.
    expect(decodeJson('{not json', { fallback: true })).toEqual({ fallback: true });
    expect(decodeJson('', { fallback: true })).toEqual({ fallback: true });
    expect(decodeJson(null, { fallback: true })).toEqual({ fallback: true });
    expect(decodeJson(undefined, { fallback: true })).toEqual({ fallback: true });
  });

  it('coerces non-object JSON to an empty object for object-shaped columns', () => {
    expect(decodeJsonObject('[1,2,3]')).toEqual({});
    expect(decodeJsonObject('"a string"')).toEqual({});
    expect(decodeJsonObject('null')).toEqual({});
    expect(decodeJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
});
