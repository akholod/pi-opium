---
name: write-tests
description: Write or add automated tests that would actually catch a bug — pick the test level and strategy, choose test doubles, cover legacy code safely with pinning tests first, or turn a task into a test-as-spec (concrete input/output pairs and boundaries) for an implementing agent. Use when the job is to create tests or a test plan, in TypeScript/JavaScript or any stack whose runner the project already has. Not for judging tests that already exist (a PR's tests, agent-written tests, flaky or mutation triage) — that is review-tests. Not for fixing a failing test or updating snapshots after an intended change.
---

# Write tests that would catch a bug

A test records a decision about what correct behaviour is, and fails when that behaviour changes.
The expensive failure is a green test that verifies nothing. Ask of each assertion:

> **If the code were wrong right here, would this assertion fail?**

## Core — always, on every path

- **Expected values come from the requirement** — or, for a regression, from the bug report and the correct behaviour — never copied from the code's output (pinning tests on legacy code are the labelled exception).
- **Assert values, not shapes:** `toBe(900)`, not `toBeDefined()`, `typeof` or `length > 0`; for an expected error, its type and message.
- **See each new test red once:** break the code under test by hand (flip `<` to `<=`, delete the line), run, watch it fail for the right reason, restore.
- **A suspected bug in the code under test is not pinned as green.** Mark it (`it.todo`, or a failing test with a note) and report it.
- **Report the decisions you made without asking** — an assumed boundary, an inferred expected value, a chosen double.

---

## Procedure

0. **Pick the path.** If unsure, start light and say in the report what the full path would add.
   - **Light** — one or a few tests, a regression test for a bug fix, a single function, a small
     change. Detect the runner, the command for one file and where tests live; apply the core; add
     to the module's existing test file if there is one; run the affected test
     file(s). No plan document, no asking for expected values the bug or requirement already
     defines, no mutation tool, no random-order runs.
   - **Full** — a new module or feature, legacy code, a test strategy or plan, test-as-spec for an
     agent, or the user asks for thoroughness. Steps 1–8 below.

1. **Detect the stack.** Read `package.json` (scripts, devDependencies), the lockfile, runner and
   Stryker configs, setup files and the existing test layout. Follow what exists; the defaults in
   [references/stack.md](references/stack.md) apply only where nothing does.
   *Done when* you can name the runner, the command for one file, where tests live, and how the
   project fakes the network and the database. New tests follow the existing layout and naming
   (colocated `src/x.test.ts` stays colocated; extend the module's existing test file rather than
   starting a parallel one). *Why:* a second runner is a build nobody runs, and a second test
   location splits the module's tests where the next reader will not look.

2. **Fix the contract and expected values.** Per behaviour: preconditions, result, side effects
   (rows, requests, events), invariants after any sequence of operations (balance ≥ 0, a transfer
   preserves the total). Source: ticket, spec, owner, bug report. If only running the code would
   tell you a value, ask — except for pinning tests
   ([references/legacy.md](references/legacy.md#2-pin-current-behaviour)).
   *Done when* every planned test has a literal expected value with a source you can name.

3. **Prioritise by risk, not by file:** a production bug → business rules → boundaries → glue. On
   untested code rank by *breaks often*, *changes often*, *touches money or access*
   ([references/what-to-test.md](references/what-to-test.md)).

4. **Pick the cheapest level that can observe the failure**, and state it in the plan
   ([references/levels.md](references/levels.md)). *Why:* agents copy the level of the nearest test
   file, which in an old codebase is often wrong.

   | The failure lives in | Level |
   | --- | --- |
   | a calculation, a branch, a state transition | unit |
   | a rule enforced by the DB or store, a side effect, two components sharing state | integration (one vertical slice, real DB/store, network mocked; components in Vitest Browser Mode rather than JSDOM) |
   | the agreement between two teams or services | contract (schema) test, own CI job |
   | an irreversible step, money or access, a real external system | E2E — plus a small smoke set |

5. **Enumerate the cases before writing code.** Normal, planned-error and exception flows (the layer
   below fails); boundaries as numbers (equal to the threshold, zero, empty, one before midnight);
   flag combinations; concurrency; time, timezone, locale; another actor's action.
   *Done when* each case is one line with input and expected output.

6. **Write each test small and literal.** Arrange, Act, Assert, one act per test. Expected values as
   literals or named constants, never recomputed; no `if`, loops or formulas in the body
   (`it.each` is fine). The minimal double, factory fixtures, fixed time, randomness and locale
   ([references/doubles-and-isolation.md](references/doubles-and-isolation.md)).

   ```ts
   // The rule says: orders at or above the free-shipping threshold ship free.
   it('ships free at exactly the threshold', () => {
     const order = makeOrder({ subtotal: FREE_SHIPPING_THRESHOLD }); // exported by the module

     const quote = quoteShipping(order);

     expect(quote.cost).toBe(0); // a literal, from the rule — not `subtotal >= LIMIT ? 0 : RATE`
   });
   ```

7. **Prove red, then run.** Manual breaks (core) are the default evidence. A mutation tool
   (Stryker) is an escalation for money, access or critical business logic, and runs **only if it
   is already installed or the user asked**. Never add a dependency or config file without asking —
   propose it in the report ([references/techniques.md](references/techniques.md),
   [references/stack.md](references/stack.md)). Run the affected tests; random order and parallel
   runs (`vitest --sequence.shuffle`) only when several test files or shared state are involved.

8. **Report.** Tests added, by level; behaviours covered and deliberately not; your own decisions;
   suspected bugs; anything you could not get to fail; tools you would propose. If the code touches
   money, access or critical business logic and no mutation tool was run, always propose one
   (Stryker for JS/TS) with the modules it should cover — manual breaks alone leave that gap open.

---

## Rules that apply everywhere

- **Test the contract, not the implementation.** A good test stays green through any refactor and
  turns red only when behaviour changes. No asserts on private functions, internal call order, or
  the internal structure of a render. *Why:* tests bound to implementation block every refactor and
  get "fixed" by weakening them.
- **Never assert what a double returned.** A test that bypasses the code under test, or compares
  the stub with itself, checks the stub. An expected value that merely equals the stub's canned
  value is a signal, not a verdict: delete the function body — does the test go red? *Why:* if it
  stays green, it tests its doubles.
- **Do not raise coverage as a goal.** Coverage shows what ran, not what was checked; an uncovered
  line is surely unverified, a covered one may be too. Never write tests "to reach N%". The allowed
  form is "raise coverage with tests on X without lowering the mutation score". *Why:* a number
  that becomes the target gets met by tests that assert nothing.
- **Leave the code under test unchanged** unless the task says otherwise (the pure/impure split
  after pinning, step 3 of [references/legacy.md](references/legacy.md), is the sanctioned exception). If a test needs a seam,
  say so in the report. *Why:* bending the code to fit a test hides the bug the test was for.
- **Garbage that cannot arrive is not a case.** Do not test impossible inputs inside the system;
  do test them at a module boundary that receives outside data. *Why:* it doubles the suite and
  protects nothing.

## Decisions this skill makes for you

Where reasonable sources disagree, follow these:

| Question | Resolution |
| --- | --- |
| Tests first (TDD)? | The **expected input/output pairs** are fixed before implementation — by the human or the spec. Writing the test file before or after the code is not a rule. |
| Module mock or dependency injection? | Use the injection the project already has (Nest, Angular, a function or service that already receives its collaborators). On the backend that usually means passing a fake HTTP client the service already takes. Otherwise mock the module with the runner. MSW is the single network interception point for frontend and full-stack code, or for backend code that calls bare `fetch`. Do not introduce DI or an interface only to make a test possible. |
| Global setup? | For infrastructure only: start a container, run migrations, hand a connection string to workers. **Never** for resetting state between tests — resets live in `beforeEach` in the test file. |
| Mock a child component? | Render real children inside the slice under test. Replace a child only when it belongs to another slice or loads its own data; then assert at most the props passed to it. |
| Mock vs fake? | Stub returns canned values; spy wraps the real thing and records calls; mock is a stub that records and asserts calls; **fake** is a working in-memory implementation with state. A "fake" that only replays fixed answers is a stub — name it so. |
| E2E entirely through the UI? | The user's path under test goes through the system's public entry point — the UI, or the HTTP API for a headless service. Setup, seeding and other actors' steps (an admin approving, a payment webhook) go through the API or the database. Assert what the user sees. |
| Expected values "from the code" in legacy? | Only in pinning tests, labelled as pinning, which record behaviour *including bugs* and are replaced later. |

---

## References — read the one your case needs

| Read | When |
| --- | --- |
| [references/stack.md](references/stack.md) | detecting the project's runner and tools; default stack examples (Vitest, Browser Mode, Testing Library, MSW, Testcontainers + Drizzle, Playwright) when the project has none |
| [references/what-to-test.md](references/what-to-test.md) | contracts, invariants, prioritisation, glue vs logic, coverage |
| [references/levels.md](references/levels.md) | unit vs integration vs E2E, vertical slices, contracts and schemas, what E2E is for |
| [references/doubles-and-isolation.md](references/doubles-and-isolation.md) | which double, MSW, time and locale, fixtures, DB isolation, parallelism, global setup |
| [references/techniques.md](references/techniques.md) | property-based, snapshot, differential and mutation testing |
| [references/legacy.md](references/legacy.md) | code with no tests: prioritise → pin → split pure/impure → real tests |
| [references/test-as-spec.md](references/test-as-spec.md) | handing a task to an implementing agent as tests or input/output pairs; the prompt template |

Judging tests that already exist is a different job with its own skill, `review-tests`.
