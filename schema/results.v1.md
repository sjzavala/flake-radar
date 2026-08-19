# Results contract, v1

The one shape every part of this tool reads. Scoring, quarantine and reporting never see
a framework-native format — an adapter converts to this first.

That is the difference between integrating tools and designing an interface. Adding a
fourth framework costs one adapter and changes nothing downstream.

## The document

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "17123456789",
    "attempt": 1,
    "commitSha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    "branch": "main",
    "startedAt": "2026-08-19T10:04:11.000Z",
    "framework": "playwright"
  },
  "tests": [
    {
      "id": "chromium|tests/checkout.spec.js::applies a discount code",
      "project": "chromium",
      "file": "tests/checkout.spec.js",
      "title": "applies a discount code",
      "attempts": ["failed", "passed"],
      "durationMs": 5824,
      "error": "Timed out 5000ms waiting for expect(locator).toBeVisible()"
    }
  ]
}
```

## Fields

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | ✅ | Exactly `1`. A mismatch is refused, never migrated silently. |
| `run.id` | ✅ | Unique per execution. `GITHUB_RUN_ID` is the obvious source. |
| `run.attempt` | | Re-run counter. `run.id` + `attempt` is the real key — see below. |
| `run.commitSha` | ✅ | **Not defaultable.** See *Why the SHA is required*. |
| `run.branch` | | Recorded, not scored. |
| `run.startedAt` | | ISO 8601. Defaults to ingest time. |
| `run.framework` | | Free text. Recorded so a mixed pipeline stays legible. |
| `tests[].id` | ✅ | The join key across runs. Must be stable. |
| `tests[].project` | | Browser, shard, or whatever the framework calls a variant. |
| `tests[].file` | | Used in reports and issue bodies. |
| `tests[].title` | | Full title, describe blocks included. |
| `tests[].attempts` | ✅ | **One entry per attempt, oldest first.** Non-empty. |
| `tests[].durationMs` | | Summed across attempts. |
| `tests[].error` | | First failure message. Truncated to four lines on ingest. |

### Status vocabulary

`attempts` accepts a framework's own words and normalises them:

| Written as | Read as |
|---|---|
| `passed`, `pass`, `expected` | **pass** |
| `skipped`, `skip`, `pending`, `todo`, `disabled` | **skip** |
| everything else, including `failed`, `timedOut`, `interrupted` | **fail** |

An unrecognised status is a failure, deliberately. A status this tool has not seen before
must not be read as healthy — that is the direction that hides a real problem.

### Test identity

```
id = "{project}|{file}::{full title}"      project omitted when the framework has none
```

The project is part of the identity on purpose. A spec that is solid on chromium and flaky
on webkit is two different facts, and collapsing them averages a real signal into noise.

Whatever builds the id must keep it stable across runs. An id derived from a line number
or a run-scoped counter breaks the join silently — the history simply fills with tests that
were each seen once.

## Why the SHA is required

The whole scoring model is one rule: **a flake is a disagreement at an identical commit.**
If the code changed between a pass and a fail, the code is the obvious explanation.

So a results document with no `commitSha` is not weak evidence, it is no evidence.
Accepting one and defaulting the field would let it dilute or inflate every score computed
afterwards, invisibly. Ingest refuses it instead.

Two consequences worth knowing:

- **Use the head SHA, not a merge commit.** A PR's synthetic merge commit is regenerated on
  every push, so no two observations ever share one and nothing is ever comparable.
- **Retries are the good stuff.** `attempts: ["failed", "passed"]` is a flake proven at one
  commit, on one machine, seconds apart. Any format that reports a single final status has
  already thrown that away — which is why the Playwright JSON reporter is preferred over
  JUnit here, and why the difference is stated plainly rather than papered over.

## Why `run.attempt` exists

Re-running a failed workflow produces a second execution of the *same* commit. That is
precisely the cross-run disagreement worth catching, so the two executions have to stay
distinguishable. They are keyed as `{id}#{attempt}`.

Re-ingesting the same `{id}#{attempt}` replaces it rather than appending. CI steps get
retried, and a tool whose scores creep upward every time someone clicks *re-run job* is
measuring its own plumbing.

## Writing an adapter

An adapter is a pure function from a report to this document. `scripts/lib/adapters.mjs`
has two; a third looks like:

```js
export function fromMyFramework(report, run) {
  return {
    schemaVersion: 1,
    run: { ...run, framework: 'my-framework' },
    tests: report.results.map((r) => ({
      id: testId({ project: r.env, file: r.path, title: r.name }),
      project: r.env,
      file: r.path,
      title: r.name,
      attempts: r.tries.map((t) => t.status),  // oldest first — order matters
      durationMs: r.duration,
      error: r.failure?.message ?? null,
    })),
  };
}
```

Nothing downstream changes. That is the point of having this file.

## Stability

`schemaVersion` is bumped for any change that would make an existing document read
differently. Additive optional fields do not bump it. A history file written under one
version is never migrated silently — the tool refuses it and says so.
