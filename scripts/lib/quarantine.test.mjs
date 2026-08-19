import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  DAY_MS,
  resolveConfig,
  decide,
  applyDecisions,
  linkIssue,
  quarantineList,
  grepInvertPattern,
} from './quarantine.mjs';
import { scoreAll } from './score.mjs';
import { historyOf, cleanRuns } from '../testkit.mjs';

const T = 'a.spec.js::signs in';
const NOW = new Date('2026-08-19T12:00:00.000Z');

function run(history, { now = NOW, config = DEFAULTS } = {}) {
  return decide(history, scoreAll(history), { now, config });
}

/** A history where `T` flaked at every one of `n` commits. */
function flakyAt(n) {
  return historyOf(
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, sha: `sha-${i}`, tests: { [T]: ['failed', 'passed'] } })),
  );
}

function held(history, since, extra = {}) {
  return {
    ...history,
    quarantine: {
      [T]: { since, score: 0.5, reason: 'flaked', file: 'a.spec.js', title: 'signs in', issue: 7, escalatedAt: null, ...extra },
    },
  };
}

// ---------------------------------------------------------------------------
// entering quarantine
// ---------------------------------------------------------------------------

test('a test at or above the threshold across enough commits is quarantined', () => {
  const decisions = run(flakyAt(3));
  assert.deepEqual(decisions.quarantine.map((q) => q.score.id), [T]);
  assert.match(decisions.quarantine[0].reason, /3 of 3 observed commits/);
});

test('a flaky test seen at too few commits is watched, not quarantined', () => {
  // One bad afternoon is not a pattern. minShas is what stops a single unlucky commit
  // from muting a test for two weeks.
  const decisions = run(flakyAt(2));
  assert.deepEqual(decisions.quarantine, []);
  assert.deepEqual(decisions.watchlist.map((s) => s.id), [T]);
});

test('a test under the threshold is watched, not quarantined', () => {
  const history = historyOf([
    { id: 'flaky', sha: 'sha-flaky', tests: { [T]: ['failed', 'passed'] } },
    ...cleanRuns(19, [T]),
  ]);
  const decisions = run(history);
  assert.deepEqual(decisions.quarantine, []);
  assert.deepEqual(decisions.watchlist.map((s) => s.id), [T]);
});

test('a consistently failing test is never quarantined', () => {
  // The most important negative case in the suite: quarantining this would hide a real,
  // reproducible failure behind a flakiness label.
  const history = historyOf(
    Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, sha: `sha-${i}`, tests: { [T]: ['failed', 'failed'] } })),
  );
  const decisions = run(history);
  assert.deepEqual(decisions.quarantine, []);
  assert.deepEqual(decisions.broken.map((s) => s.id), [T]);
});

test('a healthy test appears in no list at all', () => {
  const decisions = run(historyOf(cleanRuns(5, [T])));
  assert.deepEqual(decisions.quarantine, []);
  assert.deepEqual(decisions.watchlist, []);
  assert.deepEqual(decisions.broken, []);
});

test('an already-quarantined test is not quarantined a second time', () => {
  const decisions = run(held(flakyAt(3), NOW.toISOString()));
  assert.deepEqual(decisions.quarantine, []);
  assert.deepEqual(decisions.active.map((a) => a.score.id), [T]);
});

// ---------------------------------------------------------------------------
// leaving quarantine
// ---------------------------------------------------------------------------

test('enough consecutive clean runs restores a quarantined test', () => {
  const history = held(historyOf(cleanRuns(DEFAULTS.restoreAfter, [T])), '2026-08-15T00:00:00.000Z');
  const decisions = run(history);
  assert.deepEqual(decisions.restore.map((r) => r.score.id), [T]);
});

test('one run short of the threshold does not restore', () => {
  const history = held(historyOf(cleanRuns(DEFAULTS.restoreAfter - 1, [T])), '2026-08-15T00:00:00.000Z');
  assert.deepEqual(run(history).restore, []);
});

test('quarantine expires into an escalation', () => {
  // The design decision the whole tool turns on. Without this, every other mechanic
  // still produces a graveyard — just a well-documented one.
  const since = new Date(NOW.getTime() - (DEFAULTS.expiryDays + 1) * DAY_MS).toISOString();
  const decisions = run(held(flakyAt(3), since));

  assert.deepEqual(decisions.escalate.map((e) => e.score.id), [T]);
  assert.ok(decisions.escalate[0].ageDays > DEFAULTS.expiryDays);
});

test('quarantine inside the expiry window does not escalate', () => {
  const since = new Date(NOW.getTime() - (DEFAULTS.expiryDays - 1) * DAY_MS).toISOString();
  assert.deepEqual(run(held(flakyAt(3), since)).escalate, []);
});

test('a test that has earned release is restored, not escalated, on the same run', () => {
  // It took a while to recover, but it did. Escalating something that is about to be
  // released would be a pointless alarm.
  const since = new Date(NOW.getTime() - (DEFAULTS.expiryDays + 5) * DAY_MS).toISOString();
  const history = held(historyOf(cleanRuns(DEFAULTS.restoreAfter, [T])), since);
  const decisions = run(history);

  assert.deepEqual(decisions.restore.map((r) => r.score.id), [T]);
  assert.deepEqual(decisions.escalate, []);
});

