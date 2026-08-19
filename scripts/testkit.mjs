/**
 * Test fixtures. Not shipped logic — a builder for the run histories the unit tests
 * reason about, so each test reads as the scenario it describes rather than as JSON.
 */

import { RESULTS_SCHEMA_VERSION } from './lib/results.mjs';
import { emptyHistory, appendRun } from './lib/history.mjs';

let seq = 0;

/**
 * One run's results.
 *
 * `tests` is a map of test id to attempt outcomes, so `{ 'a.spec.js::login': ['fail',
 * 'pass'] }` reads as "failed, then passed on retry" — which is the shape most of these
 * tests are about.
 */
export function results({ id, attempt = 1, sha = 'sha-1', branch = 'main', tests = {}, startedAt = null } = {}) {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: {
      id: id ?? `run-${++seq}`,
      attempt,
      commitSha: sha,
      branch,
      startedAt: startedAt ?? '2026-08-01T00:00:00.000Z',
      framework: 'playwright',
    },
    tests: Object.entries(tests).map(([testId, attempts]) => ({
      id: testId,
      project: null,
      file: testId.split('::')[0],
      title: testId.split('::')[1] ?? testId,
      attempts,
      durationMs: 100,
      error: attempts.some((a) => a.startsWith('fail')) ? 'expected 3, received 0' : null,
    })),
  };
}

/** Fold a sequence of runs into a history, oldest first. */
export function historyOf(runs, options = {}) {
  let history = emptyHistory();
  for (const run of runs) history = appendRun(history, results(run), options);
  return history;
}

/** `n` runs at distinct commits where every listed test passed first try. */
export function cleanRuns(n, testIds, startAt = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `clean-${startAt + i}`,
    sha: `sha-clean-${startAt + i}`,
    tests: Object.fromEntries(testIds.map((id) => [id, ['pass']])),
  }));
}

export function resetSeq() {
  seq = 0;
}
