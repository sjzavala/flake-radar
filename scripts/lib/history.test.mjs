import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyHistory,
  appendRun,
  pruneToWindow,
  runKey,
  testRuns,
  knownTestIds,
  isCleanRun,
  loadHistory,
  saveHistory,
} from './history.mjs';
import { results, historyOf, cleanRuns } from '../testkit.mjs';

test('appendRun stores outcomes normalised, not in the framework vocabulary', () => {
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { 'a.spec.js::t': ['failed', 'passed'] } }]);
  assert.deepEqual(history.observations['r1#1']['a.spec.js::t'], ['fail', 'pass']);
});

test('re-ingesting the same run replaces it rather than double-counting', () => {
  // CI steps get retried. A tool whose scores creep upward every time someone clicks
  // "re-run job" is measuring its own plumbing.
  const run = { id: 'r1', sha: 's1', tests: { 'a.spec.js::t': ['failed', 'passed'] } };
  const history = historyOf([run, run, run]);
  assert.equal(history.runs.length, 1);
  assert.equal(testRuns(history, 'a.spec.js::t').length, 1);
});

test('a workflow re-run is a separate observation at the same commit', () => {
  // Same run id, different attempt: this is exactly the cross-run disagreement the score
  // is looking for, so collapsing the two would delete the evidence.
  const history = historyOf([
    { id: 'r1', attempt: 1, sha: 's1', tests: { 'a.spec.js::t': ['failed'] } },
    { id: 'r1', attempt: 2, sha: 's1', tests: { 'a.spec.js::t': ['passed'] } },
  ]);
  assert.equal(history.runs.length, 2);
  assert.deepEqual(history.runs.map(runKey), ['r1#1', 'r1#2']);
});

test('a test that only skipped is not recorded at all', () => {
  // Recording it would inflate the run count with no evidence, and — worse — a skipped
  // run would read as a clean one when deciding whether to restore from quarantine.
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { 'a.spec.js::t': ['skipped'] } }]);
  assert.deepEqual(history.observations['r1#1'], {});
  assert.deepEqual(knownTestIds(history), []);
});

test('skipped attempts are stripped from a run that also has real outcomes', () => {
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { 'a.spec.js::t': ['skipped', 'passed'] } }]);
  assert.deepEqual(history.observations['r1#1']['a.spec.js::t'], ['pass']);
});

test('pruneToWindow drops the oldest runs and their observations', () => {
  const history = historyOf(cleanRuns(6, ['a.spec.js::t']), { window: 3 });
  assert.equal(history.runs.length, 3);
  assert.deepEqual(
    history.runs.map((r) => r.id),
    ['clean-3', 'clean-4', 'clean-5'],
  );
  assert.equal(Object.keys(history.observations).length, 3);
});

test('pruneToWindow forgets a test nobody has run in the whole window', () => {
  let history = historyOf([{ id: 'r0', sha: 's0', tests: { 'gone.spec.js::t': ['passed'] } }]);
  assert.ok(knownTestIds(history).includes('gone.spec.js::t'));

  for (const run of cleanRuns(3, ['live.spec.js::t'])) {
    history = appendRun(history, results(run), { window: 3 });
  }

  assert.deepEqual(knownTestIds(history), ['live.spec.js::t']);
});

test('pruneToWindow never forgets a quarantined test', () => {
  // Losing the record of a quarantined test would silently release it, which is precisely
  // the failure mode this tool exists to prevent.
  let history = historyOf([{ id: 'r0', sha: 's0', tests: { 'held.spec.js::t': ['failed'] } }]);
  history.quarantine['held.spec.js::t'] = { since: '2026-08-01T00:00:00.000Z', score: 1, issue: 7 };

  for (const run of cleanRuns(3, ['other.spec.js::t'])) {
    history = appendRun(history, results(run), { window: 2 });
  }

  assert.ok(history.tests['held.spec.js::t'], 'the quarantined test survived the prune');
  assert.ok(knownTestIds(history).includes('held.spec.js::t'));
});

test('testRuns omits runs the test did not take part in', () => {
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { 'a.spec.js::t': ['passed'], 'b.spec.js::t': ['passed'] } },
    { id: 'r2', sha: 's2', tests: { 'b.spec.js::t': ['passed'] } },
  ]);
  assert.deepEqual(
    testRuns(history, 'a.spec.js::t').map((r) => r.id),
    ['r1'],
  );
});

test('a run is clean only when every attempt passed', () => {
  assert.equal(isCleanRun(['pass']), true);
  assert.equal(isCleanRun(['fail', 'pass']), false);
  assert.equal(isCleanRun([]), false);
});

test('loadHistory returns an empty history when the file does not exist', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flake-')), 'history.json');
  assert.deepEqual(loadHistory(path), emptyHistory());
});

test('loadHistory round-trips through saveHistory', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flake-')), 'nested', 'history.json');
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { 'a.spec.js::t': ['passed'] } }]);
  saveHistory(path, history);
  assert.deepEqual(loadHistory(path), history);
});

test('loadHistory refuses to migrate a history written by another version', () => {
  // Silently reinterpreting a file written by a different schema is how a tool starts
  // producing confident, wrong answers. Fail loudly instead.
  const path = join(mkdtempSync(join(tmpdir(), 'flake-')), 'history.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 99 }));
  assert.throws(() => loadHistory(path), /schemaVersion 99/);
});

test('loadHistory reports the path when the file is not valid JSON', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flake-')), 'history.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => loadHistory(path), /not valid JSON/);
});

test('pruneToWindow keeps at least one run even when asked for zero', () => {
  const history = pruneToWindow(historyOf(cleanRuns(3, ['a.spec.js::t'])), 0);
  assert.equal(history.runs.length, 1);
});
