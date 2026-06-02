/**
 * advanced.js — orm-doctor
 *
 * The advanced query-analysis engine. These rules catch the database bugs that
 * actually take production systems down — the ones a regex grep can't find
 * because they need real AST structure:
 *
 *   • unsafe-raw-query       — $queryRawUnsafe / string-built SQL → SQL injection
 *   • mass-mutation          — updateMany/deleteMany with no where → wipes a table
 *   • missing-pagination     — findMany() with no take/cursor → unbounded full scan
 *   • prisma-singleton       — new PrismaClient() with no global guard → pool exhaustion
 *   • missing-transaction    — multiple dependent writes not wrapped in $transaction
 *   • missing-relation-action — schema @relation with no onDelete referential action
 *
 * Plus detectStack() for the report header (ORM, DB provider, model count).
 */

import { Project, SyntaxKind } from "ts-morph";
import { getSchema } from "@mrleebo/prisma-ast";
import fs from "node:fs";
import path from "node:path";
import { collectTypeScriptFiles, isDeadCode } from "./scanner.js";

// ---------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------

const PENALTY_UNSAFE_RAW       = 20;
const PENALTY_MASS_MUTATION    = 18;
const PENALTY_MISSING_PAGINATION = 8;
const PENALTY_PRISMA_SINGLETON = 10;
const PENALTY_MISSING_TX       = 8;
const PENALTY_RELATION_ACTION  = 2;

const WRITE_METHODS = "(?:create|createMany|update|updateMany|delete|deleteMany|upsert)";
const DB_RECEIVER_RE = /\b(prisma|db|tx|trx|client|ctx|repo|repository)\b/i;

// ---------------------------------------------------------------------------
// Shared ts-morph project factory
// ---------------------------------------------------------------------------

function makeProject() {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true },
  });
}

function trimSnippet(text, max = 120) {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? text.trim();
  return first.length > max ? first.slice(0, max - 3) + "..." : first;
}

function liveFiles(projectPath) {
  return collectTypeScriptFiles(path.resolve(projectPath)).filter((f) => !isDeadCode(f));
}

function propName(callExpr) {
  const pae = callExpr.getExpressionIfKind(SyntaxKind.PropertyAccessExpression);
  return pae ? pae.getName() : null;
}

function objectHasProperty(objLit, name) {
  return objLit.getProperties().some((pr) => {
    const nameNode = pr.getChildAtIndexIfKind?.(0, SyntaxKind.Identifier);
    if (nameNode && nameNode.getText() === name) return true;
    // PropertyAssignment / ShorthandPropertyAssignment
    return typeof pr.getName === "function" && pr.getName() === name;
  });
}

// ---------------------------------------------------------------------------
// Rule: unsafe raw queries (SQL injection)
// ---------------------------------------------------------------------------

const UNSAFE_RAW_METHODS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
const RAW_FUNCTIONAL_METHODS = new Set(["$queryRaw", "$executeRaw"]);

/** Is the arg node a dynamic (non-constant) value? */
function isDynamicArg(arg) {
  if (!arg) return false;
  const k = arg.getKind();
  if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) return false;
  if (k === SyntaxKind.TemplateExpression) return true;        // has ${...}
  if (k === SyntaxKind.BinaryExpression) return true;          // "a" + x
  if (k === SyntaxKind.Identifier) return true;                // a variable
  if (k === SyntaxKind.CallExpression) return true;            // buildQuery()
  if (k === SyntaxKind.PropertyAccessExpression) return true;  // obj.sql
  return false;
}

