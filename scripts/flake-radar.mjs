#!/usr/bin/env node
/**
 * flake-radar — ingest test results, score flakiness, decide quarantine.
 *
 *   flake-radar ingest --report report.json --sha $GITHUB_SHA --run-id $GITHUB_RUN_ID
 *   flake-radar report                       re-render the current state, ingesting nothing
 *   flake-radar link-issue --test <id> --issue 42
 *
 * The engine never talks to GitHub. It reads a report, updates a JSON file, and writes a
 * plan of actions for the workflow layer to execute — which is what lets every decision
 * in here be unit-tested without a token, a network, or a repo.
 *
 * Zero dependencies — runs on a bare Node 20 with no install step.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { validateResults } from './lib/results.mjs';
import { fromReport } from './lib/adapters.mjs';
import { loadHistory, saveHistory, appendRun } from './lib/history.mjs';
import { scoreAll } from './lib/score.mjs';
import {
  resolveConfig,
  decide,
  applyDecisions,
  linkIssue,
  quarantineList,
  grepInvertPattern,
} from './lib/quarantine.mjs';
import {
  renderComment,
  renderIssueBody,
  renderRestoreComment,
  renderEscalationComment,
} from './lib/report.mjs';

const DEFAULT_HISTORY = '.flake-radar/history.json';
const DEFAULT_QUARANTINE = '.flake-radar/quarantine.json';
const DEFAULT_CONFIG = '.flake-radar/config.json';

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  switch (command) {
    case 'ingest':
      return ingest(args);
    case 'report':
      return report(args);
    case 'link-issue':
      return link(args);
    default:
      process.stderr.write(`Unknown command ${JSON.stringify(command ?? '')}.\nUsage: flake-radar <ingest|report|link-issue> [options]\n`);
      process.exitCode = 2;
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function ingest(args) {
  const historyPath = args.history ?? DEFAULT_HISTORY;
  const config = loadConfig(args);
  const now = args.now ? new Date(args.now) : new Date();

  const reportPath = required(args, 'report');
  const results = fromReport(readFileSync(reportPath, 'utf8'), {
    id: required(args, 'run-id'),
    attempt: args['run-attempt'] ?? 1,
    commitSha: required(args, 'sha'),
    branch: args.branch ?? null,
    startedAt: args['started-at'] ?? now.toISOString(),
  });

  const { ok, errors } = validateResults(results);
  if (!ok) {
    // Refuse rather than degrade. A results document missing its commit SHA is not weak
    // evidence, it is no evidence, and letting it in would corrupt every later score.
    throw new Error(`Results failed validation:\n  - ${errors.join('\n  - ')}`);
  }

  const withRun = appendRun(loadHistory(historyPath), results, { window: config.window, now });
  const scores = scoreAll(withRun);
  const decisions = decide(withRun, scores, { now, config });
  const next = applyDecisions(withRun, decisions, { now });

  saveHistory(historyPath, next);
  writeJson(args.quarantine ?? DEFAULT_QUARANTINE, quarantineList(next));

  emit(args, decisions, next, { now, ingested: results.tests.length });
  return next;
}

/** Re-render the current state. Used by the scheduled expiry sweep, which ingests nothing. */
function report(args) {
  const historyPath = args.history ?? DEFAULT_HISTORY;
  const config = loadConfig(args);
  const now = args.now ? new Date(args.now) : new Date();

  const history = loadHistory(historyPath);
  const scores = scoreAll(history);
  const decisions = decide(history, scores, { now, config });

  // A sweep may escalate, but it must never quarantine — there are no new results, so
  // anything it would quarantine was already visible to the run that produced them.
  decisions.quarantine = [];
  const next = applyDecisions(history, decisions, { now });

  if (!args['dry-run']) {
    saveHistory(historyPath, next);
    writeJson(args.quarantine ?? DEFAULT_QUARANTINE, quarantineList(next));
  }

  emit(args, decisions, next, { now, ingested: 0 });
  return next;
}