test('an already-escalated test does not escalate again', () => {
  const since = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();
  const history = held(flakyAt(3), since, { escalatedAt: '2026-08-16T00:00:00.000Z' });
  assert.deepEqual(run(history).escalate, []);
});

// ---------------------------------------------------------------------------
// applying decisions
// ---------------------------------------------------------------------------

test('applyDecisions records the quarantine with its evidence and no issue yet', () => {
  const history = flakyAt(3);
  const next = applyDecisions(history, run(history), { now: NOW });
  const entry = next.quarantine[T];

  assert.equal(entry.since, NOW.toISOString());
  assert.equal(entry.issue, null, 'the issue number is filled in later by linkIssue');
  assert.equal(entry.escalatedAt, null);
  assert.equal(entry.file, 'a.spec.js');
  assert.match(entry.reason, /observed commits/);
});

test('applyDecisions releases a restored test and leaves a trail', () => {
  const history = held(historyOf(cleanRuns(DEFAULTS.restoreAfter, [T])), '2026-08-01T00:00:00.000Z');
  const next = applyDecisions(history, run(history), { now: NOW });

  assert.equal(next.quarantine[T], undefined);
  assert.deepEqual(next.quarantineLog, [
    {
      id: T,
      since: '2026-08-01T00:00:00.000Z',
      until: NOW.toISOString(),
      outcome: 'restored',
      cleanRuns: DEFAULTS.restoreAfter,
      issue: 7,
    },
  ]);
});

test('applyDecisions stamps the escalation so it only fires once', () => {
  const since = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();
  const history = held(flakyAt(3), since);
  const next = applyDecisions(history, run(history), { now: NOW });

  assert.equal(next.quarantine[T].escalatedAt, NOW.toISOString());
  assert.deepEqual(run(next).escalate, [], 're-running the sweep must not escalate again');
});

test('applyDecisions does not mutate the history it was given', () => {
  const history = flakyAt(3);
  applyDecisions(history, run(history), { now: NOW });
  assert.deepEqual(history.quarantine, {});
});

// ---------------------------------------------------------------------------
// outputs and config
// ---------------------------------------------------------------------------

test('linkIssue attaches the issue number the workflow opened', () => {
  const history = applyDecisions(flakyAt(3), run(flakyAt(3)), { now: NOW });
  assert.equal(linkIssue(history, T, '42').quarantine[T].issue, 42);
});

test('linkIssue refuses a test that is not quarantined', () => {
  assert.throws(() => linkIssue(historyOf([]), T, 42), /not quarantined/);
});

test('quarantineList is the framework-neutral file the test run consumes', () => {
  const history = held(flakyAt(3), '2026-08-01T00:00:00.000Z');
  const list = quarantineList(history);

  assert.equal(list.schemaVersion, 1);
  assert.deepEqual(list.tests, [
    {
      id: T,
      file: 'a.spec.js',
      title: 'signs in',
      since: '2026-08-01T00:00:00.000Z',
      score: 0.5,
      issue: 7,
      escalatedAt: null,
    },
  ]);
});

test('grepInvertPattern escapes regex metacharacters in test titles', () => {
  const history = held(flakyAt(3), '2026-08-01T00:00:00.000Z', { title: 'search (case-insensitive) [v2]' });
  const pattern = grepInvertPattern(history);

  assert.equal(pattern, 'search \\(case-insensitive\\) \\[v2\\]');
  assert.ok(new RegExp(pattern).test('search (case-insensitive) [v2]'));
  assert.ok(!new RegExp(pattern).test('search x case-insensitive y v2'));
});

test('grepInvertPattern collapses newlines, which would corrupt $GITHUB_OUTPUT', () => {
  const history = held(flakyAt(3), '2026-08-01T00:00:00.000Z', { title: 'signs in\nthen out' });
  const pattern = grepInvertPattern(history);

  assert.equal(pattern, 'signs in then out');
  assert.doesNotMatch(pattern, /[\r\n]/);
});

test('grepInvertPattern is empty when nothing is quarantined', () => {
  assert.equal(grepInvertPattern(historyOf([])), '');
});

test('resolveConfig lets a workflow override the defaults', () => {
  assert.deepEqual(resolveConfig({ threshold: 0.5, expiryDays: 7 }), {
    ...DEFAULTS,
    threshold: 0.5,
    expiryDays: 7,
  });
});

test('resolveConfig ignores unknown keys and rejects nonsense values', () => {
  assert.deepEqual(resolveConfig({ nope: 1 }), DEFAULTS);
  assert.throws(() => resolveConfig({ threshold: 'high' }), /must be a number/);
  assert.throws(() => resolveConfig({ threshold: 0 }), /must be in \(0, 1\]/);
  assert.throws(() => resolveConfig({ threshold: 1.5 }), /must be in \(0, 1\]/);
});
