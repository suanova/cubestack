---
name: github-planning
description: >-
  Turn PRDs, design docs, and TODO lists into a fully-structured GitHub project:
  milestones, epics and child issues, dependency links (blocks / blocked by),
  labels, priorities, assignees, and Fibonacci story-point estimates — then
  generate release notes from milestone contents and keep milestone progress
  current. Use whenever the user asks to convert a PRD/design doc/TODO into
  GitHub issues, set up a milestone or epics, estimate story points, assign
  priorities, link issue dependencies, generate release notes, or update
  milestone progress.
allowed-tools: Read, Write, Edit, Bash(.claude/skills/github-planning/scripts/gp *)
---

# GitHub Planning Skill

Turn planning documents into a working GitHub project, and keep it maintained
through a release.

## 1. Purpose & division of labor

**Claude does the judgment work.** You read the source document (PRD, design
doc, TODO list, notes), decompose the work, apply the estimation and priority
rubrics below, and write issue bodies from the template in
`references/issue-template.md`. You express the result as a **manifest JSON**.

**`scripts/gp` does the mechanical work.** It is an idempotent GitHub helper:
it ensures labels, finds-or-creates the milestone, creates missing issues,
links epics → children (sub-issues), links `blocks`/`blocked by` dependencies,
assigns labels/priorities/assignees/estimates, renders release notes, and
updates milestone progress. `gp` never deletes anything and is safe to re-run.

**Always show the user a dry-run before applying** (`gp plan ... --dry-run`).

## 2. When to use

- A PRD / design doc / TODO list → GitHub issues.
- Backlog grooming: new epics, issues, estimates, priorities.
- Release cut: milestone creation, release notes.
- Milestone upkeep: progress sync, auto-close, blocked detection.

Do **NOT**:
- Auto-close a milestone without the user opting in (`--auto-close`).
- Delete issues, labels, or milestones (`gp` has no delete commands).
- Create issues in a repo the user hasn't pointed you at.
- Turn explicitly-deferred / future-work items in the source doc (TODO lists,
  "future", "v2") into issues. Skip them — plan only the committed scope.
  If the team still wants a backlog, keep it in a separate backlog doc/board,
  not in the milestone. (Opt in only if the user explicitly asks for one.)

## 3. Conventions & taxonomy

Source of truth: `config/planning.json`. **To change labels/colors/scales, edit
that file — never edit `scripts/gp`.**

