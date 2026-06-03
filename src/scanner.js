/**
 * scanner.js
 * AST-based static analyzer for ORM/database bottleneck detection.
 * Uses ts-morph for TypeScript traversal and @mrleebo/prisma-ast for schema parsing.
 */

import { Project, SyntaxKind } from "ts-morph";
import { getSchema } from "@mrleebo/prisma-ast";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NPLUS1_PENALTY = 15;
const MISSING_INDEX_PENALTY = 10;
const SEED_HARDCODED_ID_PENALTY = 8;
const SEED_NO_TRUNCATE_PENALTY = 8;
const SEED_NO_DISCONNECT_PENALTY = 3;
const SEED_LARGE_BATCH_PENALTY = 5;
const REPORT_FILE = "./.orm-doctor-report.json";

/**
 * Regex patterns that identify hardcoded ID values inside seed files.
 * Matches UUID v4, CUID, CUID2, and numeric string IDs assigned to id fields.
 */
const HARDCODED_ID_PATTERNS = [
  // id: "some-uuid-or-cuid"
  /\bid\s*:\s*["'`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["'`]/i,
  // id: "cjld2cy..." (CUID)
  /\bid\s*:\s*["'`]c[a-z0-9]{20,30}["'`]/,
  // id: "clxxxxxxx..." (CUID2)
  /\bid\s*:\s*["'`][a-z0-9]{24,}["'`]/,
  // id: "1" or id: "123" (numeric string IDs)
  /\bid\s*:\s*["'`]\d+["'`]/,
  // id: 1 or id: 123 (numeric literal IDs — only flag in create/upsert context)
  /\bid\s*:\s*\d+\b/,
];

/** Seed file name/path patterns — where to look for seed files. */
const SEED_FILE_PATTERNS = [
  /prisma[/\\]seed\.[tj]sx?$/,
  /prisma[/\\]seed[/\\]index\.[tj]sx?$/,
  /[/\\]seed\.[tj]sx?$/,
  /[/\\]seeds?[/\\].*\.[tj]sx?$/,
  /[/\\]database[/\\]seed[^/\\]*\.[tj]sx?$/,
];

/** High-volume create calls threshold — flag seeds creating a huge number of records inline. */
const LARGE_BATCH_THRESHOLD = 50;

/**
 * File patterns that indicate dead / non-production code that should not be
 * flagged.  Includes test suites, mocks, stubs, fixtures, e2e, and Cypress.
 */
const DEAD_CODE_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /\.mock\.[tj]sx?$/,
  /\.stub\.[tj]sx?$/,
  /\.fixture\.[tj]sx?$/,
  /\/__tests__\//,
  /\/__mocks__\//,
  /\/test\//,
  /\/tests\//,
  /\/e2e\//,
  /\/cypress\//,
  /\/playwright\//,
  /\/vitest\//,
  /\/jest\//,
];

/**
 * Patterns that indicate a database call is being made.
 * Intentionally broad to catch Prisma, Drizzle, raw pg/mysql clients, Knex, etc.
 */
const DB_CALL_PATTERNS = [
  /prisma\s*\.\s*\w+\s*\.\s*(findMany|findFirst|findUnique|create|update|delete|upsert|count|aggregate|groupBy)/,
  /prisma\s*\.\s*\$queryRaw/,
  /prisma\s*\.\s*\$executeRaw/,
  /db\s*\.\s*(select|insert|update|delete|query|execute|from|where)/,
  /db\s*\.\s*\w+\s*\.\s*(findMany|findFirst|findUnique|create|update|delete)/,
  /\.\s*(query|execute|run)\s*\(/,
  /await\s+\w+\.(query|execute|run)\s*\(/,
  /knex\s*\(/,
  /sequelize\s*\.\s*query/,
];

/**
 * Node kinds that represent an iteration body we want to flag.
 */
const ITERATION_CALL_NAMES = new Set(["map", "forEach", "filter", "find", "reduce", "flatMap", "every", "some"]);

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Returns true when the file path matches a dead-code / test-file pattern.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isDeadCode(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return DEAD_CODE_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Returns true when the given source text contains any known DB call pattern.
 * @param {string} text
 * @returns {boolean}
 */
function containsDbCall(text) {
  return DB_CALL_PATTERNS.some((re) => re.test(text));
}

/**
 * Trims a multi-line snippet to a single representative line (the first
 * non-empty line), capped at 120 characters for display.
 * @param {string} snippet
 * @returns {string}
 */
function trimSnippet(snippet) {
  const first = snippet
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? snippet.trim();
  return first.length > 120 ? first.slice(0, 117) + "..." : first;
}

/**
 * Resolves a glob-free base project path to a list of .ts / .tsx source files,
 * skipping node_modules, dist, and .d.ts declaration files.
 * @param {string} projectPath
 * @returns {string[]}
 */
export function collectTypeScriptFiles(projectPath) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".next", ".nuxt", "out", ".git"].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        results.push(full);
      }
    }
  }

  walk(path.resolve(projectPath));
  return results;
}

// ---------------------------------------------------------------------------
// Rule 1 – N+1 query detector
// ---------------------------------------------------------------------------

/**
 * Scans TypeScript/TSX source files for N+1 query patterns:
 * array iteration callbacks (.map, .forEach, etc.) and for/for-of loops
 * whose body contains an ORM database call.
 *
 * @param {string} projectPath - Root directory to scan.
 * @returns {Promise<import('./types').Issue[]>}
 */
export async function scanForNPlusOne(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);
  const tsFiles = collectTypeScriptFiles(resolvedPath);

  if (tsFiles.length === 0) {
    return issues;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      resolveJsonModule: false,
      noEmit: true,
    },
  });

  for (const filePath of tsFiles) {
    let sourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(filePath);
    } catch {
      continue;
    }

    const relPath = path.relative(resolvedPath, filePath).replace(/\\/g, "/");

    // -----------------------------------------------------------------------
    // Pattern A: .map() / .forEach() / .filter() / etc. with a DB call inside
    // -----------------------------------------------------------------------
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const memberAccess = callExpr.getExpressionIfKind(SyntaxKind.PropertyAccessExpression);
      if (!memberAccess) continue;

      const methodName = memberAccess.getName();
      if (!ITERATION_CALL_NAMES.has(methodName)) continue;

      const args = callExpr.getArguments();
      if (args.length === 0) continue;

      const callbackArg = args[0];
      const callbackText = callbackArg.getText();

      if (!containsDbCall(callbackText)) continue;

      const lineNumber = sourceFile.getLineAndColumnAtPos(callExpr.getStart()).line;
      const snippet = trimSnippet(callExpr.getText());

      issues.push({
        type: "N+1 Query",
        rule: "nplus1",
        severity: "critical",
        file: relPath,
        line: lineNumber,
        snippet,
        message: `Potential N+1: database call found inside \`.${methodName}()\` callback.`,
        docs: "https://www.prisma.io/docs/guides/performance-and-optimization/query-optimization-performance",
        penalty: NPLUS1_PENALTY,
      });
    }

    // -----------------------------------------------------------------------
    // Pattern B: for...of loops containing a DB call
    // -----------------------------------------------------------------------
    const forOfStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ForOfStatement);

    for (const forOf of forOfStatements) {
      const bodyText = forOf.getStatement().getText();
      if (!containsDbCall(bodyText)) continue;

      const lineNumber = sourceFile.getLineAndColumnAtPos(forOf.getStart()).line;
      const snippet = trimSnippet(forOf.getText());

      issues.push({
        type: "N+1 Query",
        rule: "nplus1",
        severity: "critical",
        file: relPath,
        line: lineNumber,
        snippet,
        message: "Potential N+1: database call found inside a `for...of` loop.",
        docs: "https://www.prisma.io/docs/guides/performance-and-optimization/query-optimization-performance",
        penalty: NPLUS1_PENALTY,
      });
    }

    // -----------------------------------------------------------------------
    // Pattern C: classic for loops containing a DB call
    // -----------------------------------------------------------------------
    const forStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ForStatement);

    for (const forStmt of forStatements) {
      const bodyText = forStmt.getStatement().getText();
      if (!containsDbCall(bodyText)) continue;

      const lineNumber = sourceFile.getLineAndColumnAtPos(forStmt.getStart()).line;
      const snippet = trimSnippet(forStmt.getText());

      issues.push({
        type: "N+1 Query",
        rule: "nplus1",
        severity: "critical",
        file: relPath,
        line: lineNumber,
        snippet,
        message: "Potential N+1: database call found inside a `for` loop.",
        docs: "https://www.prisma.io/docs/guides/performance-and-optimization/query-optimization-performance",
        penalty: NPLUS1_PENALTY,
      });
    }

    // -----------------------------------------------------------------------
    // Pattern D: while loops containing a DB call
    // -----------------------------------------------------------------------
    const whileStatements = sourceFile.getDescendantsOfKind(SyntaxKind.WhileStatement);

    for (const whileStmt of whileStatements) {
      const bodyText = whileStmt.getStatement().getText();
      if (!containsDbCall(bodyText)) continue;

      const lineNumber = sourceFile.getLineAndColumnAtPos(whileStmt.getStart()).line;
      const snippet = trimSnippet(whileStmt.getText());

      issues.push({
        type: "N+1 Query",
        rule: "nplus1",
        severity: "critical",
        file: relPath,
        line: lineNumber,
        snippet,
        message: "Potential N+1: database call found inside a `while` loop.",
        docs: "https://www.prisma.io/docs/guides/performance-and-optimization/query-optimization-performance",
        penalty: NPLUS1_PENALTY,
      });
    }

    project.removeSourceFile(sourceFile);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 2 – Missing index detector (Prisma schema)
