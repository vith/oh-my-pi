# Contributing to omp

## Scope: upstream contributions versus internal fork work

The contributor-authorship and submission requirements below apply to PRs sent
to upstream `can1357/oh-my-pi`, not maintainer integration PRs within this fork.
For internal fork PRs in `github.com/vith/oh-my-pi`, the assistant writes
the description from verified changes and evidence. Do not request a
human-written sentence from the user or attribute assistant-written prose to
them. Internal PRs still follow the fork's branch, review, CI, and merge rules.

Source merges require human review. Compilation and runtime verification run
through the hosted x86_64 OMP package build in `vith/arch-packages`; there is no
separate ARM source build. Source test suites remain disabled and must not be
reported as passed.

## GitHub fork validation and catch-up

The ongoing source destination is `github.com/vith/oh-my-pi`, with canonical
branch `integration`. Historical feature refs preserve their original objects.
The existing `.woodpecker.yml` remains until replacement
package delivery is proved; old source automation must not mutate concurrently
with GitHub catch-up. Repository Actions policy permits only the pinned actions
used by the migration workflows, prohibiting inherited build/publish actions.

`fork-pr-dispatch.yml` reads PR metadata only and dispatches the human review
workflow `fork-ci.yml` at integration. Preparation pins the exact PR head and
current integration base. This workflow does not execute candidate code.

The human-approved `source-review` status is required before merging.
The secret-free `source-review` environment shows the
PR and pinned identities; head/base movement invalidates old evidence. A human
merges through GitHub. No controller auto-approves or auto-merges source.

`tools/catchup.py` discovers authentic stable `vMAJOR.MINOR.PATCH` upstream tags
every six hours (or by explicit manual tag). Scheduled discovery fails closed
unless repository variable `CATCHUP_SCHEDULE_ENABLED` is exactly `true`. It remains
`false` during migration until the maintainer verifies the old Oracle mutator is
quiescent; explicit manual dispatch remains available for controlled proof.
Moved tags fail closed. A clean
ordinary merge retains both pinned parents; conflicts create a draft from the
exact upstream commit with actual conflict paths for human resolution. A fresh
trusted writer validates the bounded receipt, bundle, authentic tag and parent
identities before publishing only the intended tag/branch and explicitly
dispatching CI. Stable scheduled discovery uses published non-draft,
non-prerelease upstream releases, not arbitrary similarly named tags. Exact
bot-owned candidates have bounded bot-authored ownership receipts; missing,
failed or stale-base statuses are dispatched again. An unedited clean bot
candidate can refresh for a changed integration base only with an exact
force-with-lease and verified original parents. New heads invalidate old
validation/approval. Refresh conflicts become human-required drafts.
Existing migrated/human-edited branches are never overwritten;
one blocked active catch-up stays visible. Closed unmerged proposals require
explicit manual reconsideration.

### Reconcile the later Forgejo integration

The initial source archive stopped at Forgejo integration
`1c657a066e44b7d7b17a577c421f60f7160ffbc5`. Forgejo then continued to the
installed revision `c0a06a77a6a58a937d753f144278403fa6e9a802`, while GitHub
integration advanced independently to
`2f406d28d7e451d158557e6a5a9ce5ce1e3ebd2d`. Reconciliation uses an ordinary
merge of the installed Forgejo revision onto that GitHub base, retaining both
complete histories rather than cherry-picking features or rewriting integration.

The retained Forgejo changes are PRs #14 and #16–#19: wheel scrolling with
click-to-focus, accurate reasoning stream status/update age, handled-event
explanations, terminal-owned chat scrolling/fullscreen bash/slash dispatch, and
Page Up/Page Down from the live prompt without losing its draft. Superseded
PR #15 is archival history, not a feature to restore. The retired permissions
work remains retired. Draft GitHub PRs #1 (old ARM CI) and #2 (v18.4.9 catch-up)
are not prerequisites and are not merged by this reconciliation.

The existing `migration/forgejo-history` archive preserves attributed historical
records; these are not fresh GitHub approvals. Later source refs and discussions
are archived using the existing export machinery where available. Consult its
manifest and ref map for actual coverage rather than assuming the initial export
includes the later PRs. The GitHub human-only review workflows remain unchanged;
the retained legacy Woodpecker file does not authorize concurrent Forgejo
automation or duplicate ARM compilation. Package compilation and executable
verification remain the hosted x86_64 package repository's responsibility.

