// T-014 REQ-CORE-012 — cursor encoding and page-size clamping.
import { describe, expect, it } from 'vitest';
import { GRAPH } from '@openmap/constants';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError, toPage } from './cursor.js';

describe('cursor', () => {
  it('round-trips the (name, id) sort key through an opaque base64url string', () => {
    const key = { name: 'db-ryd-pg-core-01', id: '2b9e6b1a-4c7e-4d4f-9d5c-1f1e2d3c4b5a' };
    const cursor = encodeCursor(key);
    expect(cursor).not.toContain('=');
    expect(cursor).not.toContain('{');
    expect(decodeCursor(cursor)).toEqual(key);
  });
  it('rejects cursors that are not base64url JSON of a sort key', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{"name":"x"}').toString('base64url'))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toThrow(InvalidCursorError);
  });
  it('orders cursors so that encoding is stable for equal keys', () => {
    const a = encodeCursor({ name: 'a', id: '1' });
    expect(encodeCursor({ name: 'a', id: '1' })).toBe(a);
    expect(encodeCursor({ name: 'a', id: '2' })).not.toBe(a);
  });
});

describe('clampPageSize', () => {
  it('defaults when missing or non-positive and caps at the maximum', () => {
    expect(clampPageSize(null)).toBe(GRAPH.defaultPageSize);
    expect(clampPageSize(undefined)).toBe(GRAPH.defaultPageSize);
    expect(clampPageSize(0)).toBe(GRAPH.defaultPageSize);
    expect(clampPageSize(-5)).toBe(GRAPH.defaultPageSize);
    expect(clampPageSize(Number.NaN)).toBe(GRAPH.defaultPageSize);
    expect(clampPageSize(7)).toBe(7);
    expect(clampPageSize(7.9)).toBe(7);
    expect(clampPageSize(GRAPH.maxPageSize + 1000)).toBe(GRAPH.maxPageSize);
  });
});

describe('toPage', () => {
  it('splits a first+1 fetch into items and hasNextPage', () => {
    expect(toPage([1, 2, 3], 2)).toEqual({ items: [1, 2], hasNextPage: true });
    expect(toPage([1, 2], 2)).toEqual({ items: [1, 2], hasNextPage: false });
    expect(toPage([], 2)).toEqual({ items: [], hasNextPage: false });
  });
});
