# Metrics: three numbers, read together

A metric that becomes a target stops measuring (Goodhart). A gate "coverage < 70% — no merge" turns
into "write more tests", and an agent will write any tests that turn the gate green. People write
bad tests out of laziness; agents write them because they reach the goal by any means available.
Coverage went from 70% to 95% and incidents went up: the new tests cemented the implementation.

**Never ask for "raise coverage to N%".** Ask instead: "raise coverage with tests on modules X and Y
without lowering the mutation score or growing the quarantine list."

## The three

| Metric | How to read it | Trap |
| --- | --- | --- |
| **Coverage** | as a **trend**, branch rather than line | a jump from 30% to 70% in a day usually means E2E got counted — keep E2E out of coverage |
| **Mutation score** | **per merge request**, on changed business logic; start around 90% killed, then a hard gate for critical modules | "0 survivors" as a goal forces tests against equivalent mutants |
| **Flaky rate** | failures that passed on rerun ÷ all failures | a rising rate is an infrastructure-fit problem, often solved by moving E2E down a level |

Any one alone can be gamed; together they constrain each other: coverage rising while mutation score
falls means tests that run code without checking it.

## Other signals

- **Defect escape rate** — a bug reached users although a test for that path existed. The test is bad
  regardless of its metrics; this is the main quality signal for E2E, where mutation testing does
  not apply.
- **Bugs per feature**, not raw bug count: more bugs while shipping more features can be normal.
- **For every production bug, ask at which step of the flow it was missed** — spec, test plan, review,
  pass 2 — and fix that step.

## CI shape

- CI even on a small project: a clean environment and the full suite with coverage.
- Agents can bypass a pre-commit hook when told to "push at any cost"; checks that matter live in CI.
- Units and integration: affected-only runs per change are almost always possible. E2E: a heuristic
  ("touched folder A → run A's E2E") per change, the full set nightly.
- With agents, completeness on CI matters more than a fast local loop.

## Reviewing a coverage claim

When someone says "fully covered": ask for the mutation score on the same files, check whether E2E is
counted, and run pass 2 ([two-pass.md](two-pass.md)) — coverage cannot see a missing combination.
