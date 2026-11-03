import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, isValidDateString, shiftDate, age } from '../src/ui/format.ts';
import { humanizeError, isRetryableError } from '../src/ui/errors.ts';

test('one duration format for every view', () => {
  assert.equal(duration(0), '0m');
  assert.equal(duration(42), '42s');
  assert.equal(duration(90), '2m');
  assert.equal(duration(45 * 60), '45m');
  assert.equal(duration(90 * 60), '1h 30m');
  assert.equal(duration(3 * 3600), '3h');
  assert.equal(duration(Number.NaN), '0m');
});

test('only real calendar dates are accepted as the selected day', () => {
  assert.equal(isValidDateString('2026-11-03'), true);
  assert.equal(isValidDateString(''), false);
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('2026-1-3'), false);
  assert.equal(shiftDate('2026-11-30', 1), '2026-12-01');
});

test('ages read naturally', () => {
  assert.equal(age(null), 'No event yet');
  assert.equal(age(100, 102), 'Just now');
  assert.equal(age(100, 100 + 90), '1m ago');
});

test('errors lose their "Error:" prefix and known bridge failures become readable', () => {
  assert.equal(humanizeError(new Error('project path must be absolute')), 'Project path must be absolute.');
  assert.equal(humanizeError('Error: Invalid website rule'), 'Invalid website rule.');
  assert.match(humanizeError('Collector restarting; try again shortly'), /restarting/);
  assert.match(humanizeError('Request timed out after 10s'), /took too long/);
  assert.equal(humanizeError(undefined), 'Something went wrong. Try again.');
});

test('restarts and storage operations are retried silently by polls', () => {
  assert.equal(isRetryableError('Collector restarting; try again shortly'), true);
  assert.equal(isRetryableError(new Error('Collector is busy with a storage operation; try again shortly')), true);
  assert.equal(isRetryableError('Invalid summary date'), false);
});
