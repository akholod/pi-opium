# What to test

## Contracts

A contract is the explicit agreement between a unit and its callers:

- **Preconditions** — what the caller must guarantee (a positive quantity, a logged-in user).
- **Postconditions** — what is true afterwards: the return value, the new state.
- **Side effects** — what else changed: a row written, a request sent, an event emitted, an audit
  log entry. A test that checks the return value and ignores the side effect checks half the
  contract.

If the contract is not pinned down by tests, every new change — by a person or an agent —
re-guesses it, and behaviour drifts.

## Invariants

Conditions that hold at all times, whatever sequence of operations ran: balance never negative,
shares sum to at most 100%, a transfer never changes the total, a list stays sorted, a finished
order always has a signature. They are rarely written down "because they are obvious", which is
exactly why nothing checks them. State them explicitly and assert them after sequences of
operations — or let a property-based test hunt for a violation
([techniques.md](techniques.md#property-based)).

## Where the expected value comes from

"It works" means "it matches somebody's expectation". Who decided where free shipping starts, and
whether the threshold itself is included? The expected value must come from that decision — ticket, spec, owner, bug report —
never from running the code and pasting its output. Tests generated after the code by the same
agent confirm that agent's own choices, including its mistakes.

Stop-words in a requirement: *valid*, *correct*, *properly*, *reasonable* — with no number attached
they are not checkable. Ask for the number.

## Priorities

1. **Production bugs.** A bug is a confirmed risk. Its test ships with the fix, not in the backlog.
   If you cannot write a test that fails on the bug, the root cause is not understood yet.
2. **Business rules.** High cost of failure, low visibility: a wrong discount does not crash
   anything, it just loses money.
3. **Boundaries.** End of one booking equals start of the next; zero duration; one second before
   midnight; exactly the limit. They almost never come up in manual checking, and agents skip them
   unless asked.
4. **Glue.** Pass-through code fails loudly on its own. But check that glue really is glue: a
   wrapper that also computes the charged amount is business logic in disguise.

On untested code, rank by **breaks often** (incident history), **changes often** (git history),
and **money or access**. See [legacy.md](legacy.md).

## Formatters and neighbours

For a formatter, assert the meaningful fragments (the name, the duration, the status appear) rather
than the exact string — the type system holds the shape, and a full-string assert breaks on every
cosmetic change. That is still asserting values: concrete fragments, not `length > 0`. Do not test a
neighbour's responsibility in a formatter's test ("an unavailable route shows 0 hours" belongs to
whatever computes the hours).

## Test depth follows the cost of failure

There is no universal ratio of test types or universal coverage number. A payment module earns
wide tests and high branch coverage; an internal admin screen earns a few. Prefer branch coverage
over line coverage when you read the number at all.

Skip unit tests for controllers with no logic. If a CI gate demands coverage there, the gate is
wrong, not the test plan. Extract logic out of components and hooks into plain functions or the
store, and test it there.

## Coverage is not verification

Line, branch and path coverage all count execution. A line that never ran is certainly unverified;
a line that ran may still be unverified, because nothing asserted on its effect. Coverage is a map
of where you have not looked, not proof of what you checked. Mutation testing measures the second
thing.

## The completeness test

Could someone rebuild the function from its tests alone? If two very different implementations
both pass, the tests leave a decision open — usually a boundary. Add the pair that tells them
apart.