// ---------------------------------------------------------------------------

/**
 * Parses a Prisma schema file and flags foreign-key fields (names ending in
 * "Id") that lack a corresponding `@@index` entry in the same model.
 *
 * @param {string} schemaPath - Path to schema.prisma (or its directory).
 * @returns {Promise<import('./types').Issue[]>}
 */
export async function scanForMissingIndexes(schemaPath) {
  const issues = [];

  let resolvedSchema = path.resolve(schemaPath);
  const stat = fs.statSync(resolvedSchema, { throwIfNoEntry: false });

  if (!stat) return issues;

  if (stat.isDirectory()) {
    const candidate = path.join(resolvedSchema, "schema.prisma");
    if (!fs.existsSync(candidate)) {
      const nested = path.join(resolvedSchema, "prisma", "schema.prisma");
      if (!fs.existsSync(nested)) return issues;
      resolvedSchema = nested;
    } else {
      resolvedSchema = candidate;
    }
  }

  let schemaSource;
  try {
    schemaSource = fs.readFileSync(resolvedSchema, "utf-8");
  } catch {
    return issues;
  }

  let schema;
  try {
    schema = getSchema(schemaSource);
  } catch {
    return issues;
  }

  const relPath = path.relative(process.cwd(), resolvedSchema).replace(/\\/g, "/");
  // Pre-split lines for real line-number lookups
  const sourceLines = schemaSource.split("\n");

  /**
   * Finds the 1-based line number of a field declaration inside a named model
   * by scanning the source text.  Falls back to 0 if not found.
   */
  function findFieldLine(modelName, fieldName) {
    let insideModel = false;
    for (let i = 0; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      if (!insideModel) {
        if (/^\s*model\s+/.test(line) && line.includes(modelName)) insideModel = true;
        continue;
      }
      // Closing brace ends the model block
      if (/^\s*\}/.test(line)) break;
      // Match "  fieldName " at the start of a field line
      if (new RegExp(`^\\s+${fieldName}\\s`).test(line)) return i + 1;
    }
    return 0;
  }

  for (const block of schema.list) {
    if (block.type !== "model") continue;

    const modelName = block.name;

    // ── Collect FK fields (names ending in "Id", no @relation attribute) ──
    const foreignKeyFields = [];
    for (const item of block.properties) {
      if (item.type !== "field") continue;
      if (!/Id$/.test(item.name)) continue;
      const isRelationField = item.attributes?.some(
        (a) => a.type === "attribute" && a.name === "relation"
      );
      if (!isRelationField) {
        foreignKeyFields.push({
          name: item.name,
          line: findFieldLine(modelName, item.name),
        });
      }
    }

    if (foreignKeyFields.length === 0) continue;

    // ── Collect fields that already have index coverage ────────────────────
    const indexedFields = new Set();

    for (const item of block.properties) {
      // Block-level @@index  →  { type:"attribute", kind:"object", name:"index",
      //   args:[{ type:"attributeArgument", value:{ type:"array", args:["fieldName",...] } }] }
      if (item.type === "attribute" && item.name === "index") {
        for (const arg of item.args ?? []) {
          const val = arg.value;
          if (val?.type === "array" && Array.isArray(val.args)) {
            for (const f of val.args) {
              if (typeof f === "string") indexedFields.add(f);
            }
          }
        }
      }

      // Field-level @id / @unique create implicit indexes
      if (item.type === "field") {
        const hasImplicit = item.attributes?.some(
          (a) => a.type === "attribute" && (a.name === "id" || a.name === "unique")
        );
        if (hasImplicit) indexedFields.add(item.name);
      }
    }

    // ── Flag FK fields with no index coverage ─────────────────────────────
    for (const fk of foreignKeyFields) {
      if (!indexedFields.has(fk.name)) {
        issues.push({
          type: "Missing Index",
          rule: "missing-index",
          severity: "warning",
          file: relPath,
          line: fk.line,
          snippet: `${modelName}.${fk.name}`,
          message: `Foreign key field \`${fk.name}\` in model \`${modelName}\` has no \`@@index\` – unindexed FK causes full table scans on JOINs.`,
          docs: "https://www.prisma.io/docs/concepts/components/prisma-schema/indexes",
          penalty: MISSING_INDEX_PENALTY,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 3 – Seed file analyser
// ---------------------------------------------------------------------------

/**
 * Locates seed files anywhere under projectPath and runs static checks for:
 *   - Hardcoded ID literals (UUID / CUID / numeric) assigned to id: fields
 *   - Missing deleteMany / truncate before create (re-seed duplicate key risk)
 *   - Missing prisma.$disconnect() (hanging CI process)
 *   - Unusually large inline create() call count (CI timeout proxy heuristic)
 *
 * @param {string} projectPath
 * @returns {Promise<object[]>}
 */
export async function scanSeedFiles(projectPath) {
  const issues = [];
  const resolvedPath = path.resolve(projectPath);

  // ── Locate all seed files ─────────────────────────────────────────────────
  const allFiles = collectTypeScriptFiles(resolvedPath);

  // Also check JS seed files that collectTypeScriptFiles skips
  const jsSeedFiles = findSeedJsFiles(resolvedPath);
  const seedFiles = [
    ...allFiles.filter((f) => {
      const norm = f.replace(/\\/g, "/");
      return SEED_FILE_PATTERNS.some((re) => re.test(norm));
    }),
    ...jsSeedFiles,
  ];

  if (seedFiles.length === 0) return issues;

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true },
  });

  for (const filePath of seedFiles) {
    let source;
    try {
      source = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const relPath = path.relative(resolvedPath, filePath).replace(/\\/g, "/");
    const lines = source.split("\n");

    // ── Check 1: Hardcoded ID literals ───────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (HARDCODED_ID_PATTERNS.some((re) => re.test(line))) {
        // Skip if this is a lookup/where clause (id lookup is fine)
        const isWhereLookup = /where\s*:\s*\{/.test(lines[i - 1] ?? "") ||
          /where\s*:\s*\{/.test(line);
        if (isWhereLookup) continue;

        issues.push({
          type: "Seed Issue",
          rule: "seed-hardcoded-id",
          severity: "warning",
          file: relPath,
          line: i + 1,
          snippet: trimSnippet(line),
          message:
            "Hardcoded ID in seed data — conflicts on re-seed and breaks across environments. " +
            "Let Prisma generate IDs with @default(cuid()) and store references in variables.",
          docs: "https://noctisnova.com/tools/orm-doctor/seed-best-practices",
          penalty: SEED_HARDCODED_ID_PENALTY,
        });
      }
    }

    // ── Check 2: No clear/truncate before creates (duplicate key on re-seed) ─
    const hasCreateCall = /prisma\.\w+\.(create|createMany|upsert)\s*\(/.test(source);
    const hasClearBefore =
      /prisma\.\w+\.(deleteMany|delete)\s*\(/.test(source) ||
      /truncate/i.test(source) ||
      /\$executeRaw.*TRUNCATE/i.test(source);

    if (hasCreateCall && !hasClearBefore) {
      // Find the first create line for location
      const createLine = lines.findIndex((l) =>
        /prisma\.\w+\.(create|createMany)\s*\(/.test(l)
      );
      issues.push({
        type: "Seed Issue",
        rule: "seed-no-truncate",
        severity: "warning",
        file: relPath,
        line: createLine >= 0 ? createLine + 1 : 1,
        snippet: createLine >= 0 ? trimSnippet(lines[createLine]) : filePath,
        message:
          "Seed file creates records without first clearing existing data. " +
          "Re-running the seed (common in CI) will throw duplicate key errors. " +
          "Add prisma.<model>.deleteMany({}) at the top of your seed in dependency order.",
        docs: "https://noctisnova.com/tools/orm-doctor/seed-best-practices",
        penalty: SEED_NO_TRUNCATE_PENALTY,
      });
    }

    // ── Check 3: Missing $disconnect (hangs CI) ───────────────────────────────
    const hasDisconnect = /\$disconnect\s*\(\s*\)/.test(source);
    const hasFinally = /finally\s*\{/.test(source);

    if (hasCreateCall && !hasDisconnect) {
      const lastLine = lines.length;
      issues.push({
        type: "Seed Issue",
        rule: "seed-no-disconnect",
        severity: "info",
        file: relPath,
        line: lastLine,
        snippet: "prisma.$disconnect()",
        message:
          "Seed file does not call prisma.$disconnect(). " +
          "The Node.js process will hang in CI until the connection times out. " +
          "Wrap your seed in try/finally and call prisma.$disconnect() in the finally block.",
        docs: "https://noctisnova.com/tools/orm-doctor/seed-best-practices",
        penalty: SEED_NO_DISCONNECT_PENALTY,
      });
    }

    // ── Check 4: Large inline batch (CI timeout heuristic) ───────────────────
    const createMatches = source.match(/prisma\.\w+\.create\s*\(/g) ?? [];
    const createManyMatches = source.match(/prisma\.\w+\.createMany\s*\(/g) ?? [];
    const totalCreates = createMatches.length + createManyMatches.length;

    if (totalCreates >= LARGE_BATCH_THRESHOLD) {
      issues.push({
        type: "Seed Issue",
        rule: "seed-large-batch",
        severity: "warning",
        file: relPath,
        line: 1,
        snippet: `${totalCreates} create() calls detected`,
        message:
          `Seed file contains ${totalCreates} create() calls — this may exceed CI timeout limits (typically 30s). ` +
          "Use createMany() with a data array for bulk inserts, or split into chunked batches with Promise.all.",
        docs: "https://noctisnova.com/tools/orm-doctor/seed-best-practices",
        penalty: SEED_LARGE_BATCH_PENALTY,
      });
    }
  }

  return issues;
}

/**
 * Finds plain .js seed files that collectTypeScriptFiles skips.
 * @param {string} rootPath
 * @returns {string[]}
 */
function findSeedJsFiles(rootPath) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".next", ".git"].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && /\.jsx?$/.test(entry.name)) {
        const norm = full.replace(/\\/g, "/");
        if (SEED_FILE_PATTERNS.some((re) => re.test(norm))) results.push(full);
      }
    }
  }
  walk(rootPath);
  return results;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs all scanners against the given project root and writes the JSON report.
 *
 * @param {object} opts
 * @param {string} opts.projectPath - Root directory of the TypeScript project.
 * @param {string} [opts.schemaPath] - Path to schema.prisma or its directory.
 * @returns {Promise<{ issues: import('./types').Issue[], totalPenalty: number, score: number }>}
 */
export async function runAllScans({ projectPath, schemaPath }) {
  const resolvedSchema = schemaPath ?? projectPath;

  const [nPlusOneIssues, missingIndexIssues, seedIssues] = await Promise.all([
    scanForNPlusOne(projectPath),
    scanForMissingIndexes(resolvedSchema),
    scanSeedFiles(projectPath),
  ]);

  const issues = [...nPlusOneIssues, ...missingIndexIssues, ...seedIssues];
  const totalPenalty = issues.reduce((sum, i) => sum + i.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);

  const report = {
    generatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    score,
    totalPenalty,
    issueCount: issues.length,
    issues,
  };

  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf-8");
  } catch {
    // Non-fatal
  }

  return { issues, totalPenalty, score };
}
