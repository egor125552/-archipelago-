import {readFile, writeFile} from "node:fs/promises";
import process from "node:process";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function pressure(result) {
  const state = result?.result || {};
  return (100 - (Number(state.playerHealth) || 0))
    + (100 - (Number(state.boatHull) || 0)) * 0.72
    + (Number(state.boatWater) || 0) * 0.35;
}

function addGroup(groups, key, result, value) {
  groups[key] ||= {battles: 0, victories: 0, timeouts: 0, teamWipes: 0, pressure: 0};
  const group = groups[key];
  group.battles += 1;
  if (result.outcome === "victory") group.victories += 1;
  if (result.outcome === "timeout") group.timeouts += 1;
  if (result.outcome === "team-wipe") group.teamWipes += 1;
  group.pressure += value;
}

function finishGroups(groups) {
  for (const group of Object.values(groups)) group.meanPressure = group.battles ? group.pressure / group.battles : 0;
  return groups;
}

function metrics(report) {
  const results = report?.results || [];
  const byLevel = {};
  const byScenario = {};
  let pressureTotal = 0;
  let stationaryTotal = 0;
  let invalidWaterTotal = 0;
  let mechanicalFailures = 0;
  for (const result of results) {
    const level = Number(result.level) || 0;
    const value = pressure(result);
    addGroup(byLevel, String(level), result, value);
    const scenarioKey = `${level}:${result.script || "unknown"}:${result.coop ? "coop" : "solo"}`;
    addGroup(byScenario, scenarioKey, result, value);
    pressureTotal += value;
    stationaryTotal += Number(result.metrics?.stationaryRatio) || 0;
    invalidWaterTotal += Number(result.metrics?.invalidWaterRatio) || 0;
    if (result.mechanicalFailures?.length) mechanicalFailures += 1;
  }
  finishGroups(byLevel);
  finishGroups(byScenario);
  return {
    battles: results.length,
    byLevel,
    byScenario,
    mechanicalFailures,
    meanPressure: results.length ? pressureTotal / results.length : 0,
    meanStationaryRatio: results.length ? stationaryTotal / results.length : 0,
    meanInvalidWaterRatio: results.length ? invalidWaterTotal / results.length : 0,
    timeouts: results.filter(item => item.outcome === "timeout").length,
    teamWipes: results.filter(item => item.outcome === "team-wipe").length,
    victories: results.filter(item => item.outcome === "victory").length,
  };
}

export function compareCandidate(baseReport, candidateReport) {
  const base = metrics(baseReport);
  const candidate = metrics(candidateReport);
  const failures = [];
  if (!base.battles || candidate.battles !== base.battles) failures.push("held-out-battle-count-mismatch");
  if (candidate.mechanicalFailures) failures.push("candidate-mechanical-failure");
  if (candidate.meanInvalidWaterRatio > base.meanInvalidWaterRatio + 0.00001) failures.push("water-legality-regressed");
  if (candidate.meanStationaryRatio > Math.max(base.meanStationaryRatio * 1.18, base.meanStationaryRatio + 0.035)) failures.push("stationary-ratio-regressed");
  if (candidate.timeouts > base.timeouts) failures.push("timeouts-increased");
  if (candidate.meanPressure < base.meanPressure * 0.97) failures.push("enemy-pressure-regressed");

  for (const level of [2, 3]) {
    const before = base.byLevel[level];
    const after = candidate.byLevel[level];
    if (!before || !after || !before.battles) continue;
    const beforeWipeRate = before.teamWipes / before.battles;
    const afterWipeRate = after.teamWipes / after.battles;
    if (afterWipeRate > beforeWipeRate + 0.16) failures.push(`lower-threat-overlethal-${level}`);
  }

  for (const [key, before] of Object.entries(base.byScenario)) {
    const after = candidate.byScenario[key];
    if (!after || after.battles !== before.battles) {
      failures.push(`scenario-missing-${key}`);
      continue;
    }
    if (after.timeouts > before.timeouts) failures.push(`scenario-timeouts-increased-${key}`);
    const pressureDrop = before.meanPressure - after.meanPressure;
    if (before.meanPressure >= 4 && pressureDrop >= 3 && after.meanPressure < before.meanPressure * 0.75) {
      failures.push(`scenario-pressure-regressed-${key}`);
    }
  }

  const levelFiveBefore = base.byLevel[5];
  const levelFiveAfter = candidate.byLevel[5];
  let threatFiveResolutionImproved = false;
  if (levelFiveBefore && levelFiveAfter) {
    const beforeResolved = (levelFiveBefore.victories + levelFiveBefore.teamWipes) / Math.max(1, levelFiveBefore.battles);
    const afterResolved = (levelFiveAfter.victories + levelFiveAfter.teamWipes) / Math.max(1, levelFiveAfter.battles);
    if (afterResolved + 0.02 < beforeResolved) failures.push("threat-five-resolution-regressed");
    threatFiveResolutionImproved = afterResolved >= beforeResolved + 0.04
      || levelFiveAfter.teamWipes > levelFiveBefore.teamWipes;
  }

  const improvement = {
    fewerTimeouts: candidate.timeouts < base.timeouts,
    pressureAtLeastTwoPercentHigher: candidate.meanPressure >= Math.max(base.meanPressure * 1.02, base.meanPressure + 0.5),
    threatFiveResolutionImproved,
  };
  improvement.measurable = Object.values(improvement).some(Boolean);
  if (!improvement.measurable) failures.push("no-measurable-held-out-improvement");

  return {
    format: "echo-neural-selfplay-candidate-comparison-v1",
    generatedAt: new Date().toISOString(),
    verdict: failures.length ? "rejected" : "candidate-acceptable-for-manual-review",
    failures,
    improvement,
    base,
    candidate,
    critique: [
      "Passing this gate does not enable the model in ordinary play; it requires a measurable held-out improvement while respecting mechanics and fairness limits.",
      "Aggregate gains cannot hide a large pressure loss in one threat/script/solo-or-co-op scenario.",
      "The same scripted-player family is used for generation and evaluation, although held-out seeds are separate, so strategic overfitting remains possible.",
      "Human battles and a room archive remain necessary before any final promotion decision.",
    ],
  };
}

async function main() {
  const basePath = argument("base", "training/reports/selfplay-baseline-evaluation.json");
  const candidatePath = argument("candidate", "training/reports/selfplay-candidate-evaluation.json");
  const output = argument("output", "training/reports/selfplay-candidate-comparison.json");
  const base = JSON.parse(await readFile(basePath, "utf8"));
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  const report = compareCandidate(base, candidate);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({output, verdict: report.verdict, failures: report.failures, improvement: report.improvement}, null, 2));
  if (report.verdict === "rejected") process.exitCode = 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
