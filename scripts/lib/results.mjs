/**
 * The shared results contract.
 *
 * Every downstream part of this tool — scoring, quarantine, reporting — reads *this*
 * shape and never a framework-native one. Adding a fourth framework is then writing one
 * small adapter, not editing every consumer.
 *
 * See schema/results.v1.md for the documented contract and its stability guarantees.
 *
 * Zero dependencies — runs on a bare Node 20 with no install step.
 */

export const RESULTS_SCHEMA_VERSION = 1;

/** The three outcomes anything downstream is allowed to reason about. */
export const PASS = 'pass';
export const FAIL = 'fail';
export const SKIP = 'skip';

/**
 * Collapse a framework's status vocabulary onto the three outcomes above.
 *
 * `timedOut` and `interrupted` are failures: the test did not demonstrate the behaviour
 * it claims to. Anything unrecognised is also a failure — an unknown status must never
 * be silently read as a pass, because that is the direction that hides a real problem.
 */
export function normaliseOutcome(status) {
  const s = String(status ?? '').trim();
  if (s === 'passed' || s === 'pass' || s === 'expected') return PASS;
  if (s === 'skipped' || s === 'skip' || s === 'pending' || s === 'todo' || s === 'disabled') return SKIP;
  return FAIL;
}

/**
 * Build the join key that identifies one test across runs.
 *
 * The project (browser, shard config, whatever the framework calls it) is part of the
 * identity. A spec that is rock solid on chromium and flaky on webkit is two different
 * facts, and collapsing them averages a real signal into noise.
 */
export function testId({ project, file, title }) {
  const suffix = `${normaliseFile(file)}::${String(title ?? '').trim()}`;
  const p = String(project ?? '').trim();
  return p ? `${p}|${suffix}` : suffix;
}

/** Repo-root-relative, forward-slashed, no leading `./`. */
export function normaliseFile(p) {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

const REQUIRED_RUN_FIELDS = ['id', 'commitSha'];

/**
 * Validate a results document before it is allowed to touch the history.
 *
 * `commitSha` is required and is not defaultable. The entire scoring model rests on
 * comparing outcomes at an *identical* commit; without a SHA an observation is not weak
 * evidence, it is no evidence, and letting it in would silently corrupt every score
 * computed afterwards.
 */
export function validateResults(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['results must be a JSON object'] };
  }

  if (doc.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${RESULTS_SCHEMA_VERSION}, got ${JSON.stringify(doc.schemaVersion)}`);
  }

  const run = doc.run;
  if (!run || typeof run !== 'object') {
    errors.push('run is required');
  } else {
    for (const field of REQUIRED_RUN_FIELDS) {
      if (!run[field] || typeof run[field] !== 'string') {
        errors.push(`run.${field} is required and must be a non-empty string`);
      }
    }
  }

  if (!Array.isArray(doc.tests)) {
    errors.push('tests must be an array');
  } else {
    doc.tests.forEach((t, i) => {
      if (!t || typeof t !== 'object') {
        errors.push(`tests[${i}] must be an object`);
        return;
      }
      if (!t.id || typeof t.id !== 'string') errors.push(`tests[${i}].id is required`);
      if (!Array.isArray(t.attempts) || t.attempts.length === 0) {
        errors.push(`tests[${i}].attempts must be a non-empty array`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Per-attempt outcomes for one test, oldest attempt first.
 *
 * Retries are preserved rather than collapsed to a final status. A test that failed and
 * then passed on retry is the cleanest flake evidence available — same commit, same
 * machine, minutes apart — and a final-status-only format throws it away.
 */
export function attemptOutcomes(test) {
  return (test.attempts ?? []).map(normaliseOutcome);
}

/** True when every attempt was skipped, or there were none. Skips are not evidence. */
export function isUnobserved(test) {
  const outcomes = attemptOutcomes(test);
  return outcomes.length === 0 || outcomes.every((o) => o === SKIP);
}