function link(args) {
  const historyPath = args.history ?? DEFAULT_HISTORY;
  const next = linkIssue(loadHistory(historyPath), required(args, 'test'), required(args, 'issue'));
  saveHistory(historyPath, next);
  writeJson(args.quarantine ?? DEFAULT_QUARANTINE, quarantineList(next));
  return next;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/**
 * Write everything the workflow layer needs: the comment, the action plan, and the step
 * outputs. Issue bodies are written to files because they contain markdown tables and
 * newlines, which do not survive a shell variable intact.
 */
function emit(args, decisions, history, { now, ingested }) {
  const comment = renderComment(decisions, history);

  if (args['out-comment']) writeText(args['out-comment'], comment);
  if (args['out-decisions']) writeJson(args['out-decisions'], summarise(decisions));

  if (args['out-actions']) {
    const dir = args['bodies-dir'] ?? dirname(args['out-actions']);
    writeText(args['out-actions'], planActions(decisions, dir, args).map((a) => JSON.stringify(a)).join('\n'));
  }

  if (process.env.GITHUB_OUTPUT) {
    appendText(
      process.env.GITHUB_OUTPUT,
      [
        `quarantined-count=${decisions.quarantine.length}`,
        `restored-count=${decisions.restore.length}`,
        `escalated-count=${decisions.escalate.length}`,
        `active-count=${Object.keys(history.quarantine).length}`,
        `broken-count=${decisions.broken.length}`,
        `changed=${decisions.quarantine.length + decisions.restore.length + decisions.escalate.length > 0}`,
        `grep-invert=${grepInvertPattern(history)}`,
        '',
      ].join('\n'),
    );
  }

  if (!args.quiet) {
    process.stdout.write(`${comment}\n`);
    process.stderr.write(
      `flake-radar: ingested ${ingested} test result(s) at ${now.toISOString()}; ` +
        `${decisions.quarantine.length} quarantined, ${decisions.restore.length} restored, ` +
        `${decisions.escalate.length} escalated.\n`,
    );
  }
}

/**
 * The action plan — newline-delimited JSON, one GitHub operation per line.
 *
 * Deliberately dumb: the workflow reads it top to bottom and calls `gh`. All of the
 * judgement already happened, in code that runs without a network.
 */
export function planActions(decisions, bodiesDir, args = {}) {
  const actions = [];
  const context = { repoUrl: args['repo-url'] ?? null, runUrl: args['run-url'] ?? null };

  decisions.quarantine.forEach((entry, i) => {
    const bodyFile = join(bodiesDir, `quarantine-${i}.md`);
    writeText(bodyFile, renderIssueBody(entry, decisions.config, context));
    actions.push({
      action: 'open-issue',
      testId: entry.score.id,
      title: `Flaky test quarantined: ${entry.score.title ?? entry.score.id}`,
      bodyFile,
      labels: ['flake-radar', 'flaky-test'],
    });
  });

  decisions.restore.forEach((entry, i) => {
    if (!entry.held.issue) return;
    const bodyFile = join(bodiesDir, `restore-${i}.md`);
    writeText(bodyFile, renderRestoreComment(entry, decisions.config));
    actions.push({ action: 'close-issue', testId: entry.score.id, issue: entry.held.issue, bodyFile });
  });

  decisions.escalate.forEach((entry, i) => {
    if (!entry.held.issue) return;
    const bodyFile = join(bodiesDir, `escalate-${i}.md`);
    writeText(bodyFile, renderEscalationComment(entry, decisions.config));
    actions.push({
      action: 'escalate-issue',
      testId: entry.score.id,
      issue: entry.held.issue,
      bodyFile,
      labels: ['flake-radar:expired'],
    });
  });

  return actions;
}

function summarise(decisions) {
  const slim = ({ score, held, reason, ageDays }) => ({
    id: score.id,
    file: score.file,
    title: score.title,
    score: score.score,
    flakyShas: score.flakyShas,
    observedShas: score.observedShas,
    consecutiveClean: score.consecutiveClean,
    reason: reason ?? null,
    ageDays: ageDays ?? null,
    issue: held?.issue ?? null,
  });
  return {
    config: decisions.config,
    quarantine: decisions.quarantine.map(slim),
    restore: decisions.restore.map(slim),
    escalate: decisions.escalate.map(slim),
    active: decisions.active.map(slim),
    broken: decisions.broken.map((score) => slim({ score })),
    watchlist: decisions.watchlist.map((score) => slim({ score })),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function loadConfig(args) {
  const path = args.config ?? DEFAULT_CONFIG;
  const fromFile = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // Flags win over the file, so a workflow can override without editing the repo.
  const fromFlags = {
    threshold: args.threshold,
    minShas: args['min-shas'],
    restoreAfter: args['restore-after'],
    expiryDays: args['expiry-days'],
    window: args.window,
  };
  return resolveConfig({ ...fromFile, ...prune(fromFlags) });
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function required(args, name) {
  const value = args[name];
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return String(value);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}

function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2));
}

function appendText(path, content) {
  writeFileSync(path, content, { flag: 'a' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`::error::flake-radar: ${err.message}\n`);
    process.exitCode = 1;
  }
}

export { main, ingest, report, link };
