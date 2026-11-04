# Flaky tests

A **non-deterministic** test depends on something uncontrolled (random, the date). A **flaky** test
passes and fails with no code change; the cause is more often the environment or a race than the
code or the test. Most flakes are E2E. A test with a nickname, about which people say "a rerun helps",
is flaky.

**Never rerun blind.** A spinner test failed one run in ten; CI was rerun without reading the log,
and the green run hid a real cache race.

## Triage

1. **Read the log** of the failing run before anything else. Put the test on the flaky list.
2. **Confirm it is a flake:** the same job on the same commit failed, then passed. If commits landed
   between runs, it is not evidence of a flake.
3. **Non-determinism:** time (`Date.now()`, timers), random, locale, the machine's region or timezone,
   network inside a "unit" test.
4. **Coupling:** a shared resource (DB rows, Redis, a file, a cache, the browser's HTTP cache), a
   mutable shared fixture, writes to `globalThis`/`window`.
5. **Reproduce:** the whole suite, random order with the same seed, in parallel — not one or two files.
   Compare with file parallelism switched off (`--no-file-parallelism` in Vitest): if it passes
   serially, the cause is shared state.
6. **Parallelism:** only serialisable data passed to workers; no more workers than cores; one DB (or
   schema) per worker or rollback per test.
7. **E2E races:** the runner and the page are two competing asynchronous processes; under a busy
   event loop the runner misses a short intermediate state such as a spinner.
8. **Fix the cause.**
9. **Quarantine** only if you cannot fix it now **and** the test is not critical: put it on the
   quarantine list with an owner and a date.
10. **Move it down** when an expensive E2E test has a high flaky rate: rewrite it at integration level
    with the network mocked.

### Not fixes

- Removing the assertion on the intermediate state (the spinner). The state is part of the
  behaviour.
- Slowing the backend down so the test can see it.
- Blanket retries. They make the suite green and the bug invisible.
- "Only changed tests pass" as proof of stability.

## Flakiness as a process

Flakes are a culture problem — pressing retry is easier than reading a log — so treat them as a
process, not a series of incidents:

- An **automatic flaky list** built from CI history: same job, same commit, failed then passed.
  A script for it is a one-prompt job for an agent.
- A **limit** (e.g. ten). Crossing it is an alarm, not a statistic.
- A **scheduled review** with named owners.
- A **quarantine** for non-critical tests only — a handful, not a dumping ground. Implement it as a
  generated list that CI reads at run time (refreshed every few minutes), so it applies to old
  branches too, instead of rebasing every branch.
- **Fail-fast** only when the suite is stable; on a flaky suite it turns CI into a lottery. Large
  systems: a partial run per merge request, the full run on a schedule.

## The arithmetic

Fifty tests that each pass 99% of the time give a green run only about 60% of the time
(0.99⁵⁰ ≈ 0.60). At 99.9% each: 50 tests ≈ 95% green, 100 tests ≈ 90%. A suite does not tolerate
"mostly reliable" tests.

## Flaky rate

Failures that passed on rerun ÷ all failures. It measures how well the tests fit the infrastructure,
and it is the argument for rewriting slow E2E at integration level with the network mocked, which
can cut both run time and flakiness several times over. See [metrics.md](metrics.md).