| Thing | Convention |
|---|---|
| Hierarchy | **Feature** → **Epic** → **Story** → **Task**. Expressed as nested sub-issues via **chained `children`** (any issue can carry `children` referencing other issues, so Feature→Epic→Story becomes two levels of nesting). Task is a checkbox list inside the Story body. |
| Labels | Bare labels for the hierarchy + work type: `feature`, `epic`, `story`, `task`, `bug`, `doc` (no `type:`/`level:` prefix). Plus `priority:P0–P3`, `story-points:1,2,3,5,8,13`, `status:blocked`. |
| Milestones | Find-or-create by **exact title**; keep titles unique (GitHub allows duplicates — don't). Optional `due_on` + description. **Reuse before creating:** design work usually belongs to an existing platform/phase milestone, not a per-feature one. List open milestones (`gh api repos/<owner>/<repo>/milestones?state=open --jq '.[].title'`) and use an existing milestone's exact title when it already covers the scope — never create a feature-named milestone alongside it. |
| Titles | Prefix grouping issues so the hierarchy is visible in flat lists: `Feature: …`, `Epic: …`, `Story: …`. Only **Story** issues carry `story_points`. |
| Epics | An issue labeled `epic`; its children are linked as **sub-issues**. Any issue (Feature/Epic/…) can have `children` for multi-level nesting. |
| Tasks | Technical sub-steps live as a checkbox list (`**Tasks:**`) in the Story body — GitHub renders a task list with progress. Promote to real sub-issues only if a Task needs its own assignee/visibility. Required on every story, and especially on consolidated stories — the list carries the detail that would otherwise be separate stories. |
| Assignees | The issue's **owner/reviewer — typically a human**, not the executor. Execution may be delegated to an AI agent that is never named as the assignee. Set per issue in the manifest (`assignees: ["handle"]`); must be repo collaborators. `gp` sends `[]` when omitted — it does **not** auto-assign the creator. **Ask the user to specify assignees** when generating a plan; never invent handles. |
| Dependencies | `X depends_on D` ⇒ "X is blocked by D". `gp` creates the GitHub blocked-by edge. |
| Estimates | Fibonacci story points (1–13). |
| Granularity | A story is one **bounded, verifiable unit** — a PR-sized deliverable one execution context (human *or* AI agent) can carry and review. Prefer fewer larger stories (5–8 pts) over many tiny ones (1–3 pts): over-decomposition multiplies coordination overhead without adding planning value. When a plan comes out too finely split, **merge tightly-coupled adjacent stories** into ≤8-pt stories and demote the detail into the story's `**Tasks:**` list — a merged story must be one coherent phase/concern, not a grab-bag. |
| Testing | **Unit tests belong in the Story, not in a separate workstream.** Every story's acceptance criteria must include the unit tests that verify it, and its points cover writing them. Never create a standalone unit-test story or epic. Only cross-cutting suites that span many stories and need an integration cluster (e2e) become their own story — named for that scope (e.g. "e2e validation"), not "Tests". |
| TODO items | **Skip explicitly-deferred / future-work items** (TODO lists, "future", "out of scope for this version") in the source doc — do not create issues for them. Plan only the committed scope; a doc's TODOs are signals of what **not** to schedule. (Create a backlog of them only if the user explicitly asks.) |
| Repo | Inferred from the git remote; override with `<owner>/<repo>` or `--repo`. |

## 4. Estimation rubric (story points)

| Points | Definition |
|---|---|
| 1 | Trivial — typo, single-line change, covered by existing tests |
| 2 | Small — self-contained, 1–2 files, minimal new tests |
| 3 | Medium — well-understood feature, a few files, tests required |
| 5 | Large — multi-file, some design decisions, coordination |
| 8 | X-large — complex / risky / cross-cutting; split if possible |
| 13 | Epic-scale — too big to estimate reliably; **must be split** into ≤8-point issues |

Rules: anything worth 13 points must be decomposed. Estimates are relative team
effort, not calendar time. When in doubt, choose the lower number. Epic issues
usually have no estimate (`story_points: null`) — their children carry points.

A story's points include its unit tests — testing is part of the story's effort,
never a separate line item. (An e2e suite spanning many stories is the only
testing that gets its own story; see §3.)

When merging stories, cap the combined estimate at 8 even if the raw sum is
10–11 — a merged 8 is coarser than a native one and the milestone total drops
slightly. That is fine for relative planning; prefer the lower merged estimate
over a 13 that would have to be split again (see §3 "Granularity").

## 5. Priority rubric

| Priority | Definition |
|---|---|
| P0 | Blocks release / production incident / must ship this sprint |
| P1 | High value, planned for the current milestone, should ship |
| P2 | Normal backlog; schedule as capacity allows (default) |
| P3 | Low / nice-to-have |

## 6. Prerequisites & environment

- `gh` (GitHub CLI, any version with `gh api`) authenticated: `gh auth login`.
- `jq`.
- Stock macOS bash (the script targets bash 3.2).
- The script uses the raw API for sub-issues and dependencies — it does **not**
  require the newest gh CLI flags, and it works entirely offline in dry-run.

Install:
```bash
brew install gh jq
gh auth login
```

## 7. Workflows (feature by feature)

### 7.1 Generate issues from a PRD / design doc / TODO list

1. Read the document. Decompose into an epic + child issues (or a flat list).
   Skip TODO / future-work items — they are signals of what not to schedule,
   not issues to create (see §3 "TODO items").
2. For each issue write a body from `references/issue-template.md` (Context /
   Goal / Scope / Acceptance criteria as checkboxes). Every story's acceptance
   criteria must include the unit tests that verify it — never spin unit tests
   off into a separate story (see §3 "Testing").
3. Assemble a **manifest** (see §8), with `body` inline or `body_file` pointing
   at a markdown file. **Ask the user which `assignees` to set** before
   finalizing — don't invent handles or assume the executor is the assignee
   (see §7.5).
4. Preview and apply:
   ```bash
   gp plan <owner>/<repo> <manifest.json> --dry-run --state <snapshot>.json
   gp plan <owner>/<repo> <manifest.json> --dry-run          # if no snapshot
   gp plan <owner>/<repo> <manifest.json>
   ```
5. Re-running `gp plan` is a no-op for work that already exists.

### 7.2 Detect or create the milestone

```bash
gp milestone <owner>/<repo> "<Milestone title>" --due 2026-09-30 --desc "Quarterly release"
```
A manifest's `milestone` block does the same automatically. `gp plan` reuses an
open milestone with the same exact title; otherwise it creates one.

**Reuse an existing milestone, don't create a per-feature one.** Design work
almost always belongs to a platform/phase milestone ("Phase 1", a release
train), and a feature-named milestone is the wrong level — the team tracks
releases/phases, not one milestone per feature. Before finalizing the manifest,
list open milestones
(`gh api repos/<owner>/<repo>/milestones?state=open --jq '.[].title'`) and, if
one already covers the scope, use its exact title in the manifest so all issues
land there. Ask the user when the target milestone isn't obvious.

`due_on` is optional and **must be omitted when unset** — GitHub rejects both
`""` and `null` with `422 "is not a valid date-time"`. Provide a real
`YYYY-MM-DD` or leave the field out of the manifest entirely.

### 7.3 Create features, epics, and child issues

Hierarchy is expressed by **chained `children`** — any issue can reference other
manifest issues as children, so `Feature → Epic → Story` is two levels of nested
GitHub sub-issues:

```json
{ "title": "Feature: onboarding", "type": "feature", "children": ["Epic: onboarding"] },
{ "title": "Epic: onboarding", "type": "epic", "children": ["Onboard via OAuth"] },
{ "title": "Onboard via OAuth", "type": "story", "story_points": 5 }
```
`gp plan` creates all of them and links each level (`Feature`→`Epic`, `Epic`→Story)
as sub-issues. The `type` value is applied as a **bare label** (`feature`/`epic`/
`story`/`task`/`bug`/`doc`). Only Story issues carry `story_points`; Features/Epics
are grouping issues. (An issue must not declare both `parent` and `children` —
`gp validate` rejects it. `children` titles must exist elsewhere in the manifest.)

### 7.4 Link dependencies (blocks / blocked by)

```json
{ "title": "Onboarding email", "type": "feature", "depends_on": ["Onboard via OAuth"] }
```
`gp plan` creates the blocked-by edge: "Onboarding email" is blocked by
"Onboard via OAuth". Titles must exist elsewhere in the manifest.

### 7.5 Assign labels, priorities, and assignees

Per issue in the manifest: `type` (required, one of `feature|epic|story|task|bug|doc`,
applied as a bare label), `priority` (default P2), `extra_labels` (any non-taxonomy
labels, e.g. `"ux"`), and `assignees` (list of repo-collaborator GitHub handles).
`gp plan` ensures every label exists, then applies them in the same API call
that creates the issue. Assignees must be repo collaborators or the API rejects
the issue.

**Ask, don't assume.** When generating a plan, ask the user which handles to assign
per issue (or confirm the issues should be left unassigned). `gp` sends an empty
assignee list when `assignees` is omitted — it does **not** auto-assign the creator.
And the assignee is the human owner/reviewer, not the executor: execution may be
delegated to an AI agent that is never named as the assignee (see §3 "Assignees").

### 7.6 Estimate story points

```json
{ "title": "Onboard via OAuth", "story_points": 5 }
```
`gp plan` converts it to the `story-points:5` label. Points must be on the
scale in `config/planning.json` (1,2,3,5,8,13) — otherwise `gp validate` fails.

### 7.7 Generate release notes from a milestone

```bash
gp release-notes <owner>/<repo> "<Milestone title>"
gp release-notes <owner>/<repo> v1.0 --tag v1.0 --create-release --draft --out RELEASE_NOTES_v1.0.md
```
Notes are grouped by type (Features / Bug fixes / Chores / Docs / Tests / Other)
with closed items marked, plus a summary (issue counts, story points done).

### 7.8 Update milestones as implementation progresses

```bash
gp update-milestone <owner>/<repo> v1.0            # progress report
gp update-milestone <owner>/<repo> v1.0 --auto-close
gp update-milestone <owner>/<repo> v1.0 --label-blocked
```
Recomputes progress, rewrites the milestone description with a marker-delimited
progress block (your original text is preserved), closes the milestone only with
`--auto-close` at 100%, and (live only) labels open issues `status:blocked`
when they have open blockers.

## 8. Manifest schema

```json
{
  "milestone": { "title": "v1.0", "due_on": "2026-09-30", "description": "Quarterly release" },
  "issues": [
    {
      "title": "Epic: onboarding",
      "body": "Onboarding workstream.",
      "type": "epic",
      "priority": "P1",
      "story_points": null,
      "assignees": ["alice"],
      "extra_labels": ["ux"],
      "children": ["Onboard via OAuth", "Onboarding email"]
    },
    {
      "title": "Onboard via OAuth",
      "body_file": "docs/oauth.md",
      "type": "story",
      "priority": "P0",
      "story_points": 5,
      "assignees": ["bob"],
      "depends_on": ["Epic: onboarding"],
      "parent": "Epic: onboarding"
    }
  ]
}
```

`milestone` is optional. When present, `title` is required; `due_on`
(`YYYY-MM-DD`) and `description` are optional. Use the **exact title of an
existing open milestone** to reuse it — `gp` creates a new milestone only when
no open one matches (§7.2). Prefer a platform/phase milestone over a
feature-named one.

Fields: `title` (required), `type` (required, one of `feature|epic|story|task|bug|doc`,
applied as a bare label), `body` **or** `body_file` (relative to the manifest or
`--body-dir`), `priority` (default P2), `story_points` (on-scale or null),
`assignees` (list of collaborator handles; empty when omitted — no auto-assign), `extra_labels`, `children`, `parent`,
`depends_on`, and an optional per-issue `"milestone": null` to exclude that issue
from the manifest milestone.

**Multi-level hierarchy:** `children` may be used on any issue and its titles must
exist in the manifest, so `Feature` (children = Epics) → `Epic` (children = Stories)
nests into two levels of GitHub sub-issues. Story bodies end with a `**Tasks:**`
checkbox list for the Task level and must include unit-test acceptance criteria
for the story's behavior (§3 "Testing").

Validate offline anytime: `gp validate <manifest.json>`.

## 9. Safety & idempotency rules

- **Dry-run first.** `--dry-run` prints every action and changes nothing.
- `gp` **never deletes** issues, labels, or milestones.
- **Create-if-missing:** an existing **open** issue with the same exact title in
  the target milestone is skipped on re-run. Newly-created issues get their
  links on creation.
- Milestone titles should be unique; `gp` matches open milestones by exact title.
- `--auto-close` is the only way a milestone gets closed — never do it implicitly.
- For a realistic dry-run, pass `--state <repo-snapshot.json>`; without it,
  `gp` assumes an empty repo and says so.

## 10. References

- `scripts/gp` — the helper CLI (`gp help` for all options).
- `config/planning.json` — label taxonomy, priority order, estimate scale.
- `references/issue-template.md` — issue body template.
- `tests/smoke-test.sh` — offline test suite (`bash tests/smoke-test.sh`).
- `tests/fixtures/plan.json` — a worked manifest example.
