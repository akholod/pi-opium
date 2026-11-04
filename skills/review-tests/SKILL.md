---
name: review-tests
description: Review tests that already exist — agent-written tests, the tests in a PR or diff, a suite someone calls "fully covered" — for whether they would actually catch a bug and what is missing; triage a flaky test; interpret mutation-testing survivors; judge coverage, mutation score and flaky-rate numbers. Use when the tests are already there and the question is whether they are any good. Not for writing new tests from a requirement or planning a test strategy — that is write-tests.
---

# Review tests: would they catch a bug?

A green suite says the tests pass, not that they check anything. Agents optimise for green: they
swallow exceptions, weaken assertions, assert on their own mocks, re-record snapshots, and write
tests that confirm their own implementation. Reviewing tests is now the bottleneck, and it is cheaper
than reviewing code — the tests stay behind as the contract.

The question for every assertion:

> **If the code were wrong right here, would this assertion fail?**

The question for the suite, which no tool answers: **what is not tested?**

---

## Core — always, on every path

- **Read each test in a fixed order: name → `expect` → doubles and logic**, with the questions in
  [references/smells.md](references/smells.md).
- **Check expected values against the requirement** (ticket, spec, PR description, bug report), not
  against the code. With no source, say every expected value is unverified.
- **Evidence is a manual break of the code under test** — flip a comparison, drop a transaction,
  delete the body — made in a `git worktree` or a copy, run, then restored. A break that leaves the
  tests green is a finding.
- **Pass 2, "what is missing?", is candidates for the human**, never a completeness verdict.

## Which path

| The ask | Go to |
| --- | --- |
| one test file, a small PR | **Light path**: [smells.md](references/smells.md) + manual breaks, then report. No mutation tool. |
| "assess the whole suite", a big PR, a "fully covered" claim | **Full path** below |
| a test passes on retry, fails only in CI, "flakes" | [references/flaky.md](references/flaky.md) |
| a mutation report, survivors, "is this score good" | [references/mutation.md](references/mutation.md) |
| coverage targets, quality gates, "are our tests getting better" | [references/metrics.md](references/metrics.md) |

If unsure, start light and say in the report what the full path would add.

---

## Full path

1. **Check who is reviewing.** If you wrote these tests, or the code they test, in this session,
   say so and recommend a fresh session, ideally a different model. Continue only if asked.
   *Why:* a same-session reviewer reports "all good"; a fresh one finds things.

2. **Detect the stack and the contract.** Find the runner and the command for one file
   (`package.json`, `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `stryker.*`) and the
   source of expected behaviour. *Done when* you can run the tests and name where "correct" is
   defined. *Why:* without checkable expectations a review is a matter of taste.

3. **Read each test** (core order). Large PRs: review in chunks; read the first tests of a module
   most carefully — later tests, and the next agent, copy their style.
   *Done when* every test is marked keep / fix (with the reason) / delete.

4. **Check the level and the doubles.** Cheapest level that can observe the failure? Any part of
   the slice under test mocked (its DB, store, own children)? A mock asserting a call where the
   outcome could be asserted? Criteria: [references/levels-and-doubles.md](references/levels-and-doubles.md).

5. **Prove it by breaking the code.** Manual breaks (core) are the default; never `git stash` or a
   branch switch in the user's tree. Without git, copy the directory and confirm with `diff -r`
   after restoring. If the review must be read-only, state "no mutation evidence". Run a mutation
   tool (Stryker) on the changed business logic **only if it is already installed or the user
   asked**; never install it or add a config without asking — propose it in the report. Setup and
   survivor classification: [references/mutation.md](references/mutation.md); never estimate a
   score by reading. *Done when* each finding has the break that survived as evidence.

6. **Check isolation.** Where is state reset — in the file, or hidden in global setup? Mutable
   shared fixtures, `globalThis`/`window` writes, a shared DB without rollback? With several test
   files or shared state, run the affected suite in random order and in parallel.

7. **Draft pass 2 — "what is missing?"** Combinations of flags, boundaries (equal to the threshold,
   zero, empty, day change), concurrency, time/timezone/locale, error and exception flows, another
   actor's action, invariants after a sequence of operations
   ([references/two-pass.md](references/two-pass.md)). *Done when* the list is **handed to a person
   to validate**. *Why:* the missing case is a judgement about the domain.

8. **Report.** Verdict first, then findings by severity — file, test name, what is wrong, the
   evidence (the surviving break), the fix. Then the pass-2 candidates, marked "for the human to
   confirm". Then what you did not check, and tools you would propose.

---

## Severity

| Level | Meaning | Examples |
| --- | --- | --- |
| P0 | the test cannot fail, or locks in a bug | swallowed exception; the test bypasses the code under test or compares the stub with itself (an expected value merely equal to the stub's is a signal — delete the function body: does the test go red?); expectation "fixed" in a pinning test; a mocked DB in the test of a DB-enforced rule |
| P1 | the test checks less than it claims | name promises a rule the assert does not check; shape-only assert; side effect unchecked; missing boundary the spec names |
| P2 | correct but costly | implementation detail that will break on refactor; wrong level; duplicate asserts; setup larger than the test |

---

## Decisions this skill makes for you

| Question | Resolution |
| --- | --- |
| Who does pass 1 (existing tests)? | An agent — preferably a different model in a clean session from the one that wrote the code or tests. |
| Who does pass 2 (what is missing)? | A person owns it. An agent may draft the candidate list; the person validates it. A review report never claims completeness on its own. |
| Mock vs fake? | Stub returns canned values; spy wraps the real thing and records calls; mock is a stub that records and asserts calls; fake is a working in-memory implementation with state. Judge doubles by these definitions, whatever the code calls them. |
| Module mock or DI in the code under review? | Both are fine. A backend test passing a fake for the HTTP client the service already receives is correct; so is MSW on the frontend. Flag DI or an interface introduced only for a test, `window.fetch = vi.fn()`, and ad-hoc patching of a directly imported client. |
| Global setup? | Fine for infrastructure (containers, migrations, a connection string). A finding when it resets state between tests. |
| A mocked child component? | Fine when the child belongs to another slice or loads its own data; a finding when it is part of the slice under test. |
| E2E doing setup via API or DB? | Correct. A finding when another actor's step (admin approval) runs through a second browser session, or when the user's own path under test bypasses the system's public entry point — the UI, or the HTTP API for a headless service. |
| Expected values taken from code output? | A P0 finding, except in tests explicitly labelled as pinning tests on legacy code. |

---

## References — read the one your case needs

| Read | When |
| --- | --- |
| [references/smells.md](references/smells.md) | the per-test checklist and the catalogue of smells, with fixes |
| [references/levels-and-doubles.md](references/levels-and-doubles.md) | judging the level of a test, slice boundaries, doubles, contracts, E2E criteria |
| [references/two-pass.md](references/two-pass.md) | running the two-pass review, the reviewer prompt, and the "what is missing" checklist |
| [references/mutation.md](references/mutation.md) | reading a mutation report and classifying survivors |
| [references/flaky.md](references/flaky.md) | triaging a flaky test and running flakiness as a process |
| [references/metrics.md](references/metrics.md) | coverage, mutation score and flaky rate as a set; why one number as a gate fails |

Writing new tests or a test plan is a different job with its own skill, `write-tests`.
