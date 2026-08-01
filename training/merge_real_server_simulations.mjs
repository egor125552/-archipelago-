import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import process from "node:process";

import {summarizeBattles} from "./run_real_server_simulations.mjs";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

async function jsonFiles(root) {
  const entries = await readdir(root, {withFileTypes: true});
  const result = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await jsonFiles(path));
    else if (entry.name.endsWith(".json")) result.push(path);
  }
  return result;
}

function markdown(report) {
  const summary = report.summary;
  const failures = Object.entries(summary.byFailure || {})
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `- ${name}: ${count}`)
    .join("\n") || "- none";
  const critique = (summary.critique || []).map(item => `- ${item}`).join("\n");
  return `# Neural real-server simulation critique

Generated: ${summary.generatedAt}

## Run truth

- Requested battles: ${summary.requestedBattles}
- Completed battles: ${summary.completedBattles}
- Failed mechanical checks: ${summary.failedBattles}
- Level-five battles: ${summary.heavyLevelFiveBattles}
- Level-five battles where the ready heavy turret never activated: ${summary.heavyTurretFailedBattles}
- Mean stationary ratio: ${summary.meanStationaryRatio.toFixed(5)}
- Mean invalid-water ratio: ${summary.meanInvalidWaterRatio.toFixed(5)}
- Verdict: **${summary.verdict}**

## Mechanical failures

${failures}

## Required self-critique

${critique}

## What this report cannot prove

This report is intentionally not called training success. It can reject a mechanically broken controller. It cannot prove that the policy is clever, enjoyable, fair, human-like, or ready for ordinary play. A model promotion requires recorded human battles, a held-out evaluation set, adversarial shoreline scenarios, and an explicit comparison against the production AI.
`;
}

async function main() {
  const input = argument("input", "training/reports/shards");
  const output = argument("output", "training/reports/real-server-aggregate.json");
  const critiqueOutput = argument("critique-output", "training/reports/real-server-critique.md");
  const files = await jsonFiles(input);
  const results = [];
  let requestedBattles = 0;
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed.results)) continue;
    results.push(...parsed.results);
    requestedBattles = Math.max(requestedBattles, Number(parsed.summary?.requestedBattles) || 0);
  }
  results.sort((left, right) => Number(left.battleIndex) - Number(right.battleIndex));
  const unique = [];
  const seen = new Set();
  for (const result of results) {
    const key = Number(result.battleIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }
  const summary = summarizeBattles(unique, requestedBattles || unique.length);
  const report = {summary, results: unique};
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(critiqueOutput, markdown(report));
  console.log(JSON.stringify({
    output,
    critiqueOutput,
    requestedBattles: summary.requestedBattles,
    completedBattles: summary.completedBattles,
    verdict: summary.verdict,
  }, null, 2));
  if (summary.completedBattles !== summary.requestedBattles || summary.verdict === "rejected") process.exitCode = 4;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
