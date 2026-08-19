import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PASS,
  FAIL,
  SKIP,
  RESULTS_SCHEMA_VERSION,
  normaliseOutcome,
  testId,
  normaliseFile,
  validateResults,
  attemptOutcomes,
  isUnobserved,
} from './results.mjs';

test('normaliseOutcome maps each framework vocabulary onto three outcomes', () => {
  for (const status of ['passed', 'pass', 'expected']) assert.equal(normaliseOutcome(status), PASS);
  for (const status of ['skipped', 'skip', 'pending', 'todo', 'disabled']) {
    assert.equal(normaliseOutcome(status), SKIP);
  }
  for (const status of ['failed', 'fail', 'timedOut', 'interrupted', 'unexpected']) {
    assert.equal(normaliseOutcome(status), FAIL);
  }
});

test('an unrecognised status is a failure, never a pass', () => {
  // The safety direction: a status this tool has not seen before must not be read as
  // healthy, because that is the direction that hides a real problem.
  assert.equal(normaliseOutcome('exploded'), FAIL);
  assert.equal(normaliseOutcome(undefined), FAIL);
  assert.equal(normaliseOutcome(null), FAIL);
  assert.equal(normaliseOutcome(''), FAIL);
});

test('testId includes the project, because the same spec can be flaky on one browser only', () => {
  assert.equal(
    testId({ project: 'webkit', file: 'tests/login.spec.js', title: 'signs in' }),
    'webkit|tests/login.spec.js::signs in',
  );
  assert.notEqual(
    testId({ project: 'webkit', file: 'a.spec.js', title: 't' }),
    testId({ project: 'chromium', file: 'a.spec.js', title: 't' }),
  );
});

test('testId omits the project when the framework has no concept of one', () => {
  assert.equal(testId({ file: 'a.spec.js', title: 't' }), 'a.spec.js::t');
  assert.equal(testId({ project: '  ', file: 'a.spec.js', title: 't' }), 'a.spec.js::t');
});

test('normaliseFile produces a stable key from the paths frameworks actually emit', () => {
  assert.equal(normaliseFile('./tests/a.spec.js'), 'tests/a.spec.js');
  assert.equal(normaliseFile('/tests/a.spec.js'), 'tests/a.spec.js');
  assert.equal(normaliseFile('tests\\a.spec.js'), 'tests/a.spec.js');
  assert.equal(normaliseFile('  tests/a.spec.js  '), 'tests/a.spec.js');
});

test('validateResults accepts a well-formed document', () => {
  const { ok, errors } = validateResults({
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: { id: '1', commitSha: 'abc' },
    tests: [{ id: 'a.spec.js::t', attempts: ['passed'] }],
  });
  assert.equal(ok, true, errors.join('; '));
});

test('validateResults rejects a document with no commit SHA', () => {
  // This is the load-bearing rule. Without a SHA an observation cannot be compared with
  // anything, so admitting it would corrupt every score computed afterwards.
  const { ok, errors } = validateResults({
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: { id: '1' },
    tests: [],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('commitSha')));
});

test('validateResults rejects an unknown schema version', () => {
  const { ok, errors } = validateResults({ schemaVersion: 99, run: { id: '1', commitSha: 'a' }, tests: [] });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('schemaVersion')));
});

test('validateResults rejects a test with no attempts', () => {
  const { ok, errors } = validateResults({
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: { id: '1', commitSha: 'a' },
    tests: [{ id: 'a.spec.js::t', attempts: [] }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('attempts')));
});

test('validateResults rejects non-objects and non-array tests', () => {
  assert.equal(validateResults(null).ok, false);
  assert.equal(validateResults([]).ok, false);
  assert.equal(
    validateResults({ schemaVersion: RESULTS_SCHEMA_VERSION, run: { id: '1', commitSha: 'a' }, tests: {} }).ok,
    false,
  );
});

test('attemptOutcomes preserves retry order', () => {
  assert.deepEqual(attemptOutcomes({ attempts: ['failed', 'failed', 'passed'] }), [FAIL, FAIL, PASS]);
});

test('a test that only ever skipped is unobserved', () => {
  assert.equal(isUnobserved({ attempts: ['skipped', 'skipped'] }), true);
  assert.equal(isUnobserved({ attempts: [] }), true);
  assert.equal(isUnobserved({ attempts: ['skipped', 'passed'] }), false);
});
