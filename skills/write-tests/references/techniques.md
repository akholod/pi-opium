# Techniques beyond example-based tests

## Property-based

Hand-written cases with good coverage and good mutation scores can still miss the empty string,
a path made only of slashes, or a very long run of `..` segments. People and models both reach for typical
inputs. A property-based test states something that must hold for **every** input in a domain and
lets a generator search; a counterexample is shrunk to the smallest failing input.

Good properties:

- idempotence — `normalize(normalize(x))` equals `normalize(x)`;
- range invariants — a fee is always within `[0, DAILY_CAP]`;
- round trips — `parse(format(x))` equals `x`;
- state machines — after reaching `done`, `signedAt` is always set.

```ts
import fc from 'fast-check';

it('never charges a negative or above-cap fee', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 100 }),
      (minutes, discountPct) => {
        const fee = parkingFee({ minutes, discountPct });
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(DAILY_CAP);
      }),
  );
});
```

It widens the search; it does not replace hand-picked boundary cases. A property that restates the
implementation is worthless — look for a genuine invariant. Models are weak at finding properties:
propose them yourself, or review the ones an agent proposes.

## Snapshot

Avoid by default. The weakness is the habit of "update all": a snapshot that gets re-recorded every
time it fails is an always-green test, and an agent facing a red snapshot will re-record it.
Explicit assertions cost almost nothing to write now.

If a snapshot is unavoidable: keep it small, normalise the output (format it, sort class names,
strip test-only attributes), and never snapshot the internal structure of a large render. Before
updating a red snapshot, establish that the change was intended.

## Differential

Two implementations of the same specification — say, one written from prose and one from tests, or
old and new during a rewrite — run on thousands of random inputs and compared. A disagreement is a
place where the specification left a decision open (a session that starts before a tariff change
and ends after it: which rate?). Useful for rewrites and for exposing gaps in a spec before it reaches users.

## Mutation testing (as a writer)

A mutant is the code with one small change (`<` → `<=`, a removed call, a flipped boolean). If a
test fails, the mutant is killed — some test checks that behaviour. If all tests pass, it survived:
nothing checks it. Coverage says "never ran"; mutation says "ran but nobody looked". You need both.

- Run it only when the project already has the tool or the user asked — never add it without
  asking; manual breaks are the default evidence. Then: **business logic at unit level, on the files you changed**. It costs one test run per
  mutant; integration tests rarely, E2E never.
- **Run the tool** (Stryker for JS/TS, JSON report). Do not reason about mutants in your head and
  report a score.
- For each survivor decide: a **test gap** (add the case that would have failed) or an
  **equivalent mutant** (behaviour cannot differ — e.g. `<=` vs `<` at a point where a continuous
  function has the same value on both sides; record it in the tool's ignore mechanism with a
  reason).
- A test written to kill a mutant must make sense **without knowing the mutation**. If it only
  asserts that some helper was called, it leaks implementation — rewrite it against behaviour or
  drop it.
- A 100% kill rate is not the goal; chasing the last equivalent mutant produces nonsense tests.
