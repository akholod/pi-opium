# Doubles, fixtures and isolation

## The ladder of doubles

Use the **least powerful** double that does the job. Each step up adds something the test must keep
in sync with reality.

| Double | What it is | Use when |
| --- | --- | --- |
| dummy | fills a parameter, never used | the dependency is irrelevant (a logger you do not care about) |
| stub | returns canned values | you need a specific answer from a query |
| spy | wraps the **real** implementation and records calls | the real behaviour is harmless and the call matters |
| mock | a stub that records and verifies calls | the call itself *is* the outcome (an email must be sent) and it has side effects |
| fake | a working in-memory implementation with state | the dependency has state or ordering (issued invoices, a queue) |

Logger example: irrelevant → dummy; relevant and harmless → spy; writes somewhere real → mock.
Silence log noise through the log level, not with a double.

**The question for every double:** does the test need to prove *that a call happened*, or *what the
outcome is*? Prove the outcome whenever you can (stub/fake plus, at the system boundary, a contract
test). Proving a call couples the test to the implementation.

**Prefer a fake over a pile of stubs** when operations are related. Stubbing "issue invoice" and
"pay invoice" independently loses the rule that only an issued invoice can be paid; a fake that
stores issued invoices keeps it. Agents rarely write fakes unless asked — ask.

Fakes drift from reality quietly and for years. Pair a fake of an external service with a contract
test against the real one in a separate CI job.

Self-check: delete the body of the function under test. If the test stays green, it tests its
doubles.

## How to substitute

- **Module mock** (`vi.mock('./geo')`) is the default in JS: the code is unchanged and runs with a
  different import. Use it for modules with effects, not for pure functions.
- **Dependency injection**: use it where the project already has it (Nest, Angular) or where the
  function already receives its collaborators as parameters — then pass a fake. Introducing DI or an
  interface with a single implementation only for tests adds architecture that pays for nothing.
  Splitting effects from logic (ports and adapters, pure core) is worth doing for its own sake —
  see [legacy.md](legacy.md#3-split-pure-from-impure).
- **Network, backend**: if the service already receives its HTTP client, pass a fake client — that
  is the injection the code already has. If it calls bare `fetch`, intercept with MSW.
- **Network, frontend and full-stack**: MSW as the single interception point. It does not care which
  client the code uses and can fail the test on any unhandled request. Not `window.fetch = vi.fn()`,
  and not ad-hoc patching of a client the code imports directly.
- **Time**: fake timers and `setSystemTime` in `beforeEach`, not a time-provider parameter added to
  production code only for tests. `Date.now()` is the usual hidden dependency.
- **Locale and timezone**: set them in the test environment. Re-run a suspicious test in another
  timezone and at another time of day.
- **Browser APIs** outside your control (geolocation, clipboard): stub them.

Mocking a child component (React, Vitest): only for a child from another slice or one that loads its
own data.

```tsx
import { act } from 'react';
import { render } from 'vitest-browser-react';
import PaymentStep from './PaymentStep';

vi.mock('./PaymentStep', () => ({ default: vi.fn(() => null) }));

await render(<Checkout />); // vitest-browser-react 2.x: render returns a Promise
// drive the parent through the child's callback
const props = vi.mocked(PaymentStep).mock.calls.at(-1)![0];
await act(async () => props.onFinished({ orderId: 'o-1' }));
```

You are now responsible for the props being right — assert them, and keep at least one test where
the real child renders.

## Fixtures

- **Export a factory, not an object.** A shared mutable constant is the most common fixture bug:
  one test mutates it, another fails only when run after it.

  ```ts
  export const makeOrder = (overrides: Partial<Order> = {}): Order =>
    structuredClone({ id: 'o-1', status: 'draft', lines: [], ...overrides });
  ```

- Clone anything external with `structuredClone` before use.
- Type fixtures with the real API types; better, generate them from the backend (call the real
  service in a backend test, save the response, replace volatile fields such as ids and timestamps
  with stable ones). A fixture whose service renamed `status` to `resultCode` keeps everything green
  while production breaks.
- One example response makes a rigid, wrong fixture. Derive the type from several responses and
  the documentation (`riskScore: number | null`, fields that are mutually exclusive).
- A new business rule extending old fixtures with a field is normal, not a smell.
- Arrange helpers take an options object: `arrangeActiveSession({ minutes: 10 })`, not positional
  arguments.
- Keep helpers and mocks at the lowest level that needs them: in the test if one test uses it, in
  the folder if several do. A few duplicates are cheaper than one universal mock everyone bends.
- After seeding a shared canonical state, one `expect` that the seed is what you think is the one
  justified break from Arrange-Act-Assert.

## Isolation and parallelism

**Tests must pass in any order and under any parallelism.** A test that fails "depending on the
phase of the moon" is worse than no test.

Sources of coupling:

- mutated fixtures, `window`, `globalThis` shared within one worker process;
- a shared resource: DB rows, Redis, a cache, a log file, the browser's HTTP cache;
- non-serialisable data in setup: only JSON-like values cross to workers, so a function placed in
  setup silently disappears on a machine with a different core count.

Practice:

- With several test files or shared state, turn on random test order (`vitest --sequence.shuffle`); on failure record the seed and replay the
  whole suite with it (`--sequence.seed=<n>`).
- When the change touches several test files or shared state, run the full affected suite in
  parallel before calling it done — an agent that runs files one by one never sees a race.
- Pick a balance between isolation and parallelism and move from it deliberately; more workers than
  cores buys nothing.

**Global setup is for infrastructure** — start a container, apply migrations, provide a connection
string. **Resetting state belongs in the test file** (`beforeEach(() => resetLog())`), even if that
means the same hook in several files. A reset hidden in global setup disconnects the test from the
state it depends on, and an `.only` run is when the forgotten reset bites. The only *helpers* worth
making global are custom assertions and a login helper.

### Database isolation

- Default: each test runs inside a transaction that is rolled back afterwards (`testDb`).

  ```ts
  class Rollback extends Error {}
  export async function withTestDb(fn: (tx: Tx) => Promise<void>) {
    await committedDb.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();               // always roll back
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  }
  ```

- Concurrency tests need real commits: a separate, non-transactional client (`committedDb`) used
  only there, with explicit cleanup.
- Check the rollback approach actually works: not every DB supports nested transactions, and code
  that opens its own transaction can escape the wrapper. Verify by running the suite twice in a row.
- Alternatively: one database copy per worker, seeded fresh.

## Assertions that read like the rule

Custom domain assertions with clear failure messages make a test read as a requirement:
`expect(user).toBeAllowedToEdit(doc)`. Worth it for rules checked in many places.
