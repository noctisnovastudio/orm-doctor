#!/usr/bin/env node
/**
 * index.js
 * orm-doctor — ORM static analysis CLI
 *
 * Orchestrates multi-phase scanning with animated UI, dead-code filtering,
 * a score reveal animation, and an arrow-key agent hand-off menu.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import clipboardy from "clipboardy";
import boxen from "boxen";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  scanForNPlusOne,
  scanForMissingIndexes,
  scanSeedFiles,
  collectTypeScriptFiles,
  isDeadCode,
} from "./src/scanner.js";

import {
  runAdvancedScans,
  detectStack,
} from "./src/advanced.js";

import {
  renderProgressBar,
  renderScoreBadge,
  renderDashboard,
  renderStackLine,
  buildAgentPrompt,
} from "./src/ui.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORT_FILE = "./.orm-doctor-report.json";
const VERSION = "1.0.0";

const HELP_TEXT = `
${chalk.bold("orm-doctor")}  v${VERSION}
Static analysis CLI for ORM/database bottleneck detection.

${chalk.bold("Usage")}
  orm-doctor [options] [path]

${chalk.bold("Arguments")}
  path                  Root directory to scan (default: current working directory)

${chalk.bold("Options")}
  --schema, -s <path>   Path to schema.prisma or its directory
  --json                Print the JSON report to stdout (CI mode)
  --no-ai               Skip the agent hand-off menu
  --version, -v         Print version and exit
  --help, -h            Show this help message

${chalk.bold("What it detects")}
  ${chalk.red("Security")}     SQL injection via $queryRawUnsafe / string-built SQL
  ${chalk.red("Data safety")}  updateMany/deleteMany with no WHERE (table wipe)
               dependent writes not wrapped in a transaction
  ${chalk.yellow("Performance")}  N+1 queries in loops · findMany() with no pagination
  ${chalk.yellow("Connections")}  new PrismaClient() with no global singleton guard
  ${chalk.yellow("Schema")}       foreign keys with no @@index · relations with no onDelete
  ${chalk.blue("Seeds")}        hardcoded IDs · no truncate · no $disconnect · huge batches

${chalk.bold("Examples")}
  orm-doctor
  orm-doctor ./my-project --schema ./my-project/prisma
  orm-doctor --json > report.json
`.trim();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseCLIArgs() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        schema:     { type: "string",  short: "s" },
        json:       { type: "boolean", default: false },
        "no-ai":    { type: "boolean", default: false },
        version:    { type: "boolean", short: "v", default: false },
        help:       { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
  return {
    projectPath: parsed.positionals[0] ?? process.cwd(),
    schemaPath:  parsed.values.schema ?? null,
    jsonMode:    parsed.values.json,
    noAi:        parsed.values["no-ai"],
    showVersion: parsed.values.version,
    showHelp:    parsed.values.help,
  };
}

// ---------------------------------------------------------------------------
// Score reveal animation
// ---------------------------------------------------------------------------

/**
 * Counts the progress bar up from 0 → score with an ease-out curve,
 * then leaves the cursor on a new line ready for the dashboard box.
 *
 * @param {number} score
 */
async function animateScoreReveal(score) {
  const frames = 40;
  // Hide cursor during animation to prevent flicker
  process.stdout.write("\x1B[?25l");

  for (let i = 0; i <= frames; i++) {
    const current = Math.round(easeOut(i / frames) * score);
    const bar   = renderProgressBar(current);
    const badge = renderScoreBadge(current);
    process.stdout.write(`\r  ${bar}  ${badge}   `);
    await sleep(16);
  }

  // Restore cursor
  process.stdout.write("\x1B[?25h\n\n");
}

// ---------------------------------------------------------------------------
// AI hand-off handlers
// ---------------------------------------------------------------------------