export async function scanUnsafeRawQueries(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const files = liveFiles(resolved);
  const project = makeProject();

  for (const filePath of files) {
    let sf; try { sf = project.addSourceFileAtPath(filePath); } catch { continue; }
    const rel = path.relative(resolved, filePath).replace(/\\/g, "/");

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const name = propName(call);
      if (!name) continue;

      const isUnsafeName = UNSAFE_RAW_METHODS.has(name);
      const isFunctional = RAW_FUNCTIONAL_METHODS.has(name); // $queryRaw used WITH parens (not tagged)

      if (!isUnsafeName && !isFunctional) continue;

      const arg = call.getArguments()[0];
      // $queryRawUnsafe is dangerous whenever the SQL string is dynamic.
      // $queryRaw/$executeRaw used as a *function* (parens) bypasses parameterisation;
      // their SAFE form is a tagged template, which is a TaggedTemplateExpression (not a CallExpression),
      // so any CallExpression hit here is already the unsafe functional form.
      if (!isDynamicArg(arg)) continue;

      const line = sf.getLineAndColumnAtPos(call.getStart()).line;
      issues.push({
        type: "Unsafe Raw Query",
        rule: "unsafe-raw-query",
        severity: "critical",
        file: rel,
        line,
        snippet: trimSnippet(call.getText()),
        message:
          `\`${name}\` is called with a dynamically-built SQL string — this is a SQL injection hole. ` +
          "Any user input in that string can run arbitrary SQL. Use a tagged-template `prisma.$queryRaw\\`...\\`` " +
          "with ${} placeholders (auto-parameterised), or pass values as separate parameters to the Unsafe variant.",
        docs: "https://noctisnova.com/docs/orm/raw-query-safety",
        penalty: PENALTY_UNSAFE_RAW,
      });
    }
    project.removeSourceFile(sf);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: mass mutation (updateMany / deleteMany with no where)
// ---------------------------------------------------------------------------

export async function scanMassMutations(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const files = liveFiles(resolved);
  const project = makeProject();

  for (const filePath of files) {
    let sf; try { sf = project.addSourceFileAtPath(filePath); } catch { continue; }
    const rel = path.relative(resolved, filePath).replace(/\\/g, "/");

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const name = propName(call);
      if (name !== "deleteMany" && name !== "updateMany") continue;

      const receiver = call.getExpressionIfKind(SyntaxKind.PropertyAccessExpression)?.getExpression()?.getText() ?? "";
      if (!DB_RECEIVER_RE.test(receiver)) continue;

      const args = call.getArguments();
      if (args.length > 0) {
        // If the arg isn't an inspectable object literal (e.g. a variable), we
        // can't prove there's no `where` — skip to avoid a false positive.
        if (args[0].getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
        if (objectHasProperty(args[0], "where")) continue;
      }
      // Reaching here: no args, or an object literal with no `where` → whole-table mutation.

      const line = sf.getLineAndColumnAtPos(call.getStart()).line;
      issues.push({
        type: "Mass Mutation",
        rule: "mass-mutation",
        severity: "critical",
        file: rel,
        line,
        snippet: trimSnippet(call.getText()),
        message:
          `\`${name}\` has no \`where\` clause — it will ${name === "deleteMany" ? "DELETE every row" : "UPDATE every row"} in the table. ` +
          "A single accidental call wipes or rewrites all your data. Always scope mass mutations with a `where` filter " +
          "(use `where: {}` explicitly only if you truly mean the whole table, and guard it).",
        docs: "https://noctisnova.com/docs/orm/mass-mutations",
        penalty: PENALTY_MASS_MUTATION,
      });
    }
    project.removeSourceFile(sf);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: missing pagination (findMany with no take / cursor)
// ---------------------------------------------------------------------------

export async function scanMissingPagination(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const files = liveFiles(resolved);
  const project = makeProject();

  for (const filePath of files) {
    let sf; try { sf = project.addSourceFileAtPath(filePath); } catch { continue; }
    const rel = path.relative(resolved, filePath).replace(/\\/g, "/");

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (propName(call) !== "findMany") continue;

      const receiver = call.getExpressionIfKind(SyntaxKind.PropertyAccessExpression)?.getExpression()?.getText() ?? "";
      if (!DB_RECEIVER_RE.test(receiver)) continue;

      const args = call.getArguments();
      if (args.length > 0) {
        // Non-object arg (a variable holding the query) — can't prove it's unbounded, skip.
        if (args[0].getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
        if (objectHasProperty(args[0], "take") || objectHasProperty(args[0], "cursor")) continue;
      }
      // Reaching here: findMany() with no args, or an object literal with no take/cursor.

      const line = sf.getLineAndColumnAtPos(call.getStart()).line;
      issues.push({
        type: "Missing Pagination",
        rule: "missing-pagination",
        severity: "warning",
        file: rel,
        line,
        snippet: trimSnippet(call.getText()),
        message:
          "`findMany()` has no `take` or `cursor` — it loads the ENTIRE table into memory. " +
          "That's fine with 10 rows and fatal with 1,000,000: the query slows linearly and can OOM the server. " +
          "Add `take` (and `cursor`/`skip`) to paginate.",
        docs: "https://noctisnova.com/docs/orm/pagination",
        penalty: PENALTY_MISSING_PAGINATION,
      });
    }
    project.removeSourceFile(sf);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: PrismaClient singleton (pool exhaustion in dev/serverless)
// ---------------------------------------------------------------------------

const SINGLETON_GUARD_RE = /global(This)?\s*\.\s*\w*prisma|globalFor\w*|(?:const|let|var)\s+global\w*\s*=\s*globalThis/i;

export async function scanPrismaSingleton(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const files = liveFiles(resolved);

  const instantiating = [];
  for (const filePath of files) {
    let src; try { src = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
    if (!/new\s+PrismaClient\s*\(/.test(src)) continue;
    instantiating.push({ filePath, src });
  }
  if (instantiating.length === 0) return issues;

  const multiple = instantiating.length > 1;

  for (const { filePath, src } of instantiating) {
    const guarded = SINGLETON_GUARD_RE.test(src);
    if (guarded && !multiple) continue; // properly guarded single instance — ideal

    const rel = path.relative(resolved, filePath).replace(/\\/g, "/");
    const lines = src.split("\n");
    const line = Math.max(1, lines.findIndex((l) => /new\s+PrismaClient\s*\(/.test(l)) + 1);

    let message;
    if (multiple && !guarded) {
      message =
        `\`new PrismaClient()\` here — and this project instantiates it in ${instantiating.length} files. ` +
        "Each instance opens its own connection pool; multiple pools exhaust the database's connection limit. " +
        "Export ONE shared client from `lib/prisma.ts` and import it everywhere.";
    } else if (multiple) {
      message =
        `This project creates \`new PrismaClient()\` in ${instantiating.length} files. ` +
        "Collapse them into a single shared client exported from `lib/prisma.ts`.";
    } else {
      message =
        "`new PrismaClient()` is created without a `globalThis` guard. In Next.js dev (hot reload) and " +
        "serverless, this spawns a new connection pool on every reload/invocation and exhausts the database. " +
        "Wrap it: `const prisma = globalThis.prisma ?? new PrismaClient(); if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma`.";
    }

    issues.push({
      type: "Prisma Client Singleton",
      rule: "prisma-singleton",
      severity: "warning",
      file: rel,
      line,
      snippet: trimSnippet(lines[line - 1] ?? "new PrismaClient()"),
      message,
      docs: "https://noctisnova.com/docs/orm/prisma-singleton",
      penalty: PENALTY_PRISMA_SINGLETON,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: missing transaction (multiple dependent writes not atomic)
// ---------------------------------------------------------------------------

export async function scanMissingTransaction(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const files = liveFiles(resolved);
  const project = makeProject();

  const writeRe = new RegExp(`\\b(?:prisma|tx|trx|db|client)\\s*\\.\\s*\\w+\\s*\\.\\s*${WRITE_METHODS}\\s*\\(`, "g");

  for (const filePath of files) {
    let sf; try { sf = project.addSourceFileAtPath(filePath); } catch { continue; }
    const rel = path.relative(resolved, filePath).replace(/\\/g, "/");

    const fnNodes = [
      ...sf.getFunctions(),
      ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
      ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ];

    const seenLines = new Set();

    for (const fn of fnNodes) {
      const body = fn.getBody?.();
      if (!body) continue;
      const text = body.getText();

      // Already transactional — skip
      if (/\$transaction\s*[([]/.test(text)) continue;
      // Function receives a tx param (it's a callback inside a transaction) — skip
      const params = fn.getParameters?.() ?? [];
      if (params.some((p_) => /^(tx|trx|transaction)$/i.test(p_.getName()))) continue;

      const writes = [...text.matchAll(writeRe)];
      if (writes.length < 2) continue;

      const line = sf.getLineAndColumnAtPos(fn.getStart()).line;
      if (seenLines.has(line)) continue;
      seenLines.add(line);

      issues.push({
        type: "Missing Transaction",
        rule: "missing-transaction",
        severity: "warning",
        file: rel,
        line,
        snippet: trimSnippet(`${writes.length} writes in one function — not wrapped in $transaction`),
        message:
          `This function performs ${writes.length} write operations that aren't wrapped in a transaction. ` +
          "If the process crashes between writes, your data is left half-updated (e.g. money debited but not credited). " +
          "Wrap dependent writes in `prisma.$transaction([...])` (or the interactive `$transaction(async (tx) => {...})`) so they all commit or all roll back.",
        docs: "https://noctisnova.com/docs/orm/transactions",
        penalty: PENALTY_MISSING_TX,
      });
    }
    project.removeSourceFile(sf);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: schema relation missing onDelete (referential action)
// ---------------------------------------------------------------------------

function resolveSchemaFile(schemaPath) {
  let resolved = path.resolve(schemaPath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isDirectory()) {
    const direct = path.join(resolved, "schema.prisma");
    const nested = path.join(resolved, "prisma", "schema.prisma");
    if (fs.existsSync(direct)) resolved = direct;
    else if (fs.existsSync(nested)) resolved = nested;
    else return null;
  }
  return resolved;
}

export async function scanMissingRelationActions(schemaPath) {
  const issues = [];
  const file = resolveSchemaFile(schemaPath);
  if (!file) return issues;

  let source; try { source = fs.readFileSync(file, "utf-8"); } catch { return issues; }
  let schema; try { schema = getSchema(source); } catch { return issues; }

  const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
  const sourceLines = source.split("\n");

  function findRelationLine(modelName, fieldName) {
    let inside = false;
    for (let i = 0; i < sourceLines.length; i++) {
      const l = sourceLines[i];
      if (!inside) { if (/^\s*model\s+/.test(l) && l.includes(modelName)) inside = true; continue; }
      if (/^\s*\}/.test(l)) break;
      if (new RegExp(`^\\s+${fieldName}\\s`).test(l)) return i + 1;
    }
    return 0;
  }

  for (const block of schema.list) {
    if (block.type !== "model") continue;
    for (const item of block.properties) {
      if (item.type !== "field") continue;
      const relationAttr = item.attributes?.find((a) => a.type === "attribute" && a.name === "relation");
      if (!relationAttr) continue;

      // Only the FK-owning side has `fields:` — that's where onDelete belongs
      const args = relationAttr.args ?? [];
      const argText = JSON.stringify(args);
      const ownsForeignKey = /"fields"/.test(argText) || /fields\s*:/.test(argText);
      if (!ownsForeignKey) continue;

      const hasOnDelete = /onDelete/.test(argText);
      if (hasOnDelete) continue;

      issues.push({
        type: "Missing Referential Action",
        rule: "missing-relation-action",
        severity: "info",
        file: rel,
        line: findRelationLine(block.name, item.name),
        snippet: `${block.name}.${item.name} @relation(...)`,
        message:
          `Relation \`${block.name}.${item.name}\` has no \`onDelete\` action. The default (\`Restrict\`/\`SetNull\`) ` +
          "is often not what you want — deleting a parent can either fail unexpectedly or silently orphan children. " +
          "Set it explicitly: `onDelete: Cascade` (delete children) or `Restrict` (block) so the behaviour is intentional.",
        docs: "https://noctisnova.com/docs/orm/referential-actions",
        penalty: PENALTY_RELATION_ACTION,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Stack detection (report header)
// ---------------------------------------------------------------------------

export function detectStack(projectPath, schemaPath) {
  const root = path.resolve(projectPath);
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")); } catch { /* */ }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  const labels = [];
  const ver = (r) => { const m = String(r ?? "").match(/(\d+)/); return m ? ` ${m[1]}` : ""; };

  if (deps["@prisma/client"] || deps.prisma) labels.push(`Prisma${ver(deps["@prisma/client"] ?? deps.prisma)}`);
  if (deps["drizzle-orm"]) labels.push("Drizzle");
  if (deps.next) labels.push(`Next.js${ver(deps.next)}`);
  if (deps.typescript) labels.push("TypeScript");

  // Datasource provider + model count from schema
  let provider = null, modelCount = 0;
  const schemaFile = resolveSchemaFile(schemaPath ?? root);
  if (schemaFile) {
    try {
      const src = fs.readFileSync(schemaFile, "utf-8");
      const m = src.match(/provider\s*=\s*["']([^"']+)["']/);
      if (m) provider = m[1];
      modelCount = (src.match(/^\s*model\s+\w+/gm) ?? []).length;
    } catch { /* */ }
  }

  return { labels, provider, modelCount };
}

// ---------------------------------------------------------------------------
// Aggregate runner for the advanced rules
// ---------------------------------------------------------------------------

export async function runAdvancedScans(projectPath, schemaPath) {
  const [raw, mass, pagination, singleton, tx, relations] = await Promise.all([
    scanUnsafeRawQueries(projectPath),
    scanMassMutations(projectPath),
    scanMissingPagination(projectPath),
    scanPrismaSingleton(projectPath),
    scanMissingTransaction(projectPath),
    scanMissingRelationActions(schemaPath ?? projectPath),
  ]);
  return [...raw, ...mass, ...pagination, ...singleton, ...tx, ...relations];
}