A source candidate must contain both pinned integration identities and authentic
upstream v18.4.8 as ancestors. Read the runtime identity through
`readForkVersion` in `scripts/prepare-fork-build.ts` without invoking build
preparation or compiling on the workstation. Fresh human `source-review`
approval is required for the exact candidate head and current GitHub integration
base, followed by a human protected merge. Only then can the package updater
deliver a signed non-downgrading GitHub package; source reconciliation alone is
not publication or installation evidence.

Source merge and signed package delivery are distinct. Until independently
verified matching source/input/signature evidence exists, catch-up reports
package delivery as pending rather than inferring publication from a source run.
The package repository observes integration read-only; no cross-repository write
credential or Oracle/model publication observer is used.

Pull requests are welcome. Keep them focused, understand the work you submit,
and be prepared to explain and maintain it.

> [!NOTE]
> Pull requests are **temporarily open to everyone** as a trial. We previously
> required a vouch before accepting PRs; that requirement is lifted for now
> while we evaluate how open contributions go. Depending on the results, the
> vouch system may return.

## Before you start

### Small changes

Bug fixes, documentation updates, and narrowly scoped improvements can go
straight to a pull request.

### Major changes

Discuss major features and broad architectural or behavioral changes in
[Discord](https://discord.gg/4NMW9cdXZa) **before writing the implementation**.
This includes new subsystems, large UI changes, new dependencies, and changes
that span several packages. A GitHub issue is not a substitute for this
discussion, and prior discussion does not guarantee that a pull request will be
merged.

### Do not open an issue for work you are about to submit

If you intend to implement a change yourself, **do not create an issue for it
first**. robomp treats actionable issues as work to pick up and may start the
same fix in parallel, wasting compute and maintainer time.

Open an issue when you are reporting a problem or proposing work that you are
not already turning into a pull request. If a relevant issue already exists,
link it from your pull request instead of creating another one.

## AI-assisted contributions

AI agents are welcome as tools, not as unattended contributors. Do not give an
agent a vague goal and submit whatever it produces.

Before opening an upstream pull request, you must:

- constrain the agent to the agreed scope and reject unrelated changes;
- review every changed file and understand the resulting behavior;
- run the relevant checks and exercise the changed behavior yourself; and
- submit the pull request only after that review, rather than letting an agent
  publish it autonomously.

You are responsible for the code, regardless of who or what generated it.

## Pull request requirements

Every upstream pull request body **MUST include at least one sentence written by you, in
your own words**, explaining what changed and why. A generated summary, pasted
agent transcript, or checklist alone does not satisfy this requirement.

One honest line is enough:

> I reviewed the full diff; this change fixes duplicate PR reviews by reusing
> the existing delivery guard.

You **MUST verify that the change works as intended**. `bun check` and automated
tests are expected where relevant, but they are not proof that the behavior
works. Exercise the changed path yourself and report the exact scenario and
result in the pull request:

- for a bug fix, reproduce the bug and confirm the same reproduction no longer
  fails;
- for a feature, launch the product and use the feature end to end; and
- for a UI change, interact with it and inspect the rendered result.

“`bun check` passes” by itself is not sufficient verification. For coding-agent
development commands and repository structure, see
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md).

Keep each pull request to one logical change. Avoid unrelated cleanup,
drive-by refactors, generated noise, or features that were not part of the
agreed scope.

## Contribution licensing

A contribution intentionally submitted for inclusion in OMP is licensed under
the MIT License.

This policy does not relicense third-party or vendored code. You must have the
right to submit your contribution and must preserve applicable copyright,
license, attribution, and notice material. Submitting a contribution does not
require signing a Contributor License Agreement (CLA) or certifying a
Developer Certificate of Origin (DCO).

## Review

Maintainers review the submitted behavior and the contributor's understanding
of it—not the volume of generated code. Respond to review feedback yourself,
and only apply suggestions you have checked.

Pull requests may be closed when they skip required prior discussion, lack the
human-written explanation, contain unreviewed agent output, or mix unrelated
changes.
