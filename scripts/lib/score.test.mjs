import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreTest, scoreAll, consecutiveCleanRuns, formatScore } from './score.mjs';
import { historyOf, cleanRuns } from '../testkit.mjs';

const T = 'a.spec.js::signs in';

test('a retry that changed the outcome is a flake at that commit', () => {
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { [T]: ['failed', 'passed'] } },
    { id: 'r2', sha: 's2', tests: { [T]: ['passed'] } },
    { id: 'r3', sha: 's3', tests: { [T]: ['passed'] } },
  ]);
  const score = scoreTest(history, T);

  assert.equal(score.flakyShas, 1);
  assert.equal(score.observedShas, 3);
  assert.equal(score.retryFlakes, 1);
  assert.equal(score.crossRunFlakes, 0);
  assert.ok(Math.abs(score.score - 1 / 3) < 1e-9);
});

test('a pass at one commit and a fail at another is NOT a flake', () => {
  // The load-bearing rule. If the code changed between the two outcomes, the code is the
  // obvious explanation — this is a regression to investigate, not flakiness to mute.
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { [T]: ['passed'] } },
    { id: 'r2', sha: 's2', tests: { [T]: ['failed'] } },
    { id: 'r3', sha: 's3', tests: { [T]: ['passed'] } },
  ]);
  const score = scoreTest(history, T);

  assert.equal(score.flakyShas, 0);
  assert.equal(score.score, 0);
  assert.equal(score.failedRuns, 1, 'the failure is still counted, it just is not flake evidence');
});

test('two runs of the same commit that disagree is a cross-run flake', () => {
  const history = historyOf([
    { id: 'r1', attempt: 1, sha: 's1', tests: { [T]: ['failed'] } },
    { id: 'r1', attempt: 2, sha: 's1', tests: { [T]: ['passed'] } },
  ]);
  const score = scoreTest(history, T);

  assert.equal(score.flakyShas, 1);
  assert.equal(score.observedShas, 1);
  assert.equal(score.score, 1);
  assert.equal(score.crossRunFlakes, 1);
  assert.equal(score.retryFlakes, 0, 'neither run flipped internally');
});

test('a test that never passes across several commits is broken, not flaky', () => {
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { [T]: ['failed', 'failed'] } },
    { id: 'r2', sha: 's2', tests: { [T]: ['failed', 'failed'] } },
    { id: 'r3', sha: 's3', tests: { [T]: ['failed'] } },
  ]);
  const score = scoreTest(history, T);

  assert.equal(score.alwaysFailing, true);
  assert.equal(score.score, 0, 'quarantine must not be able to hide a deterministic failure');
});

test('failing at a single commit is not yet enough to call a test broken', () => {
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { [T]: ['failed'] } }]);
  assert.equal(scoreTest(history, T).alwaysFailing, false);
});

test('one flake among many clean commits scores low, not high', () => {
  // The denominator is every observed commit, not only the ones with a chance to
  // disagree. Counting only multi-observation commits would score this at 1.0.
  const history = historyOf([
    { id: 'flaky', sha: 'sha-flaky', tests: { [T]: ['failed', 'passed'] } },
    ...cleanRuns(19, [T]),
  ]);
  const score = scoreTest(history, T);

  assert.equal(score.flakyShas, 1);
  assert.equal(score.observedShas, 20);
  assert.equal(formatScore(score.score), '5%');
});

test('consecutiveClean counts the trailing clean runs and stops at the first failure', () => {
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { [T]: ['passed'] } },
    { id: 'r2', sha: 's2', tests: { [T]: ['failed', 'passed'] } },
    { id: 'r3', sha: 's3', tests: { [T]: ['passed'] } },
    { id: 'r4', sha: 's4', tests: { [T]: ['passed'] } },
  ]);
  assert.equal(scoreTest(history, T).consecutiveClean, 2);
});

test('a run the test sat out neither counts as clean nor breaks the streak', () => {
  // Not running is not evidence of health, but it should not throw away progress already
  // earned either — otherwise a sharded or filtered run resets every quarantine clock.
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { [T]: ['passed'] } },
    { id: 'r2', sha: 's2', tests: { 'other.spec.js::t': ['passed'] } },
    { id: 'r3', sha: 's3', tests: { [T]: ['passed'] } },
  ]);
  assert.equal(scoreTest(history, T).consecutiveClean, 2);
});

test('a retry-recovered run does not count as clean', () => {
  // It passed in the end, but it needed a retry to do it. That is the behaviour under
  // investigation, so it cannot also be the evidence of recovery.
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { [T]: ['failed', 'passed'] } }]);
  assert.equal(scoreTest(history, T).consecutiveClean, 0);
});

test('consecutiveCleanRuns handles an empty history', () => {
  assert.equal(consecutiveCleanRuns([]), 0);
});

test('a test with no observations scores zero rather than dividing by zero', () => {
  const score = scoreTest(historyOf([]), 'never.spec.js::t');
  assert.equal(score.score, 0);
  assert.equal(score.observedShas, 0);
});

test('evidence names the commit and how the disagreement was seen, newest first', () => {
  const history = historyOf([
    { id: 'r1', sha: 'sha-old', tests: { [T]: ['failed', 'passed'] } },
    { id: 'r2', attempt: 1, sha: 'sha-new', tests: { [T]: ['failed'] } },
    { id: 'r2', attempt: 2, sha: 'sha-new', tests: { [T]: ['passed'] } },
  ]);
  const { evidence } = scoreTest(history, T);

  assert.deepEqual(
    evidence.map((e) => [e.sha, e.kind]),
    [
      ['sha-new', 'cross-run'],
      ['sha-old', 'retry'],
    ],
  );
});

test('evidence is capped so an issue body stays readable', () => {
  const runs = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    sha: `sha-${i}`,
    tests: { [T]: ['failed', 'passed'] },
  }));
  assert.equal(scoreTest(historyOf(runs), T).evidence.length, 5);
});

test('scoreAll ranks the worst offenders first', () => {
  const history = historyOf([
    { id: 'r1', sha: 's1', tests: { 'a.spec.js::steady': ['passed'], 'b.spec.js::flaky': ['failed', 'passed'] } },
    { id: 'r2', sha: 's2', tests: { 'a.spec.js::steady': ['passed'], 'b.spec.js::flaky': ['failed', 'passed'] } },
  ]);
  assert.deepEqual(
    scoreAll(history).map((s) => s.id),
    ['b.spec.js::flaky', 'a.spec.js::steady'],
  );
});

test('scoreTest carries the metadata a report needs', () => {
  const history = historyOf([{ id: 'r1', sha: 's1', tests: { [T]: ['failed', 'passed'] } }]);
  const score = scoreTest(history, T);
  assert.equal(score.file, 'a.spec.js');
  assert.equal(score.title, 'signs in');
  assert.equal(score.lastError, 'expected 3, received 0');
});
