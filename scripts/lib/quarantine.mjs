/**
 * The quarantine state machine.
 *
 * Most quarantine systems become graveyards. A test gets muted, the person who muted it
 * moves on, and eighteen months later nobody can say whether the behaviour it covered
 * still works. Coverage rots silently, which is worse than a red build because nobody
 * ever sees it.
 *
 * So quarantine here is a loan with interest:
 *
 *   - it is granted automatically, on evidence, with the evidence attached;
 *   - the test **keeps running** while quarantined, non-blocking, because otherwise there
 *     is no way to ever observe the clean runs that would earn its release;
 *   - it is repaid automatically after N consecutive clean runs;
 *   - and it **expires**. Past the expiry the issue escalates to blocking, and the team
 *     has to make a decision instead of inheriting one.
 *
 * The expiry is the design decision worth defending. Without it, every mechanic above
 * still produces a graveyard — just a well-documented one.
 */

export const DEFAULTS = {
  /** Fraction of observed SHAs at which a test is quarantined. */
  threshold: 0.2,
  /** Distinct SHAs required before any quarantine decision. One bad day is not a pattern. */
  minShas: 3,
  /** Consecutive clean runs that earn a release. */
  restoreAfter: 10,
  /** Days after which quarantine escalates to a blocking issue. */
  expiryDays: 14,
  /** Runs retained in the history file. */
  window: 50,
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveConfig(overrides = {}) {
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || !(key in DEFAULTS)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`config.${key} must be a number, got ${JSON.stringify(value)}`);
    config[key] = n;
  }
  if (config.threshold <= 0 || config.threshold > 1) {
    throw new Error(`config.threshold must be in (0, 1], got ${config.threshold}`);
  }
  return config;
}

/**
 * Decide what should change, without changing anything.
 *
 * Kept pure so the interesting cases — a test that goes quiet, one that expires on the
 * same run it would have been restored, one that is simply broken — are unit-testable
 * without a repo, a network, or a clock.
 */
export function decide(history, scores, { now = new Date(), config = DEFAULTS } = {}) {
  const quarantine = [];
  const restore = [];
  const escalate = [];
  const active = [];
  const broken = [];
  const watchlist = [];

  for (const score of scores) {
    const held = history.quarantine?.[score.id];

    if (!held) {
      if (score.alwaysFailing) {
        broken.push(score);
        continue;
      }
      if (score.observedShas >= config.minShas && score.score >= config.threshold) {
        quarantine.push({ score, reason: quarantineReason(score, config) });
      } else if (score.flakyShas > 0) {
        watchlist.push(score);
      }
      continue;
    }

    const ageDays = (now.getTime() - Date.parse(held.since)) / DAY_MS;
    const entry = { score, held, ageDays };
    active.push(entry);

    // Release before expiry: a test that has earned its way out should not be escalated
    // on the same run for having taken a while to do it.
    if (score.consecutiveClean >= config.restoreAfter) {
      restore.push(entry);
    } else if (ageDays > config.expiryDays && !held.escalatedAt) {
      escalate.push(entry);
    }
  }

  return { quarantine, restore, escalate, active, broken, watchlist, config };
}

function quarantineReason(score, config) {
  const parts = [`flaked at ${score.flakyShas} of ${score.observedShas} observed commits`];
  if (score.retryFlakes) parts.push(`${score.retryFlakes} retry transition${score.retryFlakes === 1 ? '' : 's'}`);
  if (score.crossRunFlakes) {
    parts.push(`${score.crossRunFlakes} cross-run disagreement${score.crossRunFlakes === 1 ? '' : 's'}`);
  }
  return `${parts.join(', ')} — at or above the ${(config.threshold * 100).toFixed(0)}% threshold`;
}

/**
 * Apply decisions to the history, returning a new one.
 *
 * Issue numbers are not known at this point — the workflow layer opens the issue after
 * the fact and calls `linkIssue`. Keeping issue creation out of the engine is what lets
 * every decision above be tested without a GitHub token.
 */
export function applyDecisions(history, decisions, { now = new Date() } = {}) {
  const next = { ...history, quarantine: { ...history.quarantine }, quarantineLog: [...(history.quarantineLog ?? [])] };
  const at = now.toISOString();

  for (const { score, reason } of decisions.quarantine) {
    next.quarantine[score.id] = {
      since: at,
      score: score.score,
      reason,
      file: score.file,
      title: score.title,
      issue: null,
      escalatedAt: null,
    };
  }

  for (const { score, held } of decisions.restore) {
    delete next.quarantine[score.id];
    next.quarantineLog.push({
      id: score.id,
      since: held.since,
      until: at,
      outcome: 'restored',
      cleanRuns: score.consecutiveClean,
      issue: held.issue ?? null,
    });
  }

  for (const { score } of decisions.escalate) {
    next.quarantine[score.id] = { ...next.quarantine[score.id], escalatedAt: at };
  }

  next.updatedAt = at;
  return next;
}

/** Record the issue the workflow layer opened for a quarantined test. */
export function linkIssue(history, id, issue) {
  if (!history.quarantine?.[id]) throw new Error(`${id} is not quarantined — nothing to link`);
  return {
    ...history,
    quarantine: { ...history.quarantine, [id]: { ...history.quarantine[id], issue: Number(issue) } },
  };
}

/**
 * The quarantine list the test run consumes — `.flake-radar/quarantine.json`.
 *
 * A data file rather than an edit to the spec source. Rewriting tests would tie this to
 * one framework's syntax and would put a bot's commits on top of the author's; a list is
 * framework-neutral, so the same file drives a Playwright fixture and, later, a Jest one.
 */
export function quarantineList(history) {
  const entries = Object.entries(history.quarantine ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return {
    schemaVersion: 1,
    updatedAt: history.updatedAt ?? null,
    tests: entries.map(([id, held]) => ({
      id,
      file: held.file ?? null,
      title: held.title ?? null,
      since: held.since,
      score: held.score,
      issue: held.issue ?? null,
      escalatedAt: held.escalatedAt ?? null,
    })),
  };
}

/**
 * A `--grep-invert` pattern that excludes the quarantined tests from a blocking run.
 *
 * Provided for repos that would rather skip quarantined tests outright. Understand the
 * cost before using it: a skipped test produces no observations, so it can never earn the
 * clean runs that release it. The recommended setup runs them in a separate non-blocking
 * job instead, which keeps the evidence flowing while keeping the build green.
 */
export function grepInvertPattern(history) {
  const titles = Object.values(history.quarantine ?? {})
    .map((held) => held.title)
    .filter(Boolean)
    // Collapse newlines before escaping. A multi-line title is unusual but not impossible,
    // and this value is written to $GITHUB_OUTPUT, where a stray newline would end the
    // line early and let the rest be read as another output entry.
    .map((title) => escapeRegExp(title.replace(/\s*[\r\n]+\s*/g, ' ')))
    .filter(Boolean);
  return titles.length ? titles.join('|') : '';
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
