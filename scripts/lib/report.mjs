/**
 * Rendering — the PR comment, the issue bodies, the job summary.
 *
 * Every decision this tool makes lands somewhere a human reads, with the evidence that
 * produced it. An automated quarantine that cannot be argued with is just an outage
 * nobody filed.
 */

import { formatScore } from './score.mjs';

const HEADING = '## 📡 Flake Radar';

export function renderComment(decisions, history) {
  const lines = [HEADING, ''];
  const runs = history.runs.length;
  const tracked = Object.keys(history.tests).length;
  const { quarantine, restore, escalate, active, broken, watchlist, config } = decisions;

  if (runs === 0) {
    lines.push('No runs recorded yet. Scoring begins once results have been ingested.');
    return lines.join('\n');
  }

  const headline = [
    count(quarantine.length, 'test quarantined', 'tests quarantined'),
    restore.length ? count(restore.length, 'restored', 'restored') : null,
    escalate.length ? count(escalate.length, 'expired', 'expired') : null,
  ].filter(Boolean);

  lines.push(
    `**${headline.join(' · ')}** — ${tracked} test${tracked === 1 ? '' : 's'} tracked over the last ${runs} run${runs === 1 ? '' : 's'}.`,
  );

  if (quarantine.length) {
    lines.push(
      '',
      '### Quarantined',
      '',
      '| Test | Score | Why |',
      '|---|---|---|',
      ...quarantine.map(({ score, reason }) => `| ${testCell(score)} | ${formatScore(score.score)} | ${reason} |`),
      '',
      '> These now run in the non-blocking job. They will be restored automatically after ' +
        `${config.restoreAfter} consecutive clean runs, and the issue escalates if they are still ` +
        `quarantined in ${config.expiryDays} days.`,
    );
  }

  if (restore.length) {
    lines.push(
      '',
      '### Restored',
      '',
      ...restore.map(
        ({ score, held }) =>
          `- ${testCell(score)} — ${score.consecutiveClean} consecutive clean runs since ${date(held.since)}. Back in the blocking suite.`,
      ),
    );
  }

  if (escalate.length) {
    lines.push(
      '',
      '### ⚠️ Quarantine expired',
      '',
      ...escalate.map(
        ({ score, held, ageDays }) =>
          `- ${testCell(score)} — quarantined ${Math.floor(ageDays)} days (since ${date(held.since)}) and still not clean. ` +
          `${held.issue ? `#${held.issue}` : 'Its issue'} is now blocking.`,
      ),
      '',
      '> Past expiry the loan comes due: fix it, rewrite it, or delete it — but decide, rather than ' +
        'letting it sit muted indefinitely.',
    );
  }

  if (broken.length) {
    lines.push(
      '',
      `<details><summary>${count(broken.length, 'test is consistently failing', 'tests are consistently failing')} — not flaky</summary>`,
      '',
      'Never passed across more than one commit. That is deterministic, so it is a bug in the test or ' +
        'in the code — quarantine would hide a real failure and is deliberately not applied.',
      '',
      ...broken.map((score) => `- ${testCell(score)} — failed ${score.failedRuns} of ${score.totalRuns} runs`),
      '</details>',
    );
  }

  const stillHeld = active.filter((a) => !restore.includes(a));
  if (stillHeld.length) {
    lines.push(
      '',
      `<details><summary>${count(stillHeld.length, 'test still in quarantine', 'tests still in quarantine')}</summary>`,
      '',
      '| Test | Held since | Clean runs | Issue |',
      '|---|---|---|---|',
      ...stillHeld.map(
        ({ score, held }) =>
          `| ${testCell(score)} | ${date(held.since)} | ${score.consecutiveClean}/${config.restoreAfter} | ${held.issue ? `#${held.issue}` : '—'} |`,
      ),
      '</details>',
    );
  }

  if (watchlist.length) {
    lines.push(
      '',
      `<details><summary>Watchlist — ${count(watchlist.length, 'test has flaked', 'tests have flaked')} but is under the threshold</summary>`,
      '',
      '| Test | Score | Flaky commits |',
      '|---|---|---|',
      ...watchlist
        .slice(0, 10)
        .map((score) => `| ${testCell(score)} | ${formatScore(score.score)} | ${score.flakyShas}/${score.observedShas} |`),
      '</details>',
    );
  }

  lines.push('', renderMethodology(config));
  return lines.join('\n');
}

