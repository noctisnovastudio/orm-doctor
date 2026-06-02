/**
 * ui.js
 * Terminal UI components for orm-doctor.
 * Produces a react-doctor-style numbered issue list with severity badges,
 * plain-language explanations, canonical fix links, and truncated file lists.
 */

import boxen from "boxen";
import chalk from "chalk";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORT_FILE = "./.orm-doctor-report.json";
const BAR_WIDTH = 30;
const MAX_FILES_SHOWN = 3;

// ---------------------------------------------------------------------------
// Rule metadata catalogue
// ---------------------------------------------------------------------------
// Each entry drives the formatted output for one rule: its severity badge,
// display category, human label, plain-language explanation, real-world
// impact sentence, and canonical docs link.

const RULE_META = {
  "nplus1": {
    badge: "CRIT",
    badgeFn: (s) => chalk.bgRed.white.bold(` ${s} `),
    category: "Performance",
    label: "N+1 Query",
    penalty: 15,
    explanation:
      "Each iteration fires a separate database query, so 100 items means 100 round-trips to your database. " +
      "Under real traffic this makes endpoints 10–100× slower and can exhaust your connection pool entirely, " +
      "causing cascading timeouts for every user at once.",
    realWorld:
      'A list page that loads 50 posts and fetches each author in a loop makes 51 queries instead of 2. ' +
      'At 500 concurrent users that becomes 25,500 queries per second — the database collapses.',
    severity: "critical",
    docs: "https://www.prisma.io/docs/guides/performance-and-optimization/query-optimization-performance",
  },
  "unsafe-raw-query": {
    badge: "CRIT",
    badgeFn: (s) => chalk.bgRed.white.bold(` ${s} `),
    category: "Security",
    label: "SQL Injection via Raw Query",
    penalty: 20,
    explanation:
      "A raw SQL query is built from a dynamic string ($queryRawUnsafe / $executeRawUnsafe, or $queryRaw " +
      "called as a function). Any user-controlled value spliced into that string can execute arbitrary SQL — " +
      "read every table, drop data, or bypass auth entirely.",
    realWorld:
      "`$queryRawUnsafe(`SELECT * FROM users WHERE email = '${email}'`)` lets an attacker pass " +
      "`' OR '1'='1` and dump your whole users table. This is the #1 most-exploited web vulnerability.",
    severity: "critical",
    docs: "https://noctisnova.com/docs/orm/raw-query-safety",
  },

  "mass-mutation": {
    badge: "CRIT",
    badgeFn: (s) => chalk.bgRed.white.bold(` ${s} `),
    category: "Data Safety",
    label: "Mass Update/Delete With No WHERE",
    penalty: 18,
    explanation:
      "An `updateMany` or `deleteMany` call has no `where` clause, so it affects EVERY row in the table. " +
      "One stray call — or one bug that reaches it — wipes or rewrites all your production data instantly.",
    realWorld:
      "`prisma.user.deleteMany()` with no where deletes every user in the database. There's no undo. " +
      "This has ended companies — a missing where on a delete is a data-loss incident waiting to happen.",
    severity: "critical",
    docs: "https://noctisnova.com/docs/orm/mass-mutations",
  },

  "missing-pagination": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Performance",
    label: "Unbounded Query (No Pagination)",
    penalty: 8,
    explanation:
      "A `findMany()` call has no `take` or `cursor`, so it loads the entire table into memory every time. " +
      "It works fine in development with a few rows and falls over in production once the table grows.",
    realWorld:
      "A dashboard that does `findMany()` on an `events` table is instant at launch and times out (or OOMs " +
      "the server) a year later when that table has 5 million rows. Pagination would have kept it at 20ms.",
    severity: "warning",
    docs: "https://noctisnova.com/docs/orm/pagination",
  },

  "prisma-singleton": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Connections",
    label: "PrismaClient Not a Singleton",
    penalty: 10,
    explanation:
      "`new PrismaClient()` is created without a global guard (or in several files). Each instance opens its " +
      "own connection pool. In Next.js hot-reload and serverless this spawns pools faster than the database " +
      "can close them, until new connections are refused.",
    realWorld:
      "In Next.js dev, every file save creates another PrismaClient — after a few minutes you hit " +
      "'too many connections' and the whole app stops talking to the database until you restart.",
    severity: "warning",
    docs: "https://noctisnova.com/docs/orm/prisma-singleton",
  },

  "missing-transaction": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Data Safety",
    label: "Dependent Writes Without a Transaction",
    penalty: 8,
    explanation:
      "A function performs multiple write operations that aren't wrapped in a transaction. If the process " +
      "fails partway through, the database is left in a half-updated, inconsistent state with no rollback.",
    realWorld:
      "A transfer that debits one account then credits another: if the server crashes between the two writes, " +
      "money vanishes. A transaction guarantees both happen or neither does.",
    severity: "warning",
    docs: "https://noctisnova.com/docs/orm/transactions",
  },

  "missing-relation-action": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Schema",
    label: "Relation Missing onDelete Action",
    penalty: 2,
    explanation:
      "A schema relation defines no `onDelete` referential action, so Prisma applies a default that may not " +
      "match your intent — deleting a parent can unexpectedly fail, or silently orphan child rows.",
    realWorld:
      "Deleting a User whose Posts have no onDelete either errors out ('foreign key constraint') or leaves " +
      "orphaned Posts pointing at a user that no longer exists. Setting it explicitly removes the surprise.",
    severity: "info",
    docs: "https://noctisnova.com/docs/orm/referential-actions",
  },

  "missing-index": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Schema",
    label: "Missing Index on Foreign Key",
    penalty: 10,
    explanation:
      "Without an index the database engine reads every single row in the table to find matches. " +
      "On a table with tens of thousands of rows a query that should take under 5ms takes several seconds — " +
      "users see a spinning loader or a gateway timeout.",
    realWorld:
      "A JOIN on an unindexed foreign key on a 100k-row table adds 2–5 seconds to a request that " +
      "should return in under 50ms. It gets worse the more data you accumulate.",
    severity: "warning",
    docs: "https://www.prisma.io/docs/concepts/components/prisma-schema/indexes",
  },

  "seed-hardcoded-id": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Seed",
    label: "Hardcoded ID in Seed File",
    penalty: 8,
    explanation:
      "Hardcoded UUID or CUID literals assigned to id fields in seed files will conflict when the " +
      "seed is re-run (the ID already exists) and break across environments where IDs are expected " +
      "to be auto-generated.",
    realWorld:
      "Re-running a seed in CI after the first run throws a unique constraint violation and fails " +
      "the build. Copying the seed to a new environment creates silent data conflicts.",
    severity: "warning",
    docs: "https://noctisnova.com/docs/orm/seed-best-practices",
  },

  "seed-no-truncate": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Seed",
    label: "Seed Missing Data Clear Before Create",
    penalty: 8,
    explanation:
      "The seed file creates records without first deleting existing data. Running the seed more " +
      "than once — standard practice in CI pipelines — throws duplicate key errors and fails the " +
      "entire pipeline.",
    realWorld:
      "Your CI suite passes on the first run after a fresh database, then fails every subsequent " +
      "run with 'Unique constraint failed' until someone manually wipes the database.",
    severity: "warning",
    docs: "https://noctisnova.com/docs/orm/seed-best-practices",
  },

  "seed-no-disconnect": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Seed",
    label: "Missing prisma.$disconnect() in Seed",
    penalty: 3,
    explanation:
      "The seed file does not call prisma.$disconnect() after completing. The Node.js process " +
      "stays alive waiting for the connection pool to close, hanging the CI job until it times out.",
    realWorld:
      "CI jobs appear to complete (seed ran successfully) but the process never exits — the job " +
      "hits a timeout minutes later and is marked as failed.",
    severity: "info",
    docs: "https://noctisnova.com/docs/orm/seed-best-practices",
  },

  "seed-large-batch": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Seed",
    label: "Large Seed Batch — CI Timeout Risk",
    penalty: 5,
    explanation:
      "The seed file contains a high number of individual create() calls. Each call is a separate " +
      "database round-trip. With 50+ calls this routinely exceeds the 30-second CI timeout limit " +
      "and adds significant local setup time.",
    realWorld:
      "A seed with 200 individual create() calls takes 4–8 seconds locally and 20–60 seconds in " +
      "CI depending on DB latency. Batching into createMany() cuts that to under 1 second.",
    severity: "warning",
    docs: "https://noctisnova.com/docs/orm/seed-best-practices",
  },
};

