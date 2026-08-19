import test from 'node:test';
import assert from 'node:assert/strict';

import { renderComment, renderIssueBody, renderEscalationComment, renderMethodology } from './report.mjs';
import { DEFAULTS, DAY_MS, decide, applyDecisions } from './quarantine.mjs';
import { scoreAll } from './score.mjs';
import { historyOf, cleanRuns } from '../testkit.mjs';

const T = 'a.spec.js::signs in';
const NOW = new Date('2026-08-19T12:00:00.000Z');

function flakyAt(n) {
  return historyOf(
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, sha: `sha-${i}`, tests: { [T]: ['failed', 'passed'] } })),
  );
}

function decisionsFor(history, now = NOW) {
  return decide(history, scoreAll(history), { now, config: DEFAULTS });
}

test('an empty history renders a comment that says so rather than an empty table', () => {
  const comment = renderComment(decisionsFor(historyOf([])), historyOf([]));
  assert.match(comment, /No runs recorded yet/);
});

test('the comment names the quarantined test and the terms of the loan', () => {
  const history = flakyAt(3);
  const comment = renderComment(decisionsFor(history), history);

  assert.match(comment, /1 test quarantined/);
  assert.match(comment, /signs in/);
  assert.match(comment, /non-blocking job/);
  assert.match(comment, new RegExp(`${DEFAULTS.restoreAfter} consecutive clean runs`));
  assert.match(comment, new RegExp(`escalates if they are still\\s+quarantined in ${DEFAULTS.expiryDays} days`));
});

test('the comment reports a consistently failing test separately, and says why', () => {
  const history = historyOf(
    Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, sha: `sha-${i}`, tests: { [T]: ['failed'] } })),
  );
  const comment = renderComment(decisionsFor(history), history);

  assert.match(comment, /consistently failing/);
  assert.match(comment, /quarantine would hide a real failure/);
  assert.doesNotMatch(comment, /### Quarantined/);
});

test('the comment shows a restore with the evidence that earned it', () => {
  const base = flakyAt(3);
  const held = applyDecisions(base, decisionsFor(base), { now: NOW });
  const history = { ...historyOf(cleanRuns(DEFAULTS.restoreAfter, [T])), quarantine: held.quarantine };
  const comment = renderComment(decisionsFor(history), history);

  assert.match(comment, /### Restored/);
  assert.match(comment, new RegExp(`${DEFAULTS.restoreAfter} consecutive clean runs`));
});

test('an expired quarantine is called out, not buried in a details block', () => {
  const since = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();
  const history = {
    ...flakyAt(3),
    quarantine: { [T]: { since, score: 1, issue: 9, escalatedAt: null, file: 'a.spec.js', title: 'signs in' } },
  };
  const comment = renderComment(decisionsFor(history), history);

  assert.match(comment, /Quarantine expired/);
  assert.match(comment, /#9/);
  assert.doesNotMatch(comment, /<details><summary>⚠️/);
});

test('the issue body carries per-commit evidence, not just a verdict', () => {
  const history = flakyAt(3);
  const [entry] = decisionsFor(history).quarantine;
  const body = renderIssueBody(entry, DEFAULTS, { runUrl: 'https://example.test/run/1' });

  assert.match(body, /## Evidence/);
  assert.match(body, /\| Commit \| Kind \| Outcomes \|/);
  assert.match(body, /retry/);
  assert.match(body, /fail → pass/);
  assert.match(body, /Most recent failure/);
  assert.match(body, /https:\/\/example\.test\/run\/1/);
});

test('the issue body states the deadline, because the deadline is the point', () => {
  const [entry] = decisionsFor(flakyAt(3)).quarantine;
  const body = renderIssueBody(entry, DEFAULTS);

  assert.match(body, new RegExp(`expires after ${DEFAULTS.expiryDays} days`, 'i'));
  assert.match(body, /restored.*automatically/i);
});

test('the escalation comment asks for a decision rather than restating the problem', () => {
  const since = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();
  const history = {
    ...flakyAt(3),
    quarantine: { [T]: { since, score: 1, issue: 9, escalatedAt: null, title: 'signs in' } },
  };
  const [entry] = decisionsFor(history).escalate;
  const comment = renderEscalationComment(entry, DEFAULTS);

  assert.match(comment, /Quarantine expired/);
  assert.match(comment, /fix the test, rewrite what it covers, or delete it/);
});

test('the methodology block reflects the configured thresholds, not the defaults', () => {
  const block = renderMethodology({ ...DEFAULTS, threshold: 0.35, restoreAfter: 4, expiryDays: 7, minShas: 5 });

  assert.match(block, /Quarantine at \*\*35%\*\* across at least \*\*5\*\*/);
  assert.match(block, /Restore after \*\*4\*\*/);
  assert.match(block, /Expire after \*\*7\*\*/);
});