export function renderMethodology(config) {
  return [
    '<details><summary>How the score is computed</summary>',
    '',
    'A flake is a **disagreement at an identical commit SHA** — nothing else counts. If the code',
    'changed between a pass and a fail, the code explains it.',
    '',
    '```',
    'score = flaky SHAs / observed SHAs',
    '```',
    '',
    '- **retry transition** — the framework retried within one run and the outcome changed.',
    '- **cross-run disagreement** — the same commit was run twice and disagreed with itself.',
    '',
    `Quarantine at **${formatScore(config.threshold)}** across at least **${config.minShas}** commits.`,
    `Restore after **${config.restoreAfter}** consecutive clean runs. Expire after **${config.expiryDays}** days.`,
    '',
    'A test that never passes scores **0** — it is broken, not flaky, and quarantine is the wrong tool.',
    '</details>',
  ].join('\n');
}

/** The issue opened when a test is quarantined. Carries the evidence, not just a verdict. */
export function renderIssueBody({ score, reason }, config, { repoUrl = null, runUrl = null } = {}) {
  const lines = [
    `\`${score.id}\` has been quarantined by Flake Radar.`,
    '',
    `**Score ${formatScore(score.score)}** — ${reason}`,
    '',
    '## Evidence',
    '',
    'Each row is one commit where this test both passed and failed. Nothing else was counted.',
    '',
    '| Commit | Kind | Outcomes |',
    '|---|---|---|',
    ...score.evidence.map(
      (e) =>
        `| \`${e.sha.slice(0, 8)}\` | ${e.kind} | ${e.runs.map((r) => r.outcomes.join(' → ')).join(' &nbsp;/&nbsp; ')} |`,
    ),
  ];

  if (score.lastError) {
    lines.push('', '## Most recent failure', '', '```', score.lastError, '```');
  }

  lines.push(
    '',
    '## What happens next',
    '',
    `- It keeps running in the **non-blocking** job, so it stops gating merges but keeps producing evidence.`,
    `- It is **restored automatically** after ${config.restoreAfter} consecutive clean runs, and this issue closes itself.`,
    `- Quarantine **expires after ${config.expiryDays} days**. Past that this issue escalates to blocking and someone has to decide.`,
    '',
    'Nothing here needs a human to maintain it. The deadline is the point — a quarantine with no expiry is',
    'just a deleted test with extra steps.',
  );

  if (score.file) lines.push('', `Source: \`${score.file}\``);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  if (repoUrl) lines.push(`History: ${repoUrl}`);

  return lines.join('\n');
}

export function renderRestoreComment({ score, held }, config) {
  return [
    `Restored — ${score.consecutiveClean} consecutive clean runs (threshold: ${config.restoreAfter}).`,
    '',
    `Quarantined ${date(held.since)}. Back in the blocking suite.`,
    '',
    'Closing automatically. If it flakes again it will be re-quarantined with fresh evidence.',
  ].join('\n');
}

export function renderEscalationComment({ score, ageDays }, config) {
  return [
    `⚠️ **Quarantine expired** — held ${Math.floor(ageDays)} days, past the ${config.expiryDays}-day limit.`,
    '',
    `It still has not reached ${config.restoreAfter} consecutive clean runs (currently ${score.consecutiveClean}).`,
    '',
    'This issue is now blocking. The options are to fix the test, rewrite what it covers, or delete it and',
    'accept the coverage loss explicitly — all three are fine, and drifting into a fourth year of silence is not.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function testCell(score) {
  const label = score.title ?? score.id;
  return score.file ? `\`${label}\`<br><sub>${score.file}</sub>` : `\`${label}\``;
}

function count(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function date(iso) {
  return String(iso ?? '').slice(0, 10);
}
