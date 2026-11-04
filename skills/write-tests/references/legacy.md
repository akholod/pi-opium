# Legacy: code with no tests

The order is fixed. Each step makes the next one safe; swapping them breaks that.

**prioritise → pin → split pure from impure → real tests (+ mutation) → change behaviour**

A plan of "find critical modules → refactor → add pinning tests" is wrong: even a harmless-looking
refactor changes behaviour, and without a net nobody notices.

## 1. Prioritise

Do not cover the whole project. Rank modules by three signals:

- **breaks often** — incident history, recent bug tickets;
- **changes often** — commit frequency over the last year (`git log --since=1.year --format= --name-only | grep . | sort | uniq -c | sort -rn | head -20`);
- **money or access** — payments, refunds, permissions.

An agent ranks well when given the incident list and change frequency; without them it guesses from
names. Boy-scout rule: put the net where you are about to work, not everywhere.

*Done when* you have 2–3 modules and the reason for each.

## 2. Pin current behaviour

A pinning (characterisation) test asks "did it behave like this before?", not "is this right?".
Here — and only here — expected values come from running the code.

- Choose inputs that exercise real use: the most frequent production inputs, a sanitised data dump,
  every branch you can find (both sides of a half-finished migration flag).
- Record current outputs as expected values. Snapshots are an acceptable mechanism here because the
  tests are temporary, but think about which outputs matter.
- **Keep odd behaviour as it is.** Agents read names and comments, decide that strange behaviour is a
  bug, and quietly "fix" the expectation. That destroys the net. Use the word *pinning* in the
  prompt, require current behaviour to be recorded, and mark suspected bugs with a comment
  (`// pinned: archived accounts can still be charged — suspected bug, reported separately`) instead of changing
  the expectation.
- Leave the function unchanged.
- Remove narrative comments that restate the code; keep only the *why*.

When a pinning test fails later, the question is "was this change intended?", not "update the test".

## 3. Split pure from impure

The highest-leverage refactor: extract the decision into a pure function
(`decideEligibility(input)`) and leave I/O in a thin shell (`checkEligibility` loads data, calls
it, writes the result). Pure parts get unit tests; the shell gets an integration test.
Turn one knob at a time and keep the pinning tests green after each step.

## 4. Real tests

Now write tests from requirements — where requirements exist — against the pure core, run mutation
testing on it, and integration tests on the shell. Pinning tests that are now duplicated by real
tests are deleted; "temporary" pinning tests that live for years are a smell.

## 5. Then change behaviour

New rules go in after the net exists. Expect old fixtures to need new fields; that is the new rule
clarifying incomplete data, not a regression.

## Notes

- Do not write speculative architecture docs for legacy code: a wrong specification is worse than
  none, and the code is the source of truth until it is refactored.
- Two progress tables behind a migration flag, or two similar code paths: pin both before touching
  either.
