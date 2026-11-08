import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inactivityGaps, parallelism } from '../src/ui/overview-metrics.ts';

test('parallelism weights concurrency by duration and excludes gaps between work periods', () => {
  assert.deepEqual(parallelism([
    { start: 0, end: 60, roots: 1, children: 3, total: 4 },
    { start: 60, end: 240, roots: 1, children: 0, total: 1 },
    { start: 1000, end: 1060, roots: 1, children: 1, total: 2 },
  ]), { average: 1.8, activeSeconds: 300 });
});

test('empty days and zero-agent segments have no parallelism to display', () => {
  assert.deepEqual(parallelism([]), { average: null, activeSeconds: 0 });
  assert.deepEqual(parallelism([{ start: 0, end: 600, roots: 0, children: 0, total: 0 }]),
    { average: null, activeSeconds: 0 });
});

test('zero-length and reversed segments do not distort parallelism', () => {
  assert.deepEqual(parallelism([
    { start: 30, end: 10, roots: 1, children: 20, total: 21 },
    { start: 0, end: 0, roots: 1, children: 20, total: 21 },
    { start: 0, end: 60, roots: 1, children: 1, total: 2 },
  ]), { average: 2, activeSeconds: 60 });
});

test('inactivity shading never covers a short agent burst or human activity', () => {
  assert.deepEqual(inactivityGaps([
    { start: 0, end: 60 }, { start: 3600, end: 3610 },
    { start: 5000, end: 5100 }, { start: 8000, end: 8100 },
  ]), [{ start: 60, end: 3600 }, { start: 5100, end: 8000 }]);
});

test('inactivity gaps union overlapping intervals without mutating the source', () => {
  const spans = [{ start: 60, end: 120 }, { start: 0, end: 100 }, { start: 2000, end: 2100 }];
  assert.deepEqual(inactivityGaps(spans), [{ start: 120, end: 2000 }]);
  assert.equal(spans[0]!.end, 120);
  assert.deepEqual(inactivityGaps([]), []);
});