function handOffToClaude(prompt) {
  const reportPath = path.resolve(REPORT_FILE);
  if (!fs.existsSync(reportPath)) {
    p.log.warn("Report file not found — run orm-doctor first.");
    return;
  }
  const safePrompt = prompt.replace(/"/g, '\\"');
  p.log.step(chalk.dim("Launching Claude Code…"));
  try {
    execSync(`claude -p "${safePrompt}"`, { stdio: "inherit", shell: true, cwd: process.cwd() });
  } catch (err) {
    if (err.status === 127 || /not found|is not recognized/i.test(err.message ?? "")) {
      p.log.error(
        chalk.red("The `claude` CLI was not found in your PATH.\n") +
        chalk.dim("  Install it: https://docs.anthropic.com/en/docs/claude-code/getting-started")
      );
    } else {
      p.log.warn(chalk.yellow(`Claude exited with code ${err.status ?? "unknown"}.`));
    }
  }
}

async function copyToClipboard(prompt) {
  try {
    await clipboardy.write(prompt);
    p.log.success(chalk.green("Prompt copied to clipboard!"));
    p.log.info(chalk.dim("Paste it into Cursor, ChatGPT, or any AI assistant."));
  } catch (err) {
    p.log.error(chalk.red(`Clipboard write failed: ${err.message}`));
  }
}

function printPrompt(prompt) {
  console.log();
  console.log(
    boxen(chalk.white(prompt), {
      title: chalk.bold.magenta(" Agent Prompt "),
      titleAlignment: "center",
      padding: { top: 1, bottom: 1, left: 2, right: 2 },
      margin: { top: 0, bottom: 1 },
      borderStyle: "round",
      borderColor: "magenta",
    })
  );
}

// ---------------------------------------------------------------------------
// Multi-phase scan with animated spinner stages
// ---------------------------------------------------------------------------

/**
 * Runs all scans across distinct spinner phases so the user sees progress.
 * Returns the full scan result plus dead-code stats.
 *
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {string} opts.schemaPath
 * @returns {Promise<{ issues, filteredOut, totalPenalty, score }>}
 */
async function runPhasedScans({ projectPath, schemaPath }) {
  const spinner = p.spinner();

  // ── Phase 1: Discover ────────────────────────────────────────────────────
  spinner.start(chalk.dim("Discovering source files…"));
  await sleep(350);

  const allFiles = collectTypeScriptFiles(projectPath);
  const deadFiles = allFiles.filter(isDeadCode);
  const liveFiles = allFiles.filter((f) => !isDeadCode(f));

  spinner.message(
    chalk.dim(`Found `) +
    chalk.white(`${allFiles.length}`) +
    chalk.dim(` TypeScript files — tracing AST patterns…`)
  );
  await sleep(500);

  // ── Phase 2: N+1 scan ────────────────────────────────────────────────────
  spinner.message(chalk.dim("Scanning for N+1 query patterns…"));
  await sleep(300);

  const rawNPlusOne = await scanForNPlusOne(projectPath);

  spinner.message(chalk.dim("Analysing query call sites…"));
  await sleep(350);

  // ── Phase 3: Schema scan ─────────────────────────────────────────────────
  spinner.message(chalk.dim("Parsing Prisma schema…"));
  await sleep(300);

  const rawMissingIdx = await scanForMissingIndexes(schemaPath ?? projectPath);

  spinner.message(chalk.dim("Checking index coverage on foreign keys…"));
  await sleep(350);

  // ── Phase 3b: Seed file scan ──────────────────────────────────────────────
  spinner.message(chalk.dim("Analysing Prisma seed files…"));
  await sleep(300);

  const rawSeedIssues = await scanSeedFiles(projectPath);

  spinner.message(chalk.dim("Checking seed safety patterns…"));
  await sleep(300);

  // ── Phase 3c: Advanced query analysis ─────────────────────────────────────
  spinner.message(chalk.dim("Hunting raw-SQL injection & mass-mutation calls…"));
  await sleep(300);
  spinner.message(chalk.dim("Checking pagination, transactions & client singleton…"));
  await sleep(300);

  const rawAdvanced = await runAdvancedScans(projectPath, schemaPath ?? projectPath);

  // ── Phase 4: Dead code filter ─────────────────────────────────────────────
  spinner.message(
    chalk.dim("Filtering dead code") +
    (deadFiles.length > 0
      ? chalk.dim(` — ignoring ${deadFiles.length} test/mock file${deadFiles.length !== 1 ? "s" : ""}…`)
      : chalk.dim("…"))
  );
  await sleep(400);

  const allRaw = [...rawNPlusOne, ...rawMissingIdx, ...rawSeedIssues, ...rawAdvanced];
  const issues = allRaw.filter((issue) => !isDeadCode(issue.file));
  const filteredOut = allRaw.length - issues.length;

  // ── Phase 5: Score ────────────────────────────────────────────────────────
  spinner.message(chalk.dim("Computing health score…"));
  await sleep(400);

  const totalPenalty = issues.reduce((s, i) => s + i.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);
  const stack = detectStack(projectPath, schemaPath ?? projectPath);

  // Persist report
  try {
    fs.writeFileSync(
      REPORT_FILE,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          projectPath: path.resolve(projectPath),
          stack,
          score,
          totalPenalty,
          issueCount: issues.length,
          filteredOut,
          liveFilesScanned: liveFiles.length,
          deadFilesIgnored: deadFiles.length,
          issues,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch { /* non-fatal */ }

  const doneMsg = issues.length === 0
    ? chalk.green("Done — no issues found.")
    : chalk.yellow(`Done — ${issues.length} issue${issues.length !== 1 ? "s" : ""} found.`);

  spinner.stop(doneMsg);

  if (deadFiles.length > 0) {
    p.log.info(
      chalk.dim(`Ignored `) +
      chalk.white(deadFiles.length) +
      chalk.dim(` dead-code file${deadFiles.length !== 1 ? "s" : ""} (tests / mocks / fixtures)`)
    );
  }

  return { issues, filteredOut, totalPenalty, score, stack };
}

// ---------------------------------------------------------------------------
// Agent hand-off menu
// ---------------------------------------------------------------------------

async function showHandOffMenu(issues, score) {
  if (issues.length === 0) {
    p.log.success(chalk.green("Nothing to hand off — codebase looks healthy!"));
    return;
  }

  const reportPath = path.resolve(REPORT_FILE);
  const agentPrompt = buildAgentPrompt(issues, reportPath);

  console.log();

  const choice = await p.select({
    message: chalk.bold("What do you want to do with these issues?"),
    options: [
      {
        value: "claude",
        label: chalk.cyan.bold("Send to Claude Code"),
        hint: "runs `claude -p \"...\"` right here in your shell — it reads the report and fixes the files",
      },
      {
        value: "clipboard",
        label: chalk.magenta.bold("Copy prompt to clipboard"),
        hint: "paste into Cursor, ChatGPT, Claude.ai, or any AI assistant",
      },
      {
        value: "print",
        label: chalk.yellow.bold("Print prompt in terminal"),
        hint: "show the full agent prompt so you can read or copy it manually",
      },
      {
        value: "skip",
        label: chalk.dim("Skip"),
        hint: "exit — report is saved to " + chalk.white(".orm-doctor-report.json"),
      },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  console.log();

  switch (choice) {
    case "claude":
      handOffToClaude(agentPrompt);
      break;
    case "clipboard":
      await copyToClipboard(agentPrompt);
      break;
    case "print":
      printPrompt(agentPrompt);
      p.log.info(chalk.dim("Report also saved to: ") + chalk.cyan(reportPath));
      break;
    case "skip":
      p.log.info(chalk.dim("Report saved to: ") + chalk.cyan(reportPath));
      break;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCLIArgs();

  if (args.showVersion) { console.log(`orm-doctor v${VERSION}`); process.exit(0); }
  if (args.showHelp)    { console.log(HELP_TEXT);                process.exit(0); }

  const resolvedProject = path.resolve(args.projectPath);
  if (!fs.existsSync(resolvedProject)) {
    console.error(chalk.red(`Error: path does not exist — ${resolvedProject}`));
    process.exit(1);
  }

  // ── CI / JSON mode ───────────────────────────────────────────────────────
  if (args.jsonMode) {
    const schema = args.schemaPath ?? args.projectPath;
    const [allNP1, allIdx, allSeed, allAdvanced] = await Promise.all([
      scanForNPlusOne(args.projectPath),
      scanForMissingIndexes(schema),
      scanSeedFiles(args.projectPath),
      runAdvancedScans(args.projectPath, schema),
    ]);
    const issues = [...allNP1, ...allIdx, ...allSeed, ...allAdvanced].filter((i) => !isDeadCode(i.file));
    const total  = issues.reduce((s, i) => s + i.penalty, 0);
    const score  = Math.max(0, 100 - total);
    const stack  = detectStack(args.projectPath, schema);
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectPath: resolvedProject,
      stack, score, totalPenalty: total, issueCount: issues.length, issues,
    }, null, 2));
    process.exit(issues.some((i) => i.severity === "critical") ? 1 : 0);
  }

  // ── Interactive mode ─────────────────────────────────────────────────────
  console.log();
  p.intro(
    chalk.bgMagenta.white.bold("  orm-doctor  ") +
    chalk.dim(`  v${VERSION}  ·  ORM & database static analyser  ·  by `) +
    chalk.magenta("NoctisNova") +
    chalk.dim("  noctisnova.com")
  );

  if (args.schemaPath) {
    p.log.info(chalk.dim("Schema  ") + chalk.white(path.resolve(args.schemaPath)));
  }

  console.log();

  // ── Multi-phase scan ─────────────────────────────────────────────────────
  let scanResult;
  try {
    scanResult = await runPhasedScans({
      projectPath: args.projectPath,
      schemaPath:  args.schemaPath ?? args.projectPath,
    });
  } catch (err) {
    p.log.error(chalk.red(err.message));
    p.outro(chalk.red("orm-doctor encountered an error."));
    process.exit(1);
  }

  const { issues, score, totalPenalty, stack } = scanResult;

  // ── Score reveal animation ────────────────────────────────────────────────
  console.log();
  await animateScoreReveal(score);

  // ── Detected stack line ───────────────────────────────────────────────────
  const stackLine = renderStackLine(stack);
  if (stackLine) console.log(stackLine);

  // ── Full dashboard ────────────────────────────────────────────────────────
  console.log(
    renderDashboard({
      score,
      totalPenalty,
      issues,
      projectPath: args.projectPath,
    })
  );

  // ── Agent hand-off ────────────────────────────────────────────────────────
  if (!args.noAi) {
    await showHandOffMenu(issues, score);
  } else {
    p.log.info(chalk.dim("Report saved to: ") + chalk.cyan(path.resolve(REPORT_FILE)));
  }

  // ── Outro ──────────────────────────────────────────────────────────────────
  const hasCritical = issues.some((i) => i.severity === "critical");
  console.log();
  p.outro(
    hasCritical
      ? chalk.yellow("Fix the critical issues and run orm-doctor again.")
      : chalk.green("Your ORM usage looks solid. Keep it that way.")
  );

  process.exit(hasCritical ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(chalk.red("\nUnexpected error:"), err.message ?? err);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
