/**
 * Adapters — framework-native report → the shared results contract.
 *
 * This is the only layer that knows what a Playwright report looks like. Everything
 * downstream reads results.mjs's shape, so a new framework costs one file here and
 * nothing anywhere else.
 *
 * Zero dependencies, including the XML parsing.
 */

import { RESULTS_SCHEMA_VERSION, testId, normaliseFile } from './results.mjs';

/** Terminal colour codes, which arrive embedded in framework error messages. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Playwright's JSON reporter (`--reporter=json`).
 *
 * This is the preferred input because it is the only one that preserves per-retry
 * results. `results` on a test is one entry per attempt, in order, which is exactly the
 * retry-transition evidence the score is built on.
 */
export function fromPlaywrightJson(report, run) {
  const tests = [];

  const walk = (suite, titlePath, file) => {
    // Playwright's top-level suite is the spec file; every suite below it is a
    // `describe`. Only the describes belong in the test's title.
    const nextFile = suite.file ? normaliseFile(suite.file) : file;
    const nextPath = file === undefined ? titlePath : [...titlePath, suite.title].filter(Boolean);

    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ? normaliseFile(spec.file) : nextFile;
      const title = [...nextPath, spec.title].filter(Boolean).join(' > ');

      for (const test of spec.tests ?? []) {
        const attempts = (test.results ?? []).map((r) => resolveAttempt(r.status, test.expectedStatus));
        const firstError = (test.results ?? []).find((r) => r.error?.message ?? r.error?.value);
        tests.push({
          id: testId({ project: test.projectName, file: specFile, title }),
          project: test.projectName || null,
          file: specFile,
          title,
          attempts,
          durationMs: (test.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0),
          error: firstError ? truncate(firstError.error.message ?? firstError.error.value) : null,
        });
      }
    }

    for (const child of suite.suites ?? []) walk(child, nextPath, nextFile);
  };

  for (const suite of report?.suites ?? []) walk(suite, [], undefined);

  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: buildRun(run, 'playwright'),
    tests,
  };
}

/**
 * JUnit XML — the lowest common denominator.
 *
 * Supported so that a repo with an existing JUnit pipeline can adopt this without
 * changing its reporters, but it is strictly weaker evidence: JUnit records one row per
 * test with a final status and no attempt history. Every retry transition — the best
 * flake signal available — is discarded before this function ever sees the file.
 *
 * A repo using JUnit can still be scored, but only from cross-run disagreement at the
 * same SHA, which needs far more runs to reach the same confidence. The README says so
 * plainly rather than pretending the two inputs are equivalent.
 */
export function fromJUnitXml(xml, run) {
  const tests = [];
  const source = String(xml ?? '');

  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = caseRe.exec(source)) !== null) {
    const attrs = parseAttributes(match[1]);
    const body = match[2] ?? '';

    const skipped = /<skipped\b/.test(body);
    const failed = /<(?:failure|error)\b/.test(body);
    const status = skipped ? 'skipped' : failed ? 'failed' : 'passed';

    const file = normaliseFile(attrs.file || attrs.classname || '');
    const title = attrs.name || '';

    tests.push({
      id: testId({ project: null, file, title }),
      project: null,
      file,
      title,
      attempts: [status],
      durationMs: Math.round(Number(attrs.time ?? 0) * 1000) || 0,
      error: failed ? truncate(decodeEntities(firstAttr(body, /<(?:failure|error)\b([^>]*)/, 'message'))) : null,
    });
  }

  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    run: buildRun(run, 'junit'),
    tests: mergeDuplicateIds(tests),
  };
}

/**
 * Some JUnit writers emit one `<testcase>` per retry with an identical name. Fold those
 * into a single test with multiple attempts — it is the one case where JUnit does carry
 * retry evidence, and dropping it would lose the strongest signal in the file.
 */
function mergeDuplicateIds(tests) {
  const byId = new Map();
  for (const t of tests) {
    const existing = byId.get(t.id);
    if (!existing) {
      byId.set(t.id, t);
      continue;
    }
    existing.attempts.push(...t.attempts);
    existing.durationMs += t.durationMs;
    existing.error = existing.error ?? t.error;
  }
  return [...byId.values()];
}

/** Detect the format from the file contents rather than trusting the extension. */
export function detectFormat(raw) {
  return String(raw ?? '').trimStart().startsWith('<') ? 'junit' : 'playwright-json';
}

export function fromReport(raw, run) {
  if (detectFormat(raw) === 'junit') return fromJUnitXml(raw, run);
  return fromPlaywrightJson(JSON.parse(raw), run);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Score an attempt against what the test said it expected, not against `passed`.
 *
 * `test.fail()` marks a spec that is *supposed* to fail — a guard pinned to a known bug,
 * so that whoever fixes the bug gets a signal. Playwright records those attempts with
 * `status: "failed"` and `expectedStatus: "failed"`, and reading the status alone would
 * score a working guard as a permanently broken test.
 *
 * The inversion matters in both directions. When such a guard starts *passing*, the bug
 * has been fixed and the guard is now the thing that is wrong — so that reads as a
 * failure here, which is exactly the notification the pattern exists to produce.
 */
export function resolveAttempt(status, expectedStatus = 'passed') {
  if (status === 'skipped') return 'skipped';
  return status === expectedStatus ? 'passed' : 'failed';
}

function buildRun(run = {}, framework) {
  return {
    id: String(run.id ?? ''),
    attempt: Number(run.attempt ?? 1),
    commitSha: String(run.commitSha ?? ''),
    branch: run.branch ? String(run.branch) : null,
    startedAt: run.startedAt ? String(run.startedAt) : null,
    framework: run.framework ?? framework,
  };
}

function parseAttributes(raw) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1] ?? m[3]] = decodeEntities(m[2] ?? m[4]);
  }
  return attrs;
}

function firstAttr(body, tagRe, name) {
  const tag = body.match(tagRe);
  return tag ? (parseAttributes(tag[1])[name] ?? '') : '';
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Error text ends up in an issue body and in a committed history file. Keep the first
 * few lines — enough to recognise the failure — and drop the stack.
 */
function truncate(message, maxChars = 400) {
  const text = String(message ?? '')
    .replace(ANSI, '') // terminal-formatted errors arrive coloured
    .split('\n')
    .slice(0, 4)
    .join('\n')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text || null;
}
