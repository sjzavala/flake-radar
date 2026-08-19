/**
 * The history file — `.flake-radar/history.json`, committed to the consumer's repo.
 *
 * No database in v1, deliberately. A committed JSON file is reviewable in a PR diff,
 * survives without any hosted service, and makes the tool's state auditable by the same
 * people who review its decisions. The cost is a bounded window rather than forever,
 * which is the right trade: flakiness is a recent-behaviour question.
 *
 * Outcomes are stored normalised (`pass` / `fail` / `skip`), never in a framework's own
 * vocabulary. The history is downstream of the shared contract, so a Jest run and a
 * Playwright run are indistinguishable by the time they land here — which is the whole
 * point of having a contract.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { PASS, SKIP, attemptOutcomes, isUnobserved } from './results.mjs';

export const HISTORY_SCHEMA_VERSION = 1;
export const DEFAULT_WINDOW = 50;

export function emptyHistory() {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    updatedAt: null,
    runs: [],
    tests: {},
    observations: {},
    quarantine: {},
    quarantineLog: [],
  };
}

/**
 * A run is identified by its id *and* its attempt. Re-running a failed workflow produces
 * a second execution of the same commit, which is exactly the cross-run disagreement the
 * score is looking for — collapsing the two would delete the evidence.
 */
export function runKey(run) {
  return `${run.id}#${run.attempt ?? 1}`;
}

export function loadHistory(path) {
  if (!existsSync(path)) return emptyHistory();

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  if (parsed.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    throw new Error(
      `${path} has schemaVersion ${parsed.schemaVersion}, this tool writes ${HISTORY_SCHEMA_VERSION}. ` +
        'Refusing to migrate silently — delete the file to start a fresh window, or pin an older version.',
    );
  }

  return { ...emptyHistory(), ...parsed };
}

export function saveHistory(path, history) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(history, null, 2)}\n`);
}

/**
 * Fold one results document into the history, then prune to the window.
 *
 * Re-ingesting the same run is idempotent: it replaces that run's observations rather
 * than appending a second copy. CI steps get retried, and a tool whose scores drift
 * upward every time someone clicks "re-run job" is measuring its own plumbing.
 */
export function appendRun(history, results, { window = DEFAULT_WINDOW, now = new Date() } = {}) {
  const next = { ...emptyHistory(), ...history };
  const key = runKey(results.run);

  const meta = {
    key,
    id: results.run.id,
    attempt: results.run.attempt ?? 1,
    commitSha: results.run.commitSha,
    branch: results.run.branch ?? null,
    startedAt: results.run.startedAt ?? now.toISOString(),
    framework: results.run.framework ?? null,
  };

  const existingIndex = next.runs.findIndex((r) => r.key === key);
  next.runs = existingIndex === -1 ? [...next.runs, meta] : next.runs.map((r) => (r.key === key ? meta : r));

  const observed = {};
  next.tests = { ...next.tests };
  for (const test of results.tests ?? []) {
    // A test that only ever skipped tells us nothing about whether it is flaky. Recording
    // it would inflate the run count without adding evidence, and — worse — a skipped run
    // would read as a clean one when deciding whether to restore something from quarantine.
    if (isUnobserved(test)) continue;

    observed[test.id] = attemptOutcomes(test).filter((o) => o !== SKIP);
    next.tests[test.id] = {
      file: test.file ?? null,
      title: test.title ?? null,
      project: test.project ?? null,
      lastError: test.error ?? next.tests[test.id]?.lastError ?? null,
    };
  }
  next.observations = { ...next.observations, [key]: observed };

  next.updatedAt = now.toISOString();
  return pruneToWindow(next, window);
}

/**
 * Keep the most recent `window` runs and drop everything only the dropped runs referenced.
 *
 * A test nobody has run in fifty runs is deleted along with its history — but never while
 * it is quarantined. Losing the record of a quarantined test would silently release it,
 * which is precisely the failure mode this tool exists to prevent.
 */
export function pruneToWindow(history, window = DEFAULT_WINDOW) {
  const next = { ...history };
  const keep = next.runs.slice(-Math.max(1, window));
  const keepKeys = new Set(keep.map((r) => r.key));

  next.runs = keep;
  next.observations = Object.fromEntries(
    Object.entries(next.observations).filter(([key]) => keepKeys.has(key)),
  );

  const live = new Set();
  for (const observed of Object.values(next.observations)) {
    for (const id of Object.keys(observed)) live.add(id);
  }
  next.tests = Object.fromEntries(
    Object.entries(next.tests).filter(([id]) => live.has(id) || next.quarantine[id]),
  );

  return next;
}

/**
 * Every recorded run for one test, oldest first, with the runs it was absent from
 * omitted. This is the view the scorer and the MCP surface both read.
 */
export function testRuns(history, id) {
  const out = [];
  for (const run of history.runs) {
    const outcomes = history.observations[run.key]?.[id];
    if (!outcomes || outcomes.length === 0) continue;
    out.push({ ...run, outcomes });
  }
  return out;
}

/** Every test id the history knows about, including quarantined ones with no recent runs. */
export function knownTestIds(history) {
  return [...new Set([...Object.keys(history.tests), ...Object.keys(history.quarantine)])].sort();
}

/** True when a run's outcomes show a first-attempt pass with no failures at all. */
export function isCleanRun(outcomes) {
  return outcomes.length > 0 && outcomes.every((o) => o === PASS);
}
