# Per-test checklist and smell catalogue

## The checklist

Ask of every test, in this order:

1. **Name vs assertion.** Does the `expect` check what the name promises? A test named "only shows
   in-stock items" that never combines the stock filter with another filter does not check the bug
   that combination hides.
2. **Can it fail?** If the code under test were wrong here, would this assertion go red?
3. **Where does the expected value come from?** A literal from the requirement is good. A value
   recomputed with the production formula, read from the stub, or pasted from a run of the code is
   not.
4. **Is the whole contract checked?** Return value *and* side effects: the row, the request sent,
   the audit entry, the emitted event.
5. **Implementation or behaviour?** Would a refactor that keeps behaviour turn this red?
6. **What does each double prove?** Is anything inside the slice under test replaced?
7. **One act?** Arrange, Act, Assert, with one action under test.
8. **How is state reset?** In the file, per test? Or not at all, or in global setup?

## Always-green tests

| Form | How it looks | Fix |
| --- | --- | --- |
| swallowed exception | `try { fn() } catch {}` with no assertion in the catch; or a test whose only `expect` is in a branch that never runs | `expect(() => fn()).toThrow(ErrorType)` and assert the message |
| trivial assertion | `toBeDefined()`, `not.toBeNull()`, `typeof x === 'object'`, `length > 0` | assert the concrete value |
| testing the mock | expected value equals what the stub returns; deleting the function body keeps it green | assert the logic between input and output; use a fake or the real result |
| "does not throw" | the only check is that nothing exploded | assert the result |
| auto-updated snapshot | the snapshot was re-recorded in the same change that altered behaviour | explicit assertions; establish whether the change was intended |
| no `expect` at all | a test that just calls the code | add the assertion or delete the test |

A test that kills none of the mutants run against its code: see
[mutation.md](mutation.md#a-test-that-kills-nothing).

## Logic in the test

A test that repeats the production arithmetic is wrong in sync with the code. No formulas, `if`,
or loops in a test body; expected values as literals or named constants (`standardOrder`,
`expectedTotal`), not numbers in test names. Table-driven tests (`it.each`) are the exception —
the table holds literals. Importing a constant the module exports (a threshold) is acceptable.

## Implementation details

| Smell | Sign | Fix |
| --- | --- | --- |
| mock dictates implementation | asserts a specific helper was called with specific arguments | assert behaviour; keep call assertions for calls that *are* the outcome |
| private methods tested | imports internals, or exports them only for tests | test through the public contract |
| snapshot of internal structure | a component tree or object dump | assert what a user or caller can observe |
| CSS class as visibility | `toHaveClass('hidden')` in JSDOM | real browser (Vitest Browser Mode) and `toBeVisible` / `not.toBeVisible` |
| locator by test id or CSS | `getByTestId`, `querySelector(...).closest(...)` | text or label, then role with name; test id last |
| mocked pure function | `vi.mock` of a module with no effects | let it run |
| test bent to a mutant | without knowing the mutation, nobody can tell why this check exists | rewrite against behaviour or delete |
| "cement" tests | refactors keep needing workarounds to keep tests green | tests on behaviour only; reject tests that pin the implementation |

## Doubles

| Smell | Sign | Fix |
| --- | --- | --- |
| over-mocking | the slice's own DB, store, selectors or child components are mocked | real inside the slice; mock network, neighbours, externals |
| stubs without ordering | "issue invoice" and "pay invoice" stubbed independently | a fake with state |
| fake DB | `save()` always succeeds | real DB (the rule lives in the schema) |
| fetch replaced by hand | `window.fetch = vi.fn()`, ad-hoc patching of a directly imported client | MSW (or pass a fake if the service already receives the client) |
| `setProps` simulating the system | props pushed from the test instead of from the real source | include the real source; `setProps` only for a pure presentational reaction |
| prefilled store | state set directly so a counter "works" | build the state with real actions, or state that reachability is unproven |
| heavier double than needed | a mock where a dummy or spy would do | the least powerful double |
| DI for a singleton | an interface with one implementation, added only for tests | module mock |
| frozen time missing | `Date.now()` used, no fake timers | fake timers, `setSystemTime` in `beforeEach` |

## Structure

| Smell | Sign | Fix |
| --- | --- | --- |
| chained test | act/assert/act/assert; named after a method, not a behaviour | split by behaviour; the earlier act becomes the next test's arrange. Repeating the same act (`tick` three times) is fine; a loop is not. Smoke E2E tests may chain by design |
| duplicate assertions | `<= 3` followed by `= 2` on the same value | keep the stronger one |
| greedy test | 6–10 entities; "fixed it five times for five reasons" | split, or move up to E2E |
| two screens of setup | the arrange dwarfs the act | narrower slice, factories, arrange helpers with an options object |
| a "unit" with I/O | hangs without network; reads files; depends on locale or region | replace the dependency, or call it integration honestly |
| one-example fixture of an external service | a field typed as always present that is sometimes null | derive the type from several responses and the docs |
| many ways to reach one widget | xpath here, class there, id elsewhere for the same third-party control | one shared helper for that control |
| narrative comments | comments restating each line | keep only the *why* |

## State and isolation

| Smell | Sign | Fix |
| --- | --- | --- |
| shared mutable fixture | exported object, tests pass alone and fail together | factory, `structuredClone` |
| leak through globals | failures depend on which files share a worker | do not write to `globalThis`/`window`; isolate by process |
| non-serialisable setup | fails only on machines with a different core count | pass only JSON-like data to workers |
| reset in global setup | removing it from one file's view breaks an `.only` run | `beforeEach` reset in the file |
| rollback assumed | code opens its own transaction; the wrapper does not contain it | verify by running the suite twice; separate committed client for concurrency tests |

## Volume

A PR with a hundred new tests is a smell on its own: read it in chunks, and ask whether the level is
too low — a flood of tests usually means implementation details are being tested.
