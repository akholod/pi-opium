# Test as spec: handing a task to an implementing agent

Prose leaves decisions open. Asked to "truncate text to the limit with an ellipsis", two
implementations disagree on whether the ellipsis counts toward the limit and on what happens to one
long word with no spaces. Concrete pairs close those forks before any code exists, and they are
acceptance criteria that do not depend on the agent's own tests.

This is not dogmatic test-first. What must come first is the **expected behaviour**, fixed by a
person or a spec. It can arrive as a test file, as `it.todo` lines with values, or as prose plus
"focus on these boundary cases". The implementation can be written before or after the test file is
typed out; the expectations cannot come from it.

## Three criteria for a good spec

1. **Concrete inputs and outputs.** `truncate('Hello world', 8) → 'Hello…'`, not "truncates long
   strings".
2. **Boundaries, with numbers.** Exactly the limit, limit + 1, empty, a single long word, a short
   string. Equal-to-threshold, zero, the day boundary, combinations of flags.
3. **No implementation detail in the assertions.** Not "the helper is called once", not an internal
   data structure — only results and observable side effects.

Limits: not everything is an input/output pair. Side effects (a row written, a request sent) are
stated as observable outcomes. The spec tests themselves must be trustworthy — review them before
handing them over.

One contract can feed several parallel tasks (frontend and backend). Fix it in a schema first and
make one coordinator responsible for changing it; two agents working from a prose description will
name the same field `totalCents` and `totalAmount`.

Strong tests let a cheaper model implement: plan with a strong model, implement with a cheap one,
judge by the tests.

## Prompt template

```text
Task: implement <function/endpoint> so that the tests in <file> pass.
Level: <unit | integration with the real test DB from <setup file> | E2E>.

Cases (input → expected):
- <input> → <output>
- boundary: <exactly the limit> → <output>
- error: <input> → throws <ErrorType> with message "<...>"
- concurrency: two <operations> at once → exactly one succeeds, <invariant>

Constraints:
- Do not change the tests. Do not change <function under test> (when writing tests for existing code).
- Do not open other test files  |  Use <file> as the example to follow.
- Consider: <one line of expert context — concurrent purchase, timezone, error flow, failure of the layer below>.
- Use the mutation tool (<command>); do not estimate mutants by reading the code.

At the end, list every decision you made on your own: limits, rounding, ordering, defaults,
error handling, anything the cases above did not determine.
```

Why each line:

- **Level stated** — agents copy the level of neighbouring tests.
- **"Do not change the function"** — weaker models bend the code to make a test convenient.
- **"Do not open other test files" or "use X as the example"** — bad neighbours get copied; a good
  one should be named.
- **One line of expert context** beats a page of generic rules. Put heavy, area-specific nuances
  (races, timezones) in the `AGENTS.md` or skill of that directory, not in the root instructions,
  where they make the agent over-test the impossible.
- **The decisions list** turns unspoken choices into reviewable ones. New boundaries that appear in
  the implementation (a size limit against zip bombs) get documented — an ADR or an issue — and a
  person owns them.

Prompting notes:

- State facts, not prohibitions: "mutant X survived in `applyDiscount`, add the test that kills it"
  works; "do not write weak tests" does not.
- Use precise terms: stub, mock, fake, spy, dummy. Spell out "Arrange, Act, Assert" for weaker
  models — the abbreviation alone can be read as something else.
- Avoid ambiguity: "do the same in the other tests" may be read as "in other files".
- The weaker the model, the more cases you list explicitly.
- Do not economise on the description of inputs; tokens go to reasoning, not to your prompt.
- When the requirement itself is unclear, run an interview step first (a requirements-interview
  skill, or questions back to the owner) rather than letting the agent guess.

## Isolate the sandbox

Agents read whatever is nearby: the README, logs of earlier runs, old attempts, a solution in a
sibling folder. When the spec must be the only source, hand it over in a clean directory (a fresh
`git init`, or the irrelevant files moved out) so the result reflects the spec, not a spoiler.

## Re-check after switching models

Test style follows the model's temperament. After changing the implementing or test-writing model,
read the first few tests it produces against these criteria before trusting the rest.

## The loop

1. A person fixes the behaviour for a small piece: tests, or pairs in words.
2. The agent implements.
3. The agent lists its own decisions; new boundaries are documented.
4. Mutation testing on that test/implementation pair, before the PR; the agent triages survivors
   and escalates what it cannot classify.
5. Review in two passes — that is the `review-tests` skill.

Reading the tests is worth roughly ten times more than reading the code: they stay behind as the
contract.
