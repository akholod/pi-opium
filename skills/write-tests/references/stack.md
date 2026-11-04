# Stack: detect first, default second

The project's own tools win. The defaults below are what to reach for when a project has nothing,
or when the user asks for a recommendation — not a reason to add a second runner next to an
existing one.

Commands below use `<pm> exec` — substitute the project's package manager (`pnpm exec`,
`npm exec`, `yarn`, `bunx`), as named by its lockfile.

## 1. Detect

1. `package.json` → `scripts.test*`, `devDependencies`. The lockfile names the package manager
   (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`); use it to run things.
2. Config files: `vitest.config.*` / `vite.config.*` (a `test` key), `vitest.workspace.*`,
   `jest.config.*`, `rstest.config.*`, `playwright.config.*`, `cypress.config.*`,
   `stryker.conf.*` / `stryker.config.*`.
3. Setup files referenced from that config (`setupFiles`, `globalSetup`) — they tell you how the
   project fakes the network, time and the database.
4. Where tests live and how they are named (`*.test.ts` next to code, a `tests/` folder,
   `*.unit.ts` / `*.int.ts` suffixes). Follow the convention.
5. One or two existing tests, read for **conventions** (imports, helpers, naming). Do not copy
   their **level** without deciding it yourself: an old unit test with a mocked DB is a bad model for
   a rule that the DB enforces.

*Done when* you can run a single test file with the project's command and see it pass.

Other languages: the same principles hold; map them onto that ecosystem's runner, HTTP-mock, DB
container and mutation tools rather than importing JS tools.

## 2. Defaults when nothing exists

| Need | Default | Why this one |
| --- | --- | --- |
| Runner | **Vitest** (on Vite projects; Rstest on Rspack) | reuses the app's build config — Jest next to another bundler means two builds that drift |
| Component tests | **Vitest Browser Mode** (Playwright provider) with its built-in locators (`page.getByRole`, `getByText`, `getByLabelText`) and `vitest-browser-react` / `vitest-browser-vue` to render | a real browser applies CSS, so visibility is asserted truthfully; JSDOM cannot. Keep Testing Library's *approach* (query as a user would), avoid JSDOM where you can |
| Network, frontend / full-stack | **MSW** | one interception point on client and server, independent of `fetch` vs `axios`; can fail on unhandled requests |
| Network, backend service | inject the HTTP client the service already receives and pass a fake; MSW when the code calls bare `fetch` | the dependency is already a parameter — use it |
| Database | **Testcontainers** + Postgres, the project's ORM (e.g. Drizzle) | a real DB keeps unique indexes, constraints, transactions and locks |
| Property-based | **fast-check** | generators plus shrinking to a minimal counterexample |
| Mutation | **Stryker** with the Vitest runner | measures whether tests notice a change, not whether lines ran |
| E2E | **Playwright** | role/text locators, traces, auto-waiting |
| Accessibility | **axe** (in component or E2E tests) | agents write decent a11y checks when the tooling is there |

Vue, Svelte, Angular and others work the same way: their render helper, the same MSW, the same
Browser Mode. In Vue, stubbing a child component is built into the mount API; the rules for *when*
to stub one are the same (SKILL.md, "Decisions").

## 3. Short examples

**Vitest + MSW (fail on anything unhandled):**

```ts
// mocks/node.ts
import { setupServer } from 'msw/node';
export const server = setupServer();
```

```ts
// test/setup.ts — listed in `setupFiles`
import { beforeAll, afterEach, afterAll } from 'vitest'; // omit if `globals: true`
import { server } from '../mocks/node';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

MSW 2.x names this option `onUnhandledRequest`; 3.x renamed it to `onUnhandledFrame`.

```ts
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/node';

server.use(
  http.post('https://api.example.test/orders', async ({ request }) => {
    sent.push(await request.json());          // assert later what was sent
    return HttpResponse.json({ id: 'o-1', status: 'confirmed' });
  }),
);
```

**Fixed time, timezone and locale:**

```ts
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-01T21:59:59Z'));
});
afterEach(() => vi.useRealTimers());
```

- **Timezone:** `TZ` works from the config's `test.env` or from global setup (`process.env.TZ = 'UTC'`).
- **Locale:** setting `LANG` from config does **not** change the `Intl` default locale — it is fixed
  when the process starts. Set it before Node starts (`"test": "LANG=en-US TZ=UTC vitest"` in the
  script), or pass an explicit locale to `Intl.*` / `toLocale*()` in the code under test.

**Testcontainers through Vitest `provide`/`inject`:** global setup starts the container and runs
migrations — infrastructure only — and passes a *serialisable* connection string to workers.

```ts
// test/global-setup.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { TestProject } from 'vitest/node';

export default async function setup({ provide }: TestProject) {
  const pg = await new PostgreSqlContainer('postgres:17').start();
  const db = drizzle(pg.getConnectionUri());
  await migrate(db, { migrationsFolder: './drizzle' });
  await db.$client.end();
  provide('dbUrl', pg.getConnectionUri());
  return () => pg.stop();
}

declare module 'vitest' {
  export interface ProvidedContext { dbUrl: string }
}
```

```ts
// test/db.ts — worker side
import { inject } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
export const committedDb = drizzle({ connection: { connectionString: inject('dbUrl'), max: 4 } });
```

Per test, wrap work in a transaction that is rolled back (see
[doubles-and-isolation.md](doubles-and-isolation.md#database-isolation)).

**Browser Mode (Vitest 4+; `@vitest/browser/context` is the deprecated import):**

```ts
// vitest.config.ts → test.browser
import { playwright } from '@vitest/browser-playwright';
// browser: { enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }] }
```

```tsx
import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

test('shows the active session badge', async () => {
  await render(<SessionWidget minutes={10} />); // vitest-browser-react 2.x: render returns a Promise

  await expect.element(page.getByRole('status', { name: 'Session active' })).toBeVisible();
});
```

**Locators, in order of preference:** visible text or label → ARIA role with name → test id as a
last resort. A test that breaks when the visible text changes is telling the truth: the user saw a
change.

**Random order:** `<pm> exec vitest --sequence.shuffle`; on a failure, replay with the printed seed:
`--sequence.shuffle --sequence.seed=<n>`.

**Stryker setup.** If the project has no Stryker, do not install it without asking — propose it in
the report. Once agreed: `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` as
devDependencies, and a minimal
`stryker.config.json` — the explicit `plugins` entry is needed under pnpm, which does not hoist the
runner where Stryker looks for it:

```json
{
  "testRunner": "vitest",
  "plugins": ["@stryker-mutator/vitest-runner"],
  "coverageAnalysis": "perTest",
  "reporters": ["json", "clear-text"]
}
```

Stryker breaks on TypeScript 7 (`ts.parseConfigFileTextToJson is not a function`): pin
`typescript@6` for the Stryker run, or set `"tsconfigFile"` to a path with no file so Stryker skips
its tsconfig rewrite (any real tsconfig still goes through the missing API).

**Stryker on changed files only.** `--mutate` replaces the default globs, so exclude colocated
tests explicitly; the JSON reporter is not on by default:

```bash
<pm> exec stryker run --mutate "src/pricing/**/*.ts,!src/pricing/**/*.test.ts" --reporters json,clear-text
# → reports/mutation/mutation.json, ready for survivor triage
```
