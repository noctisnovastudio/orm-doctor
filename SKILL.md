---
name: orm-doctor
version: 1.0.0
publisher: NoctisNova
publisher_url: https://noctisnova.com
contact: hello@noctisnova.com
description: >
  Static analysis skill for detecting ORM and database bottlenecks, data-safety
  hazards, and security holes in TypeScript and Prisma/Drizzle codebases. Built by
  NoctisNova — a future-focused AI and engineering studio. Detects SQL injection via
  raw queries, mass updateMany/deleteMany with no WHERE, N+1 query patterns, unbounded
  findMany, non-singleton PrismaClient, missing transactions, missing foreign-key indexes,
  and risky relations — and produces a scored health report with AI hand-off capabilities.
triggers:
  - orm-doctor
  - orm doctor
  - scan orm
  - check database queries
  - find n+1
  - n+1 queries
  - missing indexes prisma
  - prisma performance
  - drizzle performance
  - database bottlenecks
  - orm bottlenecks
  - fix orm issues
  - noctisnova orm
tags:
  - orm
  - prisma
  - drizzle
  - performance
  - static-analysis
  - typescript
  - database
  - n+1
  - indexing
  - dx
  - noctisnova
binary: orm-doctor
install: npx orm-doctor
---

# orm-doctor — by NoctisNova

