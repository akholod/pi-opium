# Judging level, slices and doubles

## Levels by entry point

| Level | Enters through | Real | Replaced |
| --- | --- | --- | --- |
| Unit | a direct call into one module | the module and pure helpers | modules with effects, time, network |
| Integration | a direct call into the system | one vertical slice, including its DB or store | network, neighbouring slices, external services |
| E2E | the user's door: browser or public API | everything you own | only what cannot be run |

The right level is the **cheapest one that can observe the failure**. Review questions:

- **A unit test of a rule the DB enforces** (unique index, constraint, transaction) is a finding: the
  mock answers success to every save, so a double-click duplicate is invisible.
- **An "integration" test that checks only a return value** is an expensive unit test. It should
  assert the side effect that justified the level (the audit row, the recalculated rating) — or move
  down.
- **An integration test repeating a unit test** adds cost without information.
- **An E2E test where a component or integration test would do** — formats, animations, hover,
  calculation correctness — is a finding. E2E must meet at least one criterion: an irreversible step,
  money or access, or a real external system. Plus a small smoke set.
- **Several components sharing a store tested only separately** — the card updates, the bell's counter
  does not, and both tests are green. The seam needs an integration test with the real store.
- **Only the happy path** — no error flow, no failure of the layer below, no concurrent request.

## Inside a slice nothing is mocked

Mock the network (MSW), neighbouring slices and external services. Do not mock the slice's own DB,
store, store methods or selectors. A child component may be stubbed only when it belongs to another
slice or loads its own data; then the test should assert the props passed to it, and some other test
should render it for real.

Reading the DB directly to assert a result is fine; the table is part of the entity. A "test-only"
endpoint added to make assertions possible is a finding — except a tightly protected test login path.

Tests of business logic may switch off authorization by granting all rights; tests of permissions
must not.

Concurrency tests assert an invariant, not an order: exactly one purchase of the last seat succeeds,
one fails as sold out, the sold count equals capacity. A test that asserts *which* request wins is
flaky by design.

## Doubles

| Double | What it is |
| --- | --- |
| dummy | fills a parameter, never used |
| stub | returns canned values |
| spy | wraps the real implementation and records calls |
| mock | a stub that records and verifies calls |
| fake | a working in-memory implementation with state |

For every double: **does the test need to prove a call happened, or what the outcome is?** A call
assertion is right only when the call is the outcome (an email that must be sent) and doing it for
real is impossible. Otherwise assert the outcome, using a stub or fake, with a contract test at the
system boundary.

- A pile of independent stubs for a stateful service loses ordering rules; suggest a fake.
- A fake of an external service with no contract test drifts quietly.
- `window.fetch = vi.fn()` or ad-hoc patching of a directly imported HTTP client ties the test to
  one client and breaks when `fetch` is captured early; suggest MSW with failure on unhandled
  requests. A fake passed for a client the service already receives (backend DI) is fine.
- DI or an interface added only for tests is a finding; DI the project already uses is fine.
- Time-provider parameters added to production code only for tests: suggest fake timers instead.

## Contracts across teams

If both sides of a boundary are green and the integration still breaks (`role` string vs numeric
`permissionLevel`; `totalCents` vs `totalAmount`), the gap is a missing shared contract — a runtime
schema (Zod, Effect Schema), then JSON Schema/OpenAPI/gRPC, then hand-written types. Contract tests
belong at ownership boundaries, not on every file, and in their own CI job.

## E2E specifics

- The user's path under test goes through the UI; setup and other actors' steps go through the API
  or DB. A second browser session acting as the admin is a flake risk and a finding.
- A frequent gap: the step that happens outside the user's screen (an admin approves the refund) and
  its visible result for the user.
- State leaking between E2E tests in a shared worker: each test seeds and resets its own data.
- Quality signal: **defect escape rate** — a bug reached users although an E2E test for that path
  existed. That test is bad, whatever its pass rate.
