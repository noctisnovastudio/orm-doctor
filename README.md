# orm-doctor

Static analysis CLI for **ORM and database bottlenecks** in TypeScript and Prisma/Drizzle codebases.

Built by [NoctisNova](https://noctisnova.com).

## Install & run

No install required:

```bash
npx orm-doctor
npx orm-doctor ./my-app
npx orm-doctor --json
npx orm-doctor --no-ai
```

Global install (optional):

```bash
npm install -g orm-doctor
orm-doctor
```

## What it detects

- **N+1 queries** — DB calls inside loops
- **Missing indexes** — foreign keys without `@@index` in Prisma schema
- **Unsafe raw SQL** — `$queryRawUnsafe` / dynamic raw queries
- **Mass mutations** — `updateMany` / `deleteMany` without `where`
- **Unbounded queries** — `findMany()` without `take` or cursor
- **Prisma singleton** — multiple `new PrismaClient()` instances
- **Missing transactions** — multiple writes without `$transaction`
- **Risky relations** — missing `onDelete` referential actions
- **Seed issues** — slow seeds, hardcoded IDs, missing truncate

Produces a scored health report (0–100) and saves `.orm-doctor-report.json` for AI-assisted fixes.

## Requirements

- Node.js **18+**

## Links

- **Homepage:** https://noctisnova.com
- **Repository:** https://github.com/NoctisNovaStudio/orm-doctor
- **Issues:** https://github.com/NoctisNovaStudio/orm-doctor/issues

## License

MIT
