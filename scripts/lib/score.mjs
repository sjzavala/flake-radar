/**
 * Flake scoring.
 *
 * The entire model rests on one rule: **a flake is a disagreement at an identical commit
 * SHA.** If the code changed between a pass and a fail, the code is the obvious
 * explanation and the test is not evidence of anything. That constraint throws away a lot
 * of data, and it is what makes the remaining data mean something.
 *
 * There are exactly two ways to see a same-SHA disagreement:
 *
 *   1. Within one run — the framework retried and the outcome changed. Same commit, same
 *      machine, seconds apart. This is the strongest evidence available and it is free;
 *      it is also the reason the Playwright JSON reporter is preferred over JUnit, which
 *      discards attempts.
 *
 *   2. Across runs at the same SHA — someone re-ran the workflow and got a different
 *      answer. Rarer, but it catches flakes that survive a retry.
 *
 *   score = flaky SHAs / observed SHAs
 *
 * The denominator is every SHA where the test ran at all, not only the ones where it had
 * a chance to disagree. Counting only multi-observation SHAs would score a test that
 * flaked once in fifty clean runs at 1.0, which is both alarming and wrong.
 */

import { PASS, FAIL } from './results.mjs';
import { testRuns, knownTestIds, isCleanRun } from './history.mjs';

/** Flaky SHAs shown as evidence in an issue body or PR comment. */
const MAX_EVIDENCE = 5;

export function scoreTest(history, id) {
  const runs = testRuns(history, id);
  const meta = history.tests[id] ?? {};

  /** @type {Map<string, {sha: string, runs: Array<{key: string, outcomes: string[]}>}>} */
  const bySha = new Map();
  for (const run of runs) {
    if (!bySha.has(run.commitSha)) bySha.set(run.commitSha, { sha: run.commitSha, runs: [] });
    bySha.get(run.commitSha).runs.push({ key: run.key, outcomes: run.outcomes });
  }

  let observedShas = 0;
  let flakyShas = 0;
  let retryFlakes = 0;
  let crossRunFlakes = 0;
  let passes = 0;
  const evidence = [];

  for (const group of bySha.values()) {
    const all = group.runs.flatMap((r) => r.outcomes);
    if (all.length === 0) continue;

    observedShas += 1;
    passes += all.filter((o) => o === PASS).length;

    const disagrees = all.includes(PASS) && all.includes(FAIL);
    if (!disagrees) continue;

    flakyShas += 1;

    // Attribute the disagreement. A SHA where some single run flipped mid-run is retry
    // evidence; a SHA where every run was internally consistent but they disagreed with
    // each other is cross-run evidence. Both count once, and the split is reported
    // because they carry different weight when a human reads the issue.
    const withinRun = group.runs.some((r) => r.outcomes.includes(PASS) && r.outcomes.includes(FAIL));
    if (withinRun) retryFlakes += 1;
    else crossRunFlakes += 1;

    evidence.push({
      sha: group.sha,
      kind: withinRun ? 'retry' : 'cross-run',
      runs: group.runs.map((r) => ({ key: r.key, outcomes: r.outcomes })),
    });
  }

  const failedRuns = runs.filter((r) => r.outcomes.includes(FAIL)).length;

  return {
    id,
    file: meta.file ?? null,
    title: meta.title ?? null,
    project: meta.project ?? null,
    lastError: meta.lastError ?? null,
    score: observedShas === 0 ? 0 : flakyShas / observedShas,
    flakyShas,
    observedShas,
    retryFlakes,
    crossRunFlakes,
    totalRuns: runs.length,
    failedRuns,
    consecutiveClean: consecutiveCleanRuns(runs),

    /**
     * Never passed, across more than one commit. That is a broken test or a real
     * regression — deterministic, reproducible, and fixable. It scores 0 here on purpose:
     * quarantining it would hide a genuine failure behind a flakiness label, which is the
     * single worst thing a tool like this can do.
     */
    alwaysFailing: observedShas >= 2 && passes === 0,

    evidence: evidence.slice(-MAX_EVIDENCE).reverse(),
  };
}

/**
 * Trailing runs, newest first, in which the test passed every attempt.
 *
 * Runs where the test did not execute are skipped rather than counted or treated as a
 * break — not running is not evidence of health, but it should not throw away progress
 * already earned either.
 */
export function consecutiveCleanRuns(runs) {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!isCleanRun(runs[i].outcomes)) break;
    count += 1;
  }
  return count;
}

/** Score everything the history knows about, worst first. */
export function scoreAll(history) {
  return knownTestIds(history)
    .map((id) => scoreTest(history, id))
    .sort((a, b) => b.score - a.score || b.flakyShas - a.flakyShas || a.id.localeCompare(b.id));
}

export function formatScore(score) {
  return `${(score * 100).toFixed(0)}%`;
}