/**
 * Canonical display + agent ordering — criticals first, then perf, then schema/seed.
 */
const RULE_ORDER = [
  "unsafe-raw-query",
  "mass-mutation",
  "nplus1",
  "missing-pagination",
  "missing-transaction",
  "prisma-singleton",
  "missing-index",
  "missing-relation-action",
  "seed-hardcoded-id",
  "seed-no-truncate",
  "seed-no-disconnect",
  "seed-large-batch",
];

// ---------------------------------------------------------------------------
// Stack detection line (report header)
// ---------------------------------------------------------------------------

/**
 * Renders the detected-stack summary line shown under the score.
 * @param {{labels:string[], provider:string|null, modelCount:number}} stack
 */
export function renderStackLine(stack) {
  if (!stack) return "";
  const parts = [];
  if (stack.labels?.length) {
    parts.push(chalk.dim("  Detected: ") + stack.labels.map((l) => chalk.magenta(l)).join(chalk.dim(" · ")));
  }
  const schemaBits = [];
  if (stack.provider)   schemaBits.push(chalk.cyan(stack.provider));
  if (stack.modelCount) schemaBits.push(chalk.white(`${stack.modelCount}`) + chalk.dim(" models"));
  if (schemaBits.length) parts.push(chalk.dim("  Schema: ") + schemaBits.join(chalk.dim("  ·  ")));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

/**
 * Renders a fixed-width block progress bar coloured by score tier.
 *
 * @param {number} score  0 – 100
 * @returns {string}
 */
export function renderProgressBar(score) {
  const clamped = Math.min(100, Math.max(0, score));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  if (clamped >= 80) return chalk.green(bar);
  if (clamped >= 50) return chalk.yellow(bar);
  return chalk.red(bar);
}

// ---------------------------------------------------------------------------
// Score badge
// ---------------------------------------------------------------------------

/**
 * Returns a coloured score string with a letter grade label.
 *
 * @param {number} score
 * @returns {string}
 */
export function renderScoreBadge(score) {
  const clamped = Math.min(100, Math.max(0, score));

  let grade, colourFn;
  if (clamped >= 90) { grade = "A · Excellent"; colourFn = chalk.green.bold; }
  else if (clamped >= 80) { grade = "B · Good"; colourFn = chalk.green; }
  else if (clamped >= 65) { grade = "C · Fair"; colourFn = chalk.yellow.bold; }
  else if (clamped >= 50) { grade = "D · Needs Work"; colourFn = chalk.yellow; }
  else                    { grade = "F · Critical"; colourFn = chalk.red.bold; }

  return colourFn(`${clamped}/100  ${grade}`);
}

// ---------------------------------------------------------------------------
// Score header box
// ---------------------------------------------------------------------------

/**
 * Renders the compact score summary box shown before the issue list.
 *
 * @param {object} params
 * @param {number} params.score
 * @param {number} params.totalPenalty
 * @param {number} params.issueCount
 * @param {string} params.projectPath
 * @returns {string}
 */
export function renderScoreBox({ score, totalPenalty, issueCount, projectPath }) {
  const bar = renderProgressBar(score);
  const badge = renderScoreBadge(score);

  const content = [
    chalk.bold.white("orm-doctor") + chalk.dim("  v1.0.0"),
    chalk.dim(path.resolve(projectPath)),
    "",
    `${bar}  ${badge}`,
    chalk.dim(`${issueCount} issue${issueCount !== 1 ? "s" : ""}  ·  penalty -${totalPenalty}pts`),
  ].join("\n");

  return boxen(content, {
    padding: { top: 0, bottom: 0, left: 2, right: 2 },
    margin: { top: 1, bottom: 0 },
    borderStyle: "round",
    borderColor: score >= 80 ? "green" : score >= 50 ? "yellow" : "red",
  });
}

// ---------------------------------------------------------------------------
// Numbered issue list  (react-doctor style)
// ---------------------------------------------------------------------------

/**
 * Formats all issues into a numbered, grouped, plain-language list.
 * Groups by rule, shows severity badge, count, explanation, docs link,
 * and a truncated file list.
 *
 * @param {object[]} issues
 * @param {object}   [opts]
 * @param {boolean}  [opts.colour=true]  Set false for plain-text agent prompts.
 * @returns {string}
 */
export function renderIssueList(issues, { colour = true } = {}) {
  if (issues.length === 0) {
    return colour
      ? chalk.green("\n  ✓  No issues detected — your ORM usage looks clean!\n")
      : "\n  No issues detected — your ORM usage looks clean!\n";
  }

  const grouped = groupByRule(issues);
  const orderedGroups = [
    ...RULE_ORDER.filter((r) => grouped[r]),
    ...Object.keys(grouped).filter((r) => !RULE_ORDER.includes(r)),
  ];

  const lines = [""];
  let idx = 1;

  for (const rule of orderedGroups) {
    const ruleIssues = grouped[rule];
    const meta = RULE_META[rule] ?? {
      badge: "INFO",
      badgeFn: (s) => `[${s}]`,
      category: "General",
      label: rule,
      explanation: "",
      realWorld: "",
      severity: "info",
      docs: "https://github.com/orm-doctor/orm-doctor",
    };

    const count = ruleIssues.length;
    const badgeStr = colour ? meta.badgeFn(meta.badge) : `[${meta.badge}]`;
    const categoryStr = colour ? chalk.bold(`${meta.category}: ${meta.label}`) : `${meta.category}: ${meta.label}`;
    const countStr = colour ? chalk.dim(`(×${count})`) : `(×${count})`;

    // ── Heading line ────────────────────────────────────────────────────────
    lines.push(`${idx}. ${badgeStr} ${categoryStr} ${countStr}`);

    // ── Plain-language explanation ───────────────────────────────────────────
    if (meta.explanation) {
      lines.push(`   ${colour ? chalk.white(meta.explanation) : meta.explanation}`);
    }

    // ── Real-world impact ────────────────────────────────────────────────────
    if (meta.realWorld) {
      lines.push(`   ${colour ? chalk.dim(meta.realWorld) : meta.realWorld}`);
    }

    // ── Canonical docs link ──────────────────────────────────────────────────
    const fixLabel = colour ? chalk.dim("   Read the canonical fix before touching the code:") : "   Read the canonical fix before touching the code:";
    const fixLink = colour ? chalk.cyan(` ${meta.docs}`) : ` ${meta.docs}`;
    lines.push(`${fixLabel}${fixLink}`);

    // ── File list ────────────────────────────────────────────────────────────
    const shown = ruleIssues.slice(0, MAX_FILES_SHOWN);
    const overflow = ruleIssues.length - shown.length;

    for (const issue of shown) {
      const loc = `${issue.file}:${issue.line}`;
      lines.push(colour ? `   ${chalk.dim("-")} ${chalk.cyan(loc)}` : `   - ${loc}`);
    }

    if (overflow > 0) {
      const more = `   +${overflow} more file${overflow !== 1 ? "s" : ""}`;
      lines.push(colour ? chalk.dim(more) : more);
    }

    lines.push("");
    idx++;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

/**
 * Returns a single-line compact summary string (used after spinner stops).
 *
 * @param {number} score
 * @param {number} issueCount
 * @returns {string}
 */
export function renderSummaryLine(score, issueCount) {
  const bar = renderProgressBar(score);
  const label = issueCount === 0
    ? chalk.green("No issues found.")
    : chalk.yellow(`${issueCount} issue${issueCount !== 1 ? "s" : ""} found.`);
  return `  ${bar}  ${label}`;
}

// ---------------------------------------------------------------------------
// Full dashboard  (score box + issue list + footer)
// ---------------------------------------------------------------------------

/**
 * Builds and returns the complete terminal output string.
 *
 * @param {object} params
 * @param {number} params.score
 * @param {number} params.totalPenalty
 * @param {object[]} params.issues
 * @param {string} params.projectPath
 * @returns {string}
 */
export function renderDashboard({ score, totalPenalty, issues, projectPath }) {
  const reportPath = path.resolve(REPORT_FILE);
  const parts = [];

  // Score header
  parts.push(renderScoreBox({ score, totalPenalty, issueCount: issues.length, projectPath }));

  if (issues.length === 0) {
    parts.push(chalk.green("\n  ✓  No issues detected — your ORM usage looks clean!\n"));
    return parts.join("\n");
  }

  // Numbered issue list
  parts.push(renderIssueList(issues, { colour: true }));

  // Footer
  parts.push(
    chalk.dim("Full results for all " + issues.length + ` issue${issues.length !== 1 ? "s" : ""} (.orm-doctor-report.json):`),
  );
  parts.push(chalk.cyan(reportPath));
  parts.push("");
  parts.push(chalk.dim("Read each file and fix the root cause — don't suppress or silence the rule."));
  parts.push("");
  parts.push(
    chalk.dim("Verify against the real thing: re-run ") +
    chalk.white("`npx orm-doctor`") +
    chalk.dim(" and confirm the issue count drops before moving on.")
  );
  parts.push("");
  parts.push(chalk.dim("─".repeat(64)));
  parts.push(
    chalk.dim("  Built by ") + chalk.magenta.bold("NoctisNova") +
    chalk.dim("  ·  noctisnova.com  ·  hello@noctisnova.com")
  );
  parts.push("");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Agent prompt builder  (plain-text version of the same format)
// ---------------------------------------------------------------------------

/**
 * Constructs the structured engineering prompt passed to Claude or clipboard.
 * Uses the same numbered layout as the terminal output but without ANSI colour.
 *
 * @param {object[]} issues
 * @param {string}   reportPath  Absolute path to the JSON report.
 * @returns {string}
 */
export function buildAgentPrompt(issues, reportPath) {
  const grouped = groupByRule(issues);
  const orderedGroups = [
    ...RULE_ORDER.filter((r) => grouped[r]),
    ...Object.keys(grouped).filter((r) => !RULE_ORDER.includes(r)),
  ];

  const topN = orderedGroups.length;
  const topLabel = topN === orderedGroups.length
    ? `all ${issues.length} issue${issues.length !== 1 ? "s" : ""}`
    : `the top ${topN} issue${topN !== 1 ? "s" : ""}`;

  // ── NoctisNova company context ─────────────────────────────────────────
  // This block tells the AI agent who owns this codebase and what it does,
  // so fixes are contextually relevant to the real product and tech stack.
  const companyContext = [
    "CODEBASE CONTEXT — READ BEFORE TOUCHING ANY FILE",
    "──────────────────────────────────────────────────",
    "This codebase belongs to NoctisNova (https://noctisnova.com).",
    "NoctisNova is a future-focused AI + engineering studio that designs and builds intelligent",
    "systems, digital experiences, and next-generation software.",
    "",
    "Tech stack:",
    "  - Frontend:     Next.js 14+ (App Router), React 18, TypeScript",
    "  - Backend:      Node.js, tRPC / REST APIs, serverless (Vercel / AWS Lambda)",
    "  - Database ORM: Prisma (primary) — schema lives in prisma/schema.prisma",
    "  - Auth:         Clerk or NextAuth",
    "  - AI layer:     OpenAI, Anthropic, LangChain, Vercel AI SDK",
    "  - Infra:        Vercel, AWS, Docker, GitHub Actions CI/CD",
    "",
    "Live AI products in this codebase:",
    "  - Nova   — AI voice scheduling agent",
    "  - Pulse  — streaming AI customer support agent",
    "  - Lens   — document intelligence & contract analysis",
    "  - Signal — AI lead qualifier and scorer",
    "",
    "Conventions to respect:",
    "  - All database access goes through the Prisma client (prisma/*).",
    "  - API routes live under src/app/api/ (Next.js Route Handlers).",
    "  - Server components fetch data directly; client components use hooks.",
    "  - Never add raw SQL unless explicitly asked — use Prisma query API.",
    "  - Performance is critical: these AI products handle real-time streaming",
    "    and concurrent users — any N+1 or slow query has immediate user impact.",
    "",
    "Contact / escalate: hello@noctisnova.com  |  noctisnova.com",
    "──────────────────────────────────────────────────",
    "",
  ].join("\n");

  const header = `Fix ${topLabel} detected by orm-doctor in this NoctisNova codebase — leave unrelated code alone.`;

  const issueBlock = renderIssueList(issues, { colour: false });

  const footer = [
    `Full results for all ${issues.length} issue${issues.length !== 1 ? "s" : ""} (.orm-doctor-report.json):`,
    reportPath,
    "",
    "Read each file and fix the root cause — don't suppress or silence the rule.",
    "",
    "Verify against the real thing, don't assume: re-run `npx orm-doctor` and confirm the issue " +
    "count drops before moving on to the next fix.",
    "",
    "Teach me as you go: for every issue you touch, explain it in plain language — what the problem " +
    "is, why it's a problem, and how serious it is in human terms. Describe the real-world impact and " +
    "severity concretely (e.g. \"this adds 200ms per request on a 100k-row table\" vs " +
    "\"this is a minor cleanup with no user impact\") so I understand why it matters, not just what changed.",
    "",
    "Then work through the rest from the full results above.",
    "",
    "─────────────────────────────────────────────────────────────────",
    "orm-doctor  ·  Built by NoctisNova  ·  https://noctisnova.com",
  ].join("\n");

  return [companyContext, header, issueBlock, footer].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Groups an issue array by rule key, preserving insertion order.
 * @param {object[]} issues
 * @returns {Record<string, object[]>}
 */
function groupByRule(issues) {
  const grouped = {};
  for (const issue of issues) {
    (grouped[issue.rule] ??= []).push(issue);
  }
  return grouped;
}
