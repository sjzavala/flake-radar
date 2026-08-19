# Flake Radar

[![CI](https://github.com/sjzavala/flake-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/sjzavala/flake-radar/actions/workflows/ci.yml)

A GitHub Action that scores test flakiness from same-commit evidence, quarantines the worst
offenders with the evidence attached — and **takes the quarantine back**.

```yaml
- uses: sjzavala/flake-radar@v1
  with:
    report: report.json      # Playwright JSON reporter output
    commit: 'true'
```

No database, no hosted service. History is a JSON file in your repo, so every decision this
tool makes is reviewable in a diff by the same people who review its code.

---

## The problem isn't detecting flakes

Most teams can already name their flaky tests. What they can't do is get rid of them, and
the reason is that the usual fix makes things worse.

A test gets muted. The person who muted it moves on. Eighteen months later nobody can say
whether the behaviour it covered still works — and nobody ever will, because a muted test
produces no signal to notice. Coverage rots silently, which is strictly worse than a red
build, because a red build is at least visible.

So quarantine here is **a loan with interest**:

- granted automatically, on evidence, with the evidence attached to an issue;
- the test **keeps running** while quarantined, in a non-blocking job;
- repaid automatically after N consecutive clean runs;
- and it **expires**. Past the deadline the issue escalates and somebody has to decide.

Take away the expiry and every other mechanic still produces a graveyard — just a
well-documented one.

## What counts as evidence

One rule: **a flake is a disagreement at an identical commit SHA.** If the code changed
between a pass and a fail, the code is the obvious explanation and nothing has been proven.

```
score = flaky SHAs / observed SHAs
```

There are exactly two ways to see a same-commit disagreement:

| Kind | What it looks like | Why it matters |
|---|---|---|
| **retry transition** | `attempts: ["failed", "passed"]` | Same commit, same machine, seconds apart. The strongest evidence there is, and it's free. |
| **cross-run disagreement** | run #1 failed, re-run #2 passed, same SHA | Rarer, but catches flakes that survive a retry. |

That constraint throws away a lot of data, which is what makes the rest mean something.

Two consequences fall out of it, and both are load-bearing:

**A test that never passes scores 0.** It is broken, not flaky — deterministic,
reproducible, fixable. It's reported separately and never quarantined, because quarantining
it would hide a real failure behind a flakiness label. That's the worst thing a tool like
this can do, so it's the case with the most tests around it.

**The denominator is every observed commit**, not just the ones with a chance to disagree.
Score only the multi-observation commits and a test that flaked once in fifty clean runs
comes out at 100%.

## What lands on the PR

> ## 📡 Flake Radar
>
> **1 test quarantined** — 34 tests tracked over the last 50 runs.
>
> ### Quarantined
>
> | Test | Score | Why |
> |---|---|---|
> | `applies a discount code`<br><sub>tests/checkout.spec.js</sub> | 27% | flaked at 4 of 15 observed commits, 3 retry transitions, 1 cross-run disagreement — at or above the 20% threshold |
>
> > These now run in the non-blocking job. They will be restored automatically after 10
> > consecutive clean runs, and the issue escalates if they are still quarantined in 14 days.

…and an issue carrying the per-commit evidence table, the last failure message, and the
terms of the loan. An automated quarantine you can't argue with is just an outage nobody
filed.

## The setup that actually works

Two test jobs and one radar:

```yaml
blocking:      npx playwright test --grep-invert "$QUARANTINED"   # gates the merge
quarantined:   npx playwright test --grep "$QUARANTINED"          # continue-on-error: true
radar:         uses: sjzavala/flake-radar@v1                      # both reports feed it
```

The second job is the one people skip, and it's the one that makes the rest work. **A
quarantined test that stops running can never earn its way out** — no runs, no clean runs,
no restore, forever. Keeping it running off the critical path is the difference between a
loan and a deletion.

Full workflow: [`examples/workflows/playwright-with-quarantine.yml`](examples/workflows/playwright-with-quarantine.yml).
Add the [expiry sweep](examples/workflows/expiry-sweep.yml) too — quarantine expires on the
calendar, and a repo can go quiet for a fortnight.

## Usage

### Inputs

| Input | Default | Description |
|---|---|---|
| `mode` | `ingest` | `sweep` ages existing quarantines without ingesting anything. |
| `report` | | Results file. Required in `ingest` mode. |
| `commit-sha` | *(derived)* | PR head SHA, or `github.sha`. Override to replay archived reports. |
| `run-id` | `github.run_id` | Two ingests sharing an id and attempt are treated as one run. |
| `history` | `.flake-radar/history.json` | Committed history. |
| `quarantine-file` | `.flake-radar/quarantine.json` | The list your test job reads. |
| `config` | `.flake-radar/config.json` | Per-repo thresholds. |
| `threshold` / `min-shas` / `restore-after` / `expiry-days` / `window` | see below | Override the config file per workflow. |
| `manage-issues` | `true` | Open, close and escalate issues. Needs `issues: write`. |
| `comment` | `false` | Post the summary on the PR. Needs `pull-requests: write`. |
| `commit` | `false` | Commit the updated history. **Trunk builds only** — see below. |

### Outputs

| Output | Description |
|---|---|
| `quarantined-count` / `restored-count` / `escalated-count` | What this run decided. |
| `active-count` | Tests currently held. |
| `broken-count` | Tests that never pass — deliberately not quarantined. |
| `changed` | `true` when anything moved. |
| `grep-invert` | Regex matching quarantined titles. |
| `summary` | Path to the markdown summary. |

### Tuning

`.flake-radar/config.json`:

```json
{
  "threshold": 0.2,
  "minShas": 3,
  "restoreAfter": 10,
  "expiryDays": 14,
  "window": 50
}
```

`minShas` is the one worth understanding. At two flaky commits a test is at a 100% flake
rate and still isn't quarantined — one bad afternoon is not a pattern, and a two-week mute
is too expensive to grant on it.

### Why `commit` should only be true on trunk

The history is shared state. If every PR wrote to it, a branch that never merges would
still move everyone's scores, forks couldn't push at all, and two concurrent PRs would race
over the same file. Ingest on `push` to your default branch; on PRs run with
`commit: false` for a preview comment.

### Locally

The engine is a plain Node script with no dependencies:

```bash
node scripts/flake-radar.mjs ingest --report report.json --run-id 1 --sha "$(git rev-parse HEAD)"
node scripts/flake-radar.mjs report          # re-render without ingesting
```

## Framework support

Adapters convert a native report into a [documented results contract](schema/results.v1.md);
nothing downstream ever sees a framework-specific shape. Adding a framework is one adapter
and no other change.

| Input | Retry evidence | Notes |
|---|---|---|
| Playwright JSON reporter | ✅ full | Preferred. One entry per attempt. |
| JUnit XML | ⚠️ partial | Works, but most writers emit a final status only. |

JUnit is supported so an existing pipeline can adopt this without changing its reporters,
but it is **strictly weaker**: retry transitions are the highest-quality evidence available
and JUnit usually discards them before this tool sees the file. It'll still score from
cross-run disagreement — it just needs far more runs to reach the same confidence. Said
plainly here rather than papered over in a feature matrix.

## How this is tested

A tool that decides which tests to stop trusting is the last place to accept "looks right":

- **89 unit tests** over the contract, both adapters, history windowing, scoring, the state
  machine and the rendering — weighted toward the negative cases. That a broken test is *never*
  quarantined, that two flaky commits are *not* enough, that a skipped run neither counts as
  clean nor resets the clock, that re-ingesting a run doesn't double-count it.
- **A self-test job** that drives the entire lifecycle through the action itself: hold off at
  two commits → quarantine at three → stay held through nine clean runs → restore on the
  tenth → backdate the clock → escalate at expiry → sweep again and assert it does *not*
  escalate twice.

## Roadmap — v2, an MCP interface

The history exists; the next step is making it answerable. `flake_top(n)`,
`flake_history(test_id)`, `flake_quarantined()`, `flake_regression(since)` — so "which tests
are wasting the most engineering time this month" becomes a question with an answer.

It belongs in this repo rather than a new one, because this repo owns the data. A separate
repo would just be a client with a dependency.

## Related

- [playwright-test-selector](https://github.com/sjzavala/playwright-test-selector) — runs only
  the specs a PR can affect.
- [claude-qa-tms](https://github.com/sjzavala/claude-qa-tms) — the TMS-driven QA loop that
  generates the specs.
- [borrower-search](https://github.com/sjzavala/borrower-search) — the sandbox both run against.

## License

MIT
