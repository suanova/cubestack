# Issue Body Template

When generating an issue from a PRD, design doc, or TODO list, write the body from this
template. Skip sections that don't apply; keep acceptance criteria as a checkbox list so
GitHub renders a progress bar.

```markdown
### Context

_Why does this work exist? Link the PRD / design doc / related issue._

### Goal

_What should be true when this is done, in one or two sentences._

### Scope

- **In:** ...
- **Out:** _things explicitly not covered here_

### Acceptance criteria

<!-- every story must include the unit tests that verify this story's behavior -->
- [ ] ...
- [ ] ...

### Notes / open questions

- ...

<!--
  Optional: leave this block out of the final body.
  Estimates and priorities are applied as labels by `gp plan`,
  not embedded in the body.
-->
```

## Guidance for the writer (Claude)

- **Title:** imperative, specific, and short enough to scan in a list
  (e.g. "Add OAuth login to onboarding flow", not "Onboarding stuff").
- **Acceptance criteria** are what make an issue shippable and testable — write at least two.
- **Granularity:** prefer a few bounded stories (5–8 pts) over many tiny ones. If a plan comes
  out over-decomposed, merge tightly-coupled stories into one coherent ≤8-pt story and keep the
  detail in its `**Tasks:**` list.
- **Unit tests are part of every story.** Each story's acceptance criteria must include
  the unit tests that verify it (a checkbox like "unit tests cover <this behavior>"), and
  the story's points cover writing them. Never create a standalone unit-test story or epic.
  The only testing that becomes its own story is a suite spanning many stories that needs
  an integration cluster (e2e).
- **Skip TODOs.** Explicitly-deferred / future-work items in the source doc (TODO lists,
  "future", "v2") are not turned into issues — plan only the committed scope. Create a
  backlog of them only if the user explicitly asks.
- **Estimate and priority** belong in the manifest (`story_points`, `priority`), where the
  `gp plan` subcommand converts them into `story-points:N` / `priority:P*` labels. Do **not**
  hardcode them into the body.
- **Epics** are issues with `type: epic` and a short body describing the outcome; their
  scope lives in the children. Estimate an epic only when the children can't be sized.
