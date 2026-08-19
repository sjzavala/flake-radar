import test from 'node:test';
import assert from 'node:assert/strict';

import { fromPlaywrightJson, fromJUnitXml, fromReport, detectFormat } from './adapters.mjs';

const RUN = { id: '99', attempt: 1, commitSha: 'abc123', branch: 'main' };

/** A Playwright JSON report with a top-level test and one inside a `describe`. */
const PLAYWRIGHT_REPORT = {
  suites: [
    {
      title: 'tests/login.spec.js',
      file: 'tests/login.spec.js',
      specs: [
        {
          title: 'loads the page',
          file: 'tests/login.spec.js',
          tests: [{ projectName: 'chromium', results: [{ status: 'passed', duration: 40 }] }],
        },
      ],
      suites: [
        {
          title: 'when logged out',
          specs: [
            {
              title: 'redirects to /login',
              file: 'tests/login.spec.js',
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    { status: 'failed', duration: 5, error: { message: 'Timed out 5000ms\n  at foo.js:1' } },
                    { status: 'passed', duration: 6 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test('the Playwright adapter builds the title from nested describes', () => {
  const { tests } = fromPlaywrightJson(PLAYWRIGHT_REPORT, RUN);
  const ids = tests.map((t) => t.id);
  assert.deepEqual(ids, [
    'chromium|tests/login.spec.js::loads the page',
    'chromium|tests/login.spec.js::when logged out > redirects to /login',
  ]);
});

test('the Playwright adapter preserves every retry attempt in order', () => {
  // The whole scoring model depends on this. A final-status-only read of the same report
  // would report "passed" and the flake would be invisible.
  const { tests } = fromPlaywrightJson(PLAYWRIGHT_REPORT, RUN);
  const retried = tests.find((t) => t.title.includes('redirects'));
  assert.deepEqual(retried.attempts, ['failed', 'passed']);
});

test('the Playwright adapter sums attempt durations and keeps the first error', () => {
  const { tests } = fromPlaywrightJson(PLAYWRIGHT_REPORT, RUN);
  const retried = tests.find((t) => t.title.includes('redirects'));
  assert.equal(retried.durationMs, 11);
  assert.ok(retried.error.startsWith('Timed out 5000ms'));
  assert.equal(tests.find((t) => t.title === 'loads the page').error, null);
});

test('the Playwright adapter carries the run metadata through', () => {
  const doc = fromPlaywrightJson(PLAYWRIGHT_REPORT, RUN);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.run.commitSha, 'abc123');
  assert.equal(doc.run.framework, 'playwright');
});

test('the Playwright adapter tolerates an empty report', () => {
  assert.deepEqual(fromPlaywrightJson({ suites: [] }, RUN).tests, []);
  assert.deepEqual(fromPlaywrightJson({}, RUN).tests, []);
});

const JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/login.spec.js" tests="3">
    <testcase name="signs in" classname="tests/login.spec.js" time="1.5"/>
    <testcase name="rejects a bad password" classname="tests/login.spec.js" time="0.5">
      <failure message="expected &lt;3&gt; got &amp;0">stack trace here</failure>
    </testcase>
    <testcase name="handles SSO" classname="tests/login.spec.js" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

test('the JUnit adapter reads pass, fail and skip', () => {
  const { tests } = fromJUnitXml(JUNIT_XML, RUN);
  assert.deepEqual(
    tests.map((t) => [t.title, t.attempts[0]]),
    [
      ['signs in', 'passed'],
      ['rejects a bad password', 'failed'],
      ['handles SSO', 'skipped'],
    ],
  );
});

test('the JUnit adapter decodes XML entities in the failure message', () => {
  const { tests } = fromJUnitXml(JUNIT_XML, RUN);
  assert.equal(tests[1].error, 'expected <3> got &0');
});

test('the JUnit adapter derives the file from classname and the duration from time', () => {
  const { tests } = fromJUnitXml(JUNIT_XML, RUN);
  assert.equal(tests[0].id, 'tests/login.spec.js::signs in');
  assert.equal(tests[0].durationMs, 1500);
});

test('the JUnit adapter folds repeated testcases into retry attempts', () => {
  // Some writers emit one <testcase> per retry with the same name. That is the only
  // retry evidence JUnit ever carries, so it must not be dropped as a duplicate.
  const xml = `<testsuites><testsuite name="s">
    <testcase name="flaky" classname="a.spec.js" time="1"><failure message="boom"/></testcase>
    <testcase name="flaky" classname="a.spec.js" time="1"/>
  </testsuite></testsuites>`;
  const { tests } = fromJUnitXml(xml, RUN);
  assert.equal(tests.length, 1);
  assert.deepEqual(tests[0].attempts, ['failed', 'passed']);
  assert.equal(tests[0].error, 'boom');
});

test('detectFormat reads the content, not the file extension', () => {
  assert.equal(detectFormat('  <?xml version="1.0"?><testsuites/>'), 'junit');
  assert.equal(detectFormat('{"suites":[]}'), 'playwright-json');
});

test('fromReport dispatches on the detected format', () => {
  assert.equal(fromReport(JUNIT_XML, RUN).run.framework, 'junit');
  assert.equal(fromReport(JSON.stringify(PLAYWRIGHT_REPORT), RUN).run.framework, 'playwright');
});