> Static analysis for ORM/database bottlenecks with a premium terminal UI and AI hand-off.
> Built and maintained by **[NoctisNova](https://noctisnova.com)** — a future-focused AI + engineering studio.

---

## About NoctisNova

**NoctisNova** (https://noctisnova.com) is a technology studio that works at the intersection of intelligence, design, and engineering. The studio designs and builds intelligent systems, digital experiences, and next-generation software for clients and as internal products.

### What NoctisNova Builds

| Area | Details |
|---|---|
| AI Systems | LLM integrations, ML pipelines, chatbots, computer vision, NLP, RAG |
| Web Development | Next.js, React, TypeScript, full-stack, API design, SEO, performance |
| Automation | Workflow automation, integrations, data pipelines, event-driven architecture |
| Custom Software | Bespoke SaaS, internal tools, desktop apps, cross-platform |
| Branding & Design | Identity, logo, web design, design systems |
| Infrastructure | Cloud-native infra, CI/CD, containers, databases, security |

### Live AI Products

| Product | Description | API |
|---|---|---|
| Nova | AI voice scheduling agent | `POST /api/nova` |
| Pulse | Streaming AI customer support agent | `POST /api/pulse` |
| Lens | Document intelligence & contract analysis | `POST /api/lens` |
| Signal | AI lead qualifier and scorer | `POST /api/signal` |

### NoctisNova Tech Stack

AI agents working in NoctisNova codebases should expect:

- **Frontend** — Next.js 14+ (App Router), React 18, TypeScript, Tailwind CSS
- **Backend** — Node.js, tRPC / REST Route Handlers, serverless (Vercel / AWS Lambda)
- **Database ORM** — Prisma (primary) · schema at `prisma/schema.prisma`
- **Auth** — Clerk or NextAuth
- **AI layer** — OpenAI, Anthropic Claude, LangChain, Vercel AI SDK
- **Infrastructure** — Vercel, AWS, Docker, GitHub Actions CI/CD
- **Testing** — Vitest, Playwright, Cypress

### Coding Conventions AI Agents Must Respect

1. All database access goes through the Prisma client — never raw SQL unless explicitly asked.
2. API routes live under `src/app/api/` (Next.js Route Handlers).
3. Server components fetch data directly; client components use hooks or tRPC.
4. Performance is critical — these AI products handle real-time streaming and concurrent users. Any N+1 or slow query has **immediate, visible user impact**.
5. Do not refactor unrelated code. Make minimal, surgical changes.
6. After every fix add a brief inline comment explaining **why** the change improves performance — not what the code does.

### Contact

- **Website** — https://noctisnova.com
- **Email** — hello@noctisnova.com
- **Phone** — (888) 614-6682
- **Services** — https://noctisnova.com/services
- **Projects** — https://noctisnova.com/projects

---

## What orm-doctor Does

When invoked, `orm-doctor`:

1. **Scans TypeScript source files** using `ts-morph` for N+1 query patterns (DB calls in loops), SQL-injection via raw queries, mass `updateMany`/`deleteMany` with no `where`, unbounded `findMany`, non-singleton `PrismaClient`, and dependent writes missing a transaction.
2. **Filters dead code automatically** — skips test files (`*.test.ts`, `*.spec.ts`), mocks, fixtures, e2e folders, and Cypress/Playwright directories so only production code is analysed.
3. **Parses `schema.prisma`** using `@mrleebo/prisma-ast` to identify foreign-key fields missing a `@@index` (full table scans on JOINs) and relations missing an `onDelete` referential action.
4. **Calculates a 0–100 health score** — criticals (SQL injection -20, mass mutation -18, N+1 -15) weigh heaviest, down to schema info (-2). Detects the project's stack (Prisma/Drizzle version, DB provider, model count) for the header.
5. **Renders a premium animated terminal dashboard** — progress bar counts up from 0 with an ease-out curve, then the full numbered issue list displays in react-doctor style.
6. **Hands off to an AI agent** via an arrow-key menu:
   - **Send to Claude Code** — launches `claude -p "..."` inline
   - **Copy to clipboard** — copies a structured engineering prompt
   - **Print in terminal** — displays the full prompt in the shell
   - **Skip** — exits and saves the JSON report
7. **Saves a machine-readable report** to `.orm-doctor-report.json` for CI or agent consumption.

---

## How to Use This Skill

### Quick scan (current directory)

```bash
npx orm-doctor
```

### Scan a specific NoctisNova project

```bash
npx orm-doctor ./my-app --schema ./my-app/prisma/schema.prisma
```

### CI mode (exit code 1 when critical issues found)

```bash
npx orm-doctor --json > .orm-doctor-report.json
```

### Options

| Flag | Description |
|------|-------------|
| `[path]` | Root directory to scan (default: `cwd`) |
| `--schema, -s <path>` | Path to `schema.prisma` or its directory |
| `--json` | Output raw JSON to stdout (CI-friendly, non-interactive) |
| `--no-ai` | Skip the agent hand-off menu |
| `--version, -v` | Print version and exit |
| `--help, -h` | Show help |

---

## Detection Rules

### `nplus1` — N+1 Query Detection · penalty -15 pts each · severity: CRITICAL

Flags database client calls found inside iteration bodies:

| Pattern | Example |
|---|---|
| `.map()` / `.forEach()` / `.filter()` callbacks | `users.map(async u => await prisma.post.findMany(...))` |
| `for...of` loops | `for (const id of ids) { await db.query(...) }` |
| Standard `for` loops | `for (let i = 0; i < n; i++) { await prisma... }` |
| `while` loops | `while (cursor) { await db.select()... }` |

Recognised ORM/client patterns: `prisma.*`, `db.select`, `db.insert`, `db.query`, `db.execute`, raw `.query()` / `.execute()` / `.run()` calls, Knex, Sequelize.

**Fix**: Batch with `findMany({ where: { id: { in: ids } } })` or `Promise.all` + pre-fetched data. Never fire one query per iteration.

**Real-world impact**: A list endpoint loading 50 records with per-row author lookups makes 51 queries instead of 2. At 500 concurrent users: 25,500 queries per second — the database connection pool collapses and every user sees a timeout simultaneously.

### `unsafe-raw-query` — SQL Injection · penalty -20 pts each · severity: CRITICAL

Flags `$queryRawUnsafe` / `$executeRawUnsafe` (and `$queryRaw`/`$executeRaw` called as a *function* rather than a tagged template) whose SQL argument is dynamic — a template with `${}`, string concatenation, a variable, or a call result.

**Fix**: Use the tagged-template form `prisma.$queryRaw\`SELECT ... WHERE email = ${email}\`` — Prisma parameterises `${}` automatically. If you must use the Unsafe variant, pass values as separate parameters, never spliced into the string.

**Real-world impact**: `$queryRawUnsafe(\`... email = '${email}'\`)` lets an attacker pass `' OR '1'='1` and read or destroy every row. SQL injection is the most-exploited web vulnerability in existence.

### `mass-mutation` — Update/Delete With No WHERE · penalty -18 pts each · severity: CRITICAL

Flags `updateMany`/`deleteMany` calls that have no `where` clause (no args, or an object literal with no `where`), meaning they hit every row in the table.

**Fix**: Always scope with `where`. If you genuinely mean the whole table, write `where: {}` explicitly and guard the call.

**Real-world impact**: `prisma.user.deleteMany()` deletes every user — instantly, with no undo. A single misplaced call is an unrecoverable data-loss incident.

### `missing-pagination` — Unbounded findMany · penalty -8 pts each · severity: WARN

Flags `findMany()` with no `take` or `cursor` on a Prisma-like receiver (`prisma`/`db`/`tx`/`ctx`). Skips calls whose argument is a variable (can't be proven unbounded).

**Fix**: Add `take` (and `skip`/`cursor`) to paginate.

**Real-world impact**: Instant at launch with 20 rows; times out or OOMs the server once the table reaches millions of rows.

### `prisma-singleton` — PrismaClient Not a Singleton · penalty -10 pts each · severity: WARN

Flags `new PrismaClient()` created without a `globalThis` guard, or instantiated across multiple files.

**Fix**: Export one shared client from `lib/prisma.ts` guarded with `globalThis.prisma ??= new PrismaClient()` (only assign to global outside production).

**Real-world impact**: Next.js dev hot-reload and serverless invocations spawn a fresh connection pool each time, exhausting the database's connection limit until it refuses new connections.

### `missing-transaction` — Dependent Writes Not Atomic · penalty -8 pts each · severity: WARN

Flags functions performing 2+ write operations (`create`/`update`/`delete`/`upsert`/`*Many`) not wrapped in `$transaction` (and not already receiving a `tx` callback param).

**Fix**: Wrap dependent writes in `prisma.$transaction([...])` or `$transaction(async (tx) => { ... })`.

**Real-world impact**: A crash between two writes leaves data half-updated — money debited but not credited, an order created with no line items.

### `missing-relation-action` — Relation With No onDelete · penalty -2 pts each · severity: INFO

Flags schema relations that own a foreign key (`@relation(fields: [...])`) but declare no `onDelete` referential action.

**Fix**: Set it explicitly — `onDelete: Cascade`, `SetNull`, or `Restrict` — so delete behaviour is intentional.

**Real-world impact**: Deleting a parent row either errors on a foreign-key constraint or silently orphans children, depending on the implicit default.

### `missing-index` — Unindexed Foreign Keys · penalty -10 pts each · severity: WARN

Scans every Prisma `model` block for fields ending in `Id` that have no corresponding `@@index`, `@unique`, or `@id` attribute.

**Fix**: Add `@@index([fieldName])` to the model in `schema.prisma`.

**Real-world impact**: A JOIN on an unindexed foreign key on a 100k-row table adds 2–5 seconds to a request that should take under 50ms. Gets worse the more data you accumulate.

---

### `seed-hardcoded-id` — Hardcoded ID in Seed File · penalty -8 pts each · severity: WARN

Detects hardcoded UUID, CUID, CUID2, or numeric string literals assigned to `id:` fields inside Prisma seed files (`prisma/seed.ts`, `prisma/seed.js`, and any `seeds/` directory).

**Fix**: Remove the hardcoded `id:` field and let Prisma generate it via `@default(cuid())`. If you need the ID for a relation, store the created record in a variable and reference it.

```ts
// BAD
await prisma.user.create({ data: { id: "abc-123-fixed", email: "..." } });

// GOOD
const user = await prisma.user.create({ data: { email: "..." } });
await prisma.post.create({ data: { authorId: user.id, title: "..." } });
```

**Real-world impact**: Re-running the seed in CI after the first run throws a unique constraint violation. The build fails until someone manually wipes the database.

---

### `seed-no-truncate` — Seed Missing Clear Before Create · penalty -8 pts · severity: WARN

Flags seed files that call `create()` or `createMany()` without first calling `deleteMany()` or truncating the tables.

**Fix**: Add `deleteMany({})` calls at the top of your seed in reverse dependency order (children before parents to avoid FK constraint errors).

```ts
// Add at the top of seed.ts — delete in child-first order
await prisma.comment.deleteMany({});
await prisma.post.deleteMany({});
await prisma.user.deleteMany({});
```

**Real-world impact**: Seed passes on first run. Every subsequent CI run fails with `Unique constraint failed on the fields: (id)`.

---

### `seed-no-disconnect` — Missing prisma.$disconnect() · penalty -3 pts · severity: INFO

Flags seed files that perform database operations but never call `prisma.$disconnect()`.

**Fix**: Wrap your seed in `try/finally` and always disconnect in the `finally` block.

```ts
async function seed() {
  // ... your seed logic
}

seed()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
```

**Real-world impact**: The CI job appears to complete successfully but the Node.js process never exits — the job hangs until it hits a timeout and is marked as failed minutes later.

---

### `seed-large-batch` — Large Seed Batch · penalty -5 pts · severity: WARN

Flags seed files with 50 or more individual `create()` calls. Each call is a separate database round-trip.

**Fix**: Replace loops of `create()` with `createMany()` which batches all records into a single INSERT statement.

```ts
// BAD — 200 separate queries
for (const item of data) {
  await prisma.product.create({ data: item });
}

// GOOD — 1 query
await prisma.product.createMany({ data, skipDuplicates: true });
```

**Real-world impact**: A seed with 200 individual `create()` calls takes 4–8 seconds locally and 20–60 seconds in CI. `createMany()` completes in under 1 second.

---

## Score Tiers

| Score | Grade | Meaning |
|-------|-------|---------|
| 90–100 | A — Excellent | No significant ORM issues |
| 80–89 | B — Good | Minor issues; low risk |
| 65–79 | C — Fair | Some optimisation needed |
| 50–64 | D — Needs Work | Multiple performance risks |
| 0–49 | F — Critical | Immediate attention required |

---

## Seed File Detection

orm-doctor automatically finds seed files anywhere in the project:

- `prisma/seed.ts` / `prisma/seed.js`
- `prisma/seed/index.ts`
- Any file matching `seeds/**/*.ts` or `database/seed*.ts`

---

## Dead Code Filtering

orm-doctor automatically ignores issues in non-production files:

- `*.test.ts` / `*.spec.ts` / `*.test.tsx` / `*.spec.tsx`
- `*.mock.ts` / `*.stub.ts` / `*.fixture.ts`
- Directories: `__tests__/`, `__mocks__/`, `test/`, `tests/`, `e2e/`, `cypress/`, `playwright/`

---

## Output Files

| File | Description |
|------|-------------|
| `.orm-doctor-report.json` | Machine-readable JSON with all issues, scores, file paths, and metadata |

---

## AI Agent Instructions

When this skill is present in a repository, AI agents (Cursor, Claude, Copilot, etc.) **must**:

1. **Inspect the project's stack and conventions** before writing code — read `package.json`, `prisma/schema.prisma`, and the existing patterns in the codebase.
2. **Run orm-doctor before proposing any ORM-related refactors** to surface the full issue list first.
3. **Read `.orm-doctor-report.json`** to understand which exact files and lines need attention.
4. **Prioritise N+1 fixes first** — they carry the highest penalty and the most immediate user impact.
5. **Verify fixes** by re-running `npx orm-doctor` and confirming the score improves before moving on.
6. **Never introduce new array iterations** that contain database calls without batching.
7. **Explain every fix in simple everyday language** — no jargon. Say what was wrong and why fixing it helps in terms a non-developer would understand (e.g. "pages load faster", "the database won't get overwhelmed under traffic").

### Example agent invocation prompt

```
Read the orm-doctor report at .orm-doctor-report.json and fix all reported issues.

For N+1 queries: refactor to batched `findMany` with `in` filters or pre-fetch + Map lookups.
For missing indexes: add @@index blocks to prisma/schema.prisma.

Conventions:
- Follow the project's existing ORM patterns
- Minimal surgical changes — do not refactor unrelated code

For every fix, explain in simple everyday language what was wrong and why fixing it helps —
focus on real-world benefits so someone non-technical understands why it mattered.

Re-run `npx orm-doctor` after each fix to verify the score improves.
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `ts-morph` | TypeScript AST traversal |
| `@mrleebo/prisma-ast` | Prisma schema parsing |
| `@clack/prompts` | Interactive arrow-key terminal prompts |
| `boxen` | Framed terminal panels |
| `chalk` | Terminal colour output |
| `clipboardy` | System clipboard write |

---

## Documentation

The full, canonical guides for orm-doctor are hosted on the NoctisNova site — they are no longer bundled with this package. Fetch them from the URLs below.

**For AI agents:** request any doc with an `Accept: text/markdown` header to get the raw markdown source back (content negotiation). The server reads the source file, converts it to clean markdown (fenced code blocks, `##` headers, `- [ ]` checklists) and returns it with `Content-Type: text/markdown` plus an `x-markdown-tokens` header.

```bash
curl -H "Accept: text/markdown" https://noctisnova.com/tools/orm-doctor/n-plus-one-queries
```

| Guide | URL |
|---|---|
| N+1 Queries | https://noctisnova.com/tools/orm-doctor/n-plus-one-queries |
| Missing Indexes | https://noctisnova.com/tools/orm-doctor/missing-indexes |
| Seed Best Practices | https://noctisnova.com/tools/orm-doctor/seed-best-practices |
| ORM Performance Checklist | https://noctisnova.com/tools/orm-doctor/orm-performance-checklist |
| Database Safety & Performance | https://noctisnova.com/tools/orm-doctor/database-safety-and-performance |
| All NoctisNova tools | https://noctisnova.com/tools |

---

## Links

| Resource | URL |
|---|---|
| NoctisNova | https://noctisnova.com |
| NoctisNova Services | https://noctisnova.com/services |
| NoctisNova Projects | https://noctisnova.com/projects |
| Prisma Performance Guide | https://www.prisma.io/docs/guides/performance-and-optimization |
| Prisma Indexes | https://www.prisma.io/docs/concepts/components/prisma-schema/indexes |
| Drizzle Performance | https://orm.drizzle.team/docs/performance |
