# Reading mutation results

A mutant is the code with one small change: `<` → `<=`, `&&` → `||`, a removed call, a constant
changed, a block emptied. Tests fail → **killed**: some test checks that behaviour. Tests pass →
**survived**: nothing checks it. Coverage says "this never ran"; mutation says "this ran and nobody
looked". You need both: full coverage with a block of surviving mutants usually means a whole rule (a
seasonal surcharge, say) was executed but never asserted.

## Running it

- Run it only when the project already has the tool or the user asked; otherwise propose it in the
  report. Never add a dependency or config file without asking. Manual breaks are the default
  evidence.
- Setup, once agreed: `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` as
  devDependencies, and a minimal `stryker.config.json` (the `plugins` entry is required under pnpm):
  `{"testRunner":"vitest","plugins":["@stryker-mutator/vitest-runner"],"coverageAnalysis":"perTest","reporters":["json","clear-text"]}`.
  Stryker breaks on TypeScript 7 (`ts.parseConfigFileTextToJson is not a function`): pin
  `typescript@6` for the run, or set `"tsconfigFile"` to a path with no file.
- Mutate **business logic at unit level, in the changed files**, with the tests related to them.
  Cost is one test run per mutant: a ten-second suite and a hundred mutants is a quarter of an
  hour on one machine. Integration tests rarely; E2E never.
- Run the tool (Stryker for JS/TS, JSON report). Reasoning about mutants by reading code and
  reporting a score is not mutation testing.
- A score of 100% is a number, not a proof: check what was mutated (which files, which mutators) and
  that the run actually used the tests you think it did.

## Classifying each survivor

| Class | Meaning | Action |
| --- | --- | --- |
| **test gap** | behaviour changed and no test noticed | add the case that would have failed — from the requirement, not from the mutant |
| **equivalent** | the change cannot alter observable behaviour (e.g. `<` vs `<=` where a continuous function has the same value on both sides; `Math.max` with an operand that is never larger) | mark it in the tool's ignore mechanism with a one-line reason |
| **defensive code** | a guard for a state that cannot arise inside the system | decide: delete the guard, or accept the survivor with a reason |
| **unclear** | cannot tell | escalate to a person with the mutant, the line, and what you tried |

Give an agent the JSON report and ask exactly that: "for each survivor — test gap or equivalent?
Write tests for the gaps." Agents are good at this triage; it is what made the method practical.

## Reviewing tests written for mutants

- The new test must make sense **without knowing the mutation**. If the only reason a check exists
  is the mutant, it usually asserts that some helper was called — an implementation detail. Rewrite
  it against behaviour, or drop it.
- Do not try to kill an unkillable mutant; that produces nonsense tests.
- Phrase feedback as facts: "mutant `<=` on line 42 of `pricing.ts` survived; add a test that
  fails on it" narrows the agent's options far better than "write stronger tests".

## A test that kills nothing

A test that kills none of the mutants run against its code is a strong signal that it is useless.
Check what the test asserts before deleting it; then rewrite it or delete it.

## Mutation score as a gate

Count it **per merge request**, on the changed files. A starting bar of ~90% killed, then a hard
gate for critical modules, is workable. "Zero survivors" is harmful: it forces tests against
equivalent mutants. See [metrics.md](metrics.md).
