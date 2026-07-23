import test from "node:test";
import assert from "node:assert/strict";
import {readdir, readFile, stat} from "node:fs/promises";
import {extname, relative} from "node:path";

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".json", ".md", ".yml", ".yaml", ".toml", ".rs", ".sh", ".txt"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".wrangler", "dist", "coverage", "test-results", "playwright-report"]);

async function walk(dir = ".") {
  const files = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function lineCount(text) {
  if (!text.length) return 0;
  return text.split(/\r?\n/).length;
}

function category(path) {
  if (path.startsWith("tests/")) return "tests";
  if (path.startsWith("public/")) return "client_public";
  if (path.startsWith("src/")) return "server_src";
  if (path.startsWith("scripts/")) return "scripts";
  if (path.startsWith(".github/")) return "github_ci";
  return "root_and_docs";
}

test("temporary repository line-count audit", async () => {
  const files = await walk();
  const rows = [];
  for (const path of files) {
    const text = await readFile(path, "utf8");
    rows.push({path, lines: lineCount(text), bytes: Buffer.byteLength(text), category: category(path), ext: extname(path) || "none"});
  }
  const sum = list => list.reduce((total, row) => total + row.lines, 0);
  const byCategory = {};
  for (const row of rows) {
    byCategory[row.category] ||= {files: 0, lines: 0, bytes: 0};
    byCategory[row.category].files += 1;
    byCategory[row.category].lines += row.lines;
    byCategory[row.category].bytes += row.bytes;
  }
  const runtimeExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".rs"]);
  const runtime = rows.filter(row => runtimeExtensions.has(row.ext));
  const nonTests = rows.filter(row => !row.path.startsWith("tests/"));
  const runtimeNoTests = runtime.filter(row => !row.path.startsWith("tests/") && !row.path.startsWith(".github/") && !row.path.startsWith("scripts/"));
  const report = {
    commit: process.env.GITHUB_SHA || null,
    allText: {files: rows.length, lines: sum(rows), bytes: rows.reduce((n, r) => n + r.bytes, 0)},
    nonTestsAllText: {files: nonTests.length, lines: sum(nonTests)},
    runtimeCodeNoTests: {files: runtimeNoTests.length, lines: sum(runtimeNoTests)},
    clientPublic: byCategory.client_public || {files: 0, lines: 0, bytes: 0},
    serverSrc: byCategory.server_src || {files: 0, lines: 0, bytes: 0},
    tests: byCategory.tests || {files: 0, lines: 0, bytes: 0},
    scripts: byCategory.scripts || {files: 0, lines: 0, bytes: 0},
    githubCi: byCategory.github_ci || {files: 0, lines: 0, bytes: 0},
    rootAndDocs: byCategory.root_and_docs || {files: 0, lines: 0, bytes: 0},
    largestRuntimeFiles: runtimeNoTests.sort((a, b) => b.lines - a.lines).slice(0, 20),
    categories: byCategory,
  };
  console.log(`LINE_COUNT_REPORT_BEGIN${JSON.stringify(report)}LINE_COUNT_REPORT_END`);
  assert.ok(report.runtimeCodeNoTests.lines > 0);
});