# Choosing the level

Levels differ by **where the test enters the system**, not by how much code runs:

| Level | Entry | Real parts | Replaced |
| --- | --- | --- | --- |
| Unit | a direct call into one module | that module (and pure helpers it imports) | other modules with effects, time, network |
| Integration | a direct call into the system | one vertical slice, including its DB or store | the network, neighbouring slices, external services |
| E2E | the user's door: browser or public HTTP API | everything you own | only what cannot be run (a payment provider's rare states) |

A unit test that crosses several pure files is still a unit test: pure functions are not mocked.
In JS the practical unit is the file/module — a function in the same file cannot be swapped without
injection.

## The shape of the suite

Wider tests are slower and point less precisely at the cause when they fail. With agents writing
tests, narrow tests are nearly free to produce and give the agent feedback in milliseconds across
dozens of runs; the bottleneck is checking that they test anything. So the suite leans back toward
a pyramid — but the shape is an optimisation for the project's costs, not a law. A slow external
dependency that cannot be faked pushes toward units; a startup whose architecture changes weekly
should not invest in integration tests yet.

Models disagree on level by temperament: some write sprawling E2E for everything, some only units,
almost none choose integration on their own. Decide the level yourself and write it down.

If you find yourself generating a huge number of tests for one feature, the level is too low:
you are testing details. Move up.

## Unit

Three properties define it, not the folder it sits in:

- **Fast** — milliseconds.
- **Isolated** — nothing outside the process: no network, file system, real clock, locale.
- **Deterministic** — same input, same result, on any machine, a year from now.

A "unit" test that calls an external service and hangs in retries without network is not a unit
test.

## Integration = one vertical slice

A vertical slice is everything one business task needs — handler, logic, its tables, its store —
whether or not the code is organised that way. Inside the slice nothing is mocked. Mock the network
(MSW), neighbouring slices, and external services.

**Do not mock the part that carries the contract.** "One review per product" enforced by a unique
index is part of the endpoint's contract; a mocked DB that answers success to every save let a
double-click create two reviews. A mocked DB loses integrity constraints, consistency of
multi-step writes (insert plus rating recalculation), and races.

Backend specifics:

- Assert derived data and side effects, not only the response (`auditLog` row exists).
- Add one line for the error flow and one for provoking a failure of the layer below.
- Concurrency: fire the competing calls together and assert the invariant, not the order. Use the
  committed (non-rolled-back) client with a pool of at least two connections — one connection
  serialises the calls and the race never happens. Prove the test is red by removing the lock or
  transaction once.

```ts
it('sells the last seat exactly once', async () => {
  await seedEvent(committedDb, { capacity: 1 });

  const results = await Promise.allSettled([buy(committedDb, 'u1'), buy(committedDb, 'u2')]);

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected' && r.reason.code === 'SOLD_OUT')).toHaveLength(1);
  expect(await soldCount(committedDb)).toBe(1);   // reading the DB directly is fine: it is part of the slice
});
```

- Reading the DB directly to check a result is fine — the table is part of the entity, and a test
  that breaks when storage changes is signalling a contract change. Prefer that over adding
  "for tests only" endpoints; the one accepted backdoor is a tightly protected test login path.
- Business-logic tests switch off cross-cutting plumbing (authorization) by granting all rights —
  unless the permissions are what you are testing.

Frontend specifics:

- One component with its own store is a unit. Several components sharing a store is integration:
  an action in one, an assertion in another (mark as read in the card → counter on the bell).
- Real store, mocked network. Never replace store methods or selectors. Get the store into a state
  by calling its real actions (honest; proves the state is reachable) or, when that is very long,
  by setting state directly (cheaper; does not prove reachability — say which you chose).
- When data arrives from a request made higher up, mock the network and dispatch the action that
  fills the store.
- `setProps` to simulate something the system would do is a red flag — usually the wrong component
  is mocked. Ask what really changes those props and include it. (`setProps` is fine for a pure
  presentational component's reaction to new input.)
- Test the slice's component, not the page that only glues slices together.

**Size.** Around 3–5 real entities per test. At 6–10, split it or move it up to E2E. Ask: "for how
many different reasons could this test break while everything else is green?" Many reasons → split.

## Contracts between teams and services

Two sides green, integration broken: the backend sends `role` as a string, the frontend expects a
numeric `permissionLevel`. A contract is a written, measurable promise, strongest first:

1. a runtime schema (Zod, Effect Schema) — can express invariants and validates real data;
2. JSON Schema / OpenAPI / gRPC definitions — shape, but not relations between fields;
3. hand-written `.d.ts` types.

Fix the contract before parallel work starts and test both sides against it. When two agents build
front and back in parallel, one coordinator owns changes to the contract.

Put contract tests at the boundaries of ownership (your code vs theirs, large modules), not on every
file, and run them in their **own CI job** so red means "the contract drifted", not "a flaky test".

Building a fake of an external service: give the model every source you have — documentation, real
responses, the OpenAPI file, published types — and ask it to list gaps and conflicts. A fake built
from two examples will claim a field is "always present" that is null in a rare state.

## E2E: only what cannot be proven lower

Write an E2E test only if at least one holds:

- the step is **irreversible** (an email sent, a payment captured, an account deleted);
- it guards **money or access** (password reset, checkout, permissions);
- it crosses a **real external system** whose behaviour lower tests cannot reproduce.

Plus a small **smoke set** over the most important paths, run first. A smoke test may chain
step/check/step/check through one journey — it trades Arrange-Act-Assert for speed and breadth. The E2E suite must not grow
with the number of scenarios: a pile of E2E tests that differ only by an input format, and none about
reusing a password reset link, is the wrong suite. Formats, animations, hover states and calculation correctness belong
below.

Each level answers its own question for the same feature: the unit checks token logic; integration
checks the token is deleted and the password changed; E2E walks the whole path through the email
and tries the link a second time.

E2E mostly covers the normal flow. Push error and exception flows down a level.

Mechanics:

- The user's journey goes through the UI; setup, seeding and other actors' actions (admin approval,
  webhooks) go through the API or DB. A second browser session acting as the admin is a flake
  risk.
- List asynchronous and out-of-band scenarios explicitly before writing — "what happens outside the
  user's screen?" — and validate the list with a person. Rules in a config file do not remind a model
  of these; a reviewed list does.
- Email: run a mail-catcher container with an inbox you can query.
- A separate environment per run; a shared one accumulates garbage and settings nobody expects.
- Applications built on an LLM: integration tests use a scripted fake model with predetermined
  answers and check the wrapper calls tools correctly; E2E uses the real model and checks the
  outcome (a file, a state), not the wording.
