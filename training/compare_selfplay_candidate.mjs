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

function metrics(report) {
  const results = report?.results || [];
  const byLevel = {};
  let pressureTotal = 0;
  let stationaryTotal = 0;
  let invalidWaterTotal = 0;
  let mechanicalFailures = 0;
  for (const result of results) {
    const level = Number(result.level) || 0;
    byLevel[level] ||= {battles: 0, victories: 0, timeouts: 0, teamWipes: 0, pressure: 0};
    const group = byLevel[level];
    group.battles += 1;
    if (result.outcome === "victory") group.victories += 1;
    if (result.outcome === "timeout") group.timeouts += 1;
    if (result.outcome === "team-wipe") group.teamWipes += 1;
    const value = pressure(result);
    group.pressure += value;
    pressureTotal += value;
    stationaryTotal += Number(result.metrics?.stationaryRatio) || 0;
    invalidWaterTotal += Number(result.metrics?.invalidWaterRatio) || 0;
    if (result.mechanicalFailures?.length) mechanicalFailures += 1;
  }
  for (const group of Object.values(byLevel)) group.meanPressure = group.battles ? group.pressure / group.battles : 0;
  return {
    battles: results.length,
    byLevel,
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

  const levelFiveBefore = base.byLevel[5];
  const levelFiveAfter = candidate.byLevel[5];
  if (levelFiveBefore && levelFiveAfter) {
    const beforeResolved = (levelFiveBefore.victories + levelFiveBefore.teamWipes) / Math.max(1, levelFiveBefore.battles);
    const afterResolved = (levelFiveAfter.victories + levelFiveAfter.teamWipes) / Math.max(1, levelFiveAfter.battles);
    if (afterResolved + 0.02 < beforeResolved) failures.push("threat-five-resolution-regressed");
  }

  return {
    format: "echo-neural-selfplay-candidate-comparison-v1",
    generatedAt: new Date().toISOString(),
    verdict: failures.length ? "rejected" : "candidate-acceptable-for-manual-review",
    failures,
    base,
    candidate,
    critique: [
      "Passing this gate does not enable the model in ordinary play; it only means the candidate did not regress the selected held-out mechanics and outcome limits.",
      "The same scripted-player family is used for generation and evaluation, although held-out seeds are separate, so strategic overfitting remains possible.",
      "Mean pressure can hide uneven difficulty. Lower threat levels therefore have a separate over-lethality rejection rule.",
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
  console.log(JSON.stringify({output, verdict: report.verdict, failures: report.failures}, null, 2));
  if (report.verdict === "rejected") process.exitCode = 4;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
