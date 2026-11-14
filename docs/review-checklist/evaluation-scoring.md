# Checklist evaluation scoring

> This text is LLM generated.

This is the offline accounting step for [#1232](https://github.com/cgwalters-forge/tracker/issues/1232),
not an evaluation result or a mined checklist. No real reviews have been run or
scored here. Corpus preparation is separate (#1231); the architecture evaluation
has its own protocol. The scorer runs only when invoked and never calls GitHub
or an inference service. Save the JavaScript block under [Offline scorer](#offline-scorer)
as `score.mjs`, then run:

```sh
node score.mjs adjudications.json
```

The default output is JSON for archiving and machines; `--help` explains usage.
The CI test job runs synthetic offline tests of the block below. Invalid input exits
nonzero without printing a partial score. To avoid unbounded local input reads,
the CLI accepts at most 1 MiB, 30 PRs and 1,000 comments/findings per PR/pass.
These are fixed limits, not production controls or new caller settings.

## Before scoring

Freeze the checklist version, prompts, sample and matching rubric before reviews.
Select the 30-PR language-stratified sample from the frozen whole-PR holdout, with
at least one eligible inline operator comment per PR. Archive the selection seed,
PR URLs, strata and exact pre-review head/base commits. Run baseline and checklist
reviews independently on those same historical inputs, without operator feedback,
later fixes or the other pass's findings. Archive findings and model/run provenance
before giving the separate adjudicator operator feedback. None of those isolation
or provenance claims can be verified by this arithmetic helper.

Matching rubric for the ledger:

* Include every eligible inline style/nit comment by cgwalters in the denominator.
  Freeze eligibility before seeing findings; archive exclusions with reasons.
* Match only the same file and diff hunk (or a demonstrably equivalent range)
  **and the same actionable concern**. Sharing a topic is insufficient. Record
  the reason and evidence in the adjudication archive; `reason` summarizes it.
* One finding may address several comments. Repeated findings may match the same
  comment, but that comment is caught only once per pass. Unmatched findings are
  not automatically wrong, and operator silence is not evidence of noise.
* Audit a preselected sample of unmatched findings by hand: `supported` for a
  valid additional concern, `noise` for an incorrect/inapplicable suggestion,
  `unresolved` when evidence is insufficient. Leave all unaudited findings
  `unreviewed`. Record the sampling method and human identity in the archive;
  agent scoring is not human adjudication.

## Ledger contract (v1)

The example below is synthetic and intentionally smaller than the required
30-PR evaluation. IDs resolve to archived comments/findings; they are not text
matching instructions. Both pass arrays are mandatory, including an empty array
when a completed review found nothing. Never use an empty array for a failed or
skipped review: finish it before scoring the paired sample.

```json
{
  "schema": "checklist-scores/v1",
  "checklist_version": "synthetic-example",
  "sample": "archive/sample.json",
  "adjudicator": "archive/adjudication-provenance.json",
  "runs": {
    "baseline": {
      "model": "synthetic",
      "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provenance": "archive/baseline-runs.json"
    },
    "checklist": {
      "model": "synthetic",
      "prompt_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "provenance": "archive/checklist-runs.json"
    }
  },
  "prs": [{
    "url": "https://github.com/example/project/pull/1",
    "language": "Rust",
    "comments": ["operator-comment-1"],
    "baseline": [],
    "checklist": [{
      "id": "finding-1",
      "matches": ["operator-comment-1"],
      "reason": "Same hunk and actionable concern; see archived adjudication."
    }, {
      "id": "finding-2",
      "matches": [],
      "audit": "unreviewed"
    }]
  }]
}
```

Language is the frozen PR stratum: `Rust`, `C`, `shell`, `Go`, `Python`, `docs`
or `other`, not an inferred language per finding. Mixed PRs retain the stratum
chosen at sampling. Comment IDs are unique within a PR; finding IDs within a
PR/pass. Audited unmatched findings require a reason; matched findings require a
reason and must not carry an unmatched audit state. Unknown comment references,
duplicate IDs and missing passes fail rather than silently changing denominators.
PR identity ignores owner/repository letter case: listing `example/project` and
`Example/Project` with the same PR number is an error, even across language strata.
This prevents duplicate PRs from inflating sample size and comment/finding counts.
Distinct repositories or PR numbers remain separate; output keeps the submitted URL
spelling for archive lookup. Repository renames and transfers are not resolved offline.

The JSON result retains provenance references and reports counts in total and per
language, separately for baseline and checklist. `caught / operator_comments` is
comment recall; `missed` is its complement. `unmatched_findings / findings` is an
unmatched rate, **not** a false-positive rate. `audited_unmatched / unmatched_findings`
shows audit coverage, with supported/noise/unresolved counts reported separately.
Zero denominators mean no rate is available, not perfect performance. Unmatched
IDs are listed for follow-up against the archive. `sample_size` and
`target_sample_size` expose partial ledgers; even 30 entries do not certify a valid
held-out evaluation. Publish the archived evidence and limitations with any eventual
evaluation report, not just this summary.

## Offline scorer

This explicitly invoked snippet stays in documentation because deployment code
may only shrink (#890). CI extracts this exact block into a temporary module;
no workflow runs it on a real ledger.

```javascript
import { openSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const PASSES = ['baseline', 'checklist'];
const LANGUAGES = ['Rust', 'C', 'shell', 'Go', 'Python', 'docs', 'other'];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

function list(value, limit, label) {
  requireThat(Array.isArray(value) && value.length <= limit, `${label}: expected at most ${limit} entries`);
}

function unique(values, label) {
  requireThat(values.every(text) && new Set(values).size === values.length, `${label}: empty or duplicate ID`);
}

function counts() {
  return { prs: 0, operator_comments: 0, caught: 0, missed: 0, findings: 0,
    matched_findings: 0, unmatched_findings: 0, audited_unmatched: 0,
    supported_unmatched: 0, noise_unmatched: 0, unresolved_unmatched: 0 };
}

// Matching is an adjudicator's job. This only checks and counts the ledger.
export function score(input) {
  requireThat(input?.schema === 'checklist-scores/v1', 'expected checklist-scores/v1');
  requireThat(text(input.checklist_version) && text(input.sample) && text(input.adjudicator),
    'checklist_version, sample and adjudicator references are required');
  for (const pass of PASSES) {
    const run = input.runs?.[pass];
    requireThat(text(run?.model) && text(run?.provenance) && /^[a-f0-9]{64}$/.test(run?.prompt_sha256 ?? ''),
      `${pass}: model, provenance and prompt_sha256 are required`);
  }
  list(input.prs, 30, 'PRs');
  requireThat(input.prs.length > 0, 'at least one PR is required');
  unique(input.prs.map(pr => typeof pr?.url === 'string' ? pr.url.toLowerCase() : pr?.url), 'PRs');
  const result = { schema: 'checklist-scores/v1', checklist_version: input.checklist_version,
    sample: input.sample, adjudicator: input.adjudicator, runs: input.runs,
    sample_size: input.prs.length, target_sample_size: 30, totals: {}, languages: {}, unmatched: [] };
  for (const pass of PASSES) result.totals[pass] = counts();
  for (const pr of input.prs) {
    requireThat(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*$/.test(pr.url), 'invalid PR URL');
    requireThat(LANGUAGES.includes(pr.language), 'unknown language stratum');
    list(pr.comments, 1000, 'operator comments');
    requireThat(pr.comments.length > 0, 'each PR needs at least one eligible operator comment');
    unique(pr.comments, 'operator comments');
    result.languages[pr.language] ??= Object.fromEntries(PASSES.map(pass => [pass, counts()]));
    for (const pass of PASSES) {
      list(pr[pass], 1000, `${pass} findings`);
      unique(pr[pass].map(finding => finding?.id), `${pass} findings`);
      const caught = new Set();
      const current = counts();
      current.prs = 1;
      current.operator_comments = pr.comments.length;
      current.findings = pr[pass].length;
      for (const finding of pr[pass]) {
        list(finding.matches, 1000, 'matches');
        unique(finding.matches, 'matches');
        requireThat(finding.matches.every(id => pr.comments.includes(id)), 'match references an unknown operator comment');
        if (finding.matches.length) {
          requireThat(finding.audit === undefined, 'matched findings must not have an unmatched audit');
          requireThat(text(finding.reason), 'matched finding needs an adjudication reason');
          current.matched_findings++;
          for (const id of finding.matches) caught.add(id);
        } else {
          requireThat(['unreviewed', 'supported', 'noise', 'unresolved'].includes(finding.audit), 'unmatched finding needs an audit state');
          if (finding.audit !== 'unreviewed') {
            requireThat(text(finding.reason), 'audited finding needs a reason');
            current.audited_unmatched++;
            current[`${finding.audit}_unmatched`]++;
          }
          current.unmatched_findings++;
          result.unmatched.push({ pr: pr.url, pass, id: finding.id, audit: finding.audit });
        }
      }
      current.caught = caught.size;
      current.missed = pr.comments.length - caught.size;
      for (const key of Object.keys(current)) {
        result.totals[pass][key] += current[key];
        result.languages[pr.language][pass][key] += current[key];
      }
    }
  }
  return result;
}

export function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node score.mjs LEDGER.json\nPrint JSON counts for manually adjudicated baseline/checklist findings; no inference or network.');
    return;
  }
  requireThat(args.length === 1 && !args[0].startsWith('-'), 'usage: node score.mjs LEDGER.json (see --help)');
  // Bound the read itself, not just the parsed result or a racy stat size.
  const fd = openSync(args[0], 'r');
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let size = 0;
  try {
    let n;
    while (size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
  } finally { closeSync(fd); }
  requireThat(size <= MAX_BYTES, 'ledger exceeds 1 MiB; split the evaluation rather than truncating it');
  let input;
  try { input = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
  catch { throw new Error('invalid ledger JSON; see evaluation-scoring.md'); }
  console.log(JSON.stringify(score(input), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`score: ${error.message}`); process.exitCode = 1; }
}
```
