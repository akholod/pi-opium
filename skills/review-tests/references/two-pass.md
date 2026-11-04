# The two-pass review

A review looks at what is there. The most important question is what is not there — and neither
grep nor mutation testing can find an absent test. So the review splits:

| Pass | Question | Who | Why |
| --- | --- | --- | --- |
| 1 | Are the existing tests any good? | an agent — preferably a different model, clean session | mechanical: can each test fail, does it assert outcome rather than calls, do mutants survive |
| 2 | What tests are missing? | a person owns it; an agent may draft candidates | judgement about the domain: which combinations, boundaries and actors matter |

"Check whether these tests are good" is wishful thinking. In the same session the reviewer says all
is well; in a fresh session it always finds something new. Give the reviewer checkable criteria —
inputs, outputs, acceptance criteria — not a request for an opinion.

## Pass 1 prompt (for a fresh session or another model)

```text
Review the tests in <files/diff> for <module>. The expected behaviour is defined in <ticket/spec>.
For each test: does the name match what expect() checks? Could the assertion fail if the code were
wrong? Is any expected value taken from a stub or recomputed with production logic? Is a call
asserted where the outcome could be? Is anything inside the slice under test mocked? How is state
reset between tests?
Run <mutation command> on <changed source files> and list surviving mutants as test gap or
equivalent, with a reason for each. Do not estimate mutants; run the tool.
Report findings as: file, test, problem, evidence, fix. Do not commit changes to the code under
test; temporary breaks must be reverted.
```

## Pass 2: what is missing

About five minutes of a person's attention, guided by this list. An agent running this skill drafts
candidates under each heading and hands them over; it does not decide which matter.

- **Combinations.** Filters, flags, roles applied together, not one at a time.
- **Boundaries with numbers.** Equal to the threshold, zero, empty, one more than the limit, one
  second before midnight, day/month change, leap day.
- **Concurrency.** Two requests for the last item; double submission; a retry arriving after success.
- **Time, timezone, locale.** Behaviour across a DST change, in another locale, with a slow clock.
- **Error and exception flows.** The planned rejection; the layer below failing (DB down, timeout,
  partial write).
- **Other actors and delayed events.** An admin approves, a webhook arrives later, a scheduled job
  runs, an email link is used twice.
- **Invariants after sequences.** Balance never negative after any order of operations; totals
  preserved by transfers.
- **The production bug list.** Every past incident in this area has a test.
- **The rebuild test.** Could someone reconstruct the function from its tests alone? Where two
  different implementations would both pass, a decision is untested.

Asynchronous and out-of-band scenarios are the ones models forget most. Generating the list is a
separate step ("describe the asynchronous scenarios of <area>") whose output a person reviews.

## What a review report contains

1. Verdict in one line.
2. Findings by severity, each with file, test, problem, evidence (the mutant or manual break that
   survived), fix.
3. Pass-2 candidates, labelled **for the human to confirm**.
4. What was not checked and why (no mutation tool, could not run the DB).

A spotless report on a large PR is itself a signal: look again at combinations and boundaries.
