import {mkdir, readFile, writeFile} from "node:fs/promises";
import process from "node:process";

const HEADS = Object.freeze(["throttle", "steering", "range", "route", "fire"]);
const MIN_ELIGIBLE_PER_HEAD = 80;
const MIN_POSITIVE_PER_HEAD = 8;
const MIN_POSITIVE_VALUES_PER_HEAD = 2;
const ACCEPTANCE_THRESHOLD = "2.5";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

export function assessNeuralV2TrainingReadiness(aggregate) {
  const failures = [];
  const headReadiness = {};
  if (aggregate?.verdict !== "complete-diagnostic-batch") failures.push("diagnostic-batch-not-complete");
  if (Array.isArray(aggregate?.trainingEligiblePairs) && aggregate.trainingEligiblePairs.length) {
    failures.push("diagnostic-artifact-already-contains-training-labels");
  }

  for (const head of HEADS) {
    const stats = aggregate?.headStats?.[head] || {};
    const eligible = Number(stats.eligible) || 0;
    const positives = Number(stats.thresholds?.[ACCEPTANCE_THRESHOLD]) || 0;
    const positiveValues = Object.entries(aggregate?.valueStats || {})
      .filter(([key, value]) => key.startsWith(`${head}:`) && Number(value?.thresholds?.[ACCEPTANCE_THRESHOLD]) > 0)
      .map(([key]) => Number(key.split(":")[1]))
      .filter(Number.isInteger);
    const reasons = [];
    if (eligible < MIN_ELIGIBLE_PER_HEAD) reasons.push(`eligible-${eligible}-below-${MIN_ELIGIBLE_PER_HEAD}`);
    if (positives < MIN_POSITIVE_PER_HEAD) reasons.push(`positives-${positives}-below-${MIN_POSITIVE_PER_HEAD}`);
    if (new Set(positiveValues).size < MIN_POSITIVE_VALUES_PER_HEAD) {
      reasons.push(`positive-values-${new Set(positiveValues).size}-below-${MIN_POSITIVE_VALUES_PER_HEAD}`);
    }
    headReadiness[head] = {
      eligible,
      positives,
      positiveValues: [...new Set(positiveValues)].sort((left, right) => left - right),
      ready: reasons.length === 0,
      reasons,
    };
    for (const reason of reasons) failures.push(`${head}:${reason}`);
  }

  const dominant = HEADS
    .map(head => ({head, positives: headReadiness[head].positives}))
    .sort((left, right) => right.positives - left.positives);
  const totalPositives = dominant.reduce((sum, item) => sum + item.positives, 0);
  if (totalPositives > 0 && dominant[0].positives / totalPositives > 0.6) {
    failures.push(`positive-evidence-dominated-by-${dominant[0].head}`);
  }

  return {
    format: "echo-neural-v2-training-readiness-v1",
    generatedAt: new Date().toISOString(),
    sourceFormat: aggregate?.format || null,
    acceptanceThreshold: Number(ACCEPTANCE_THRESHOLD),
    requirements: {
      minimumEligiblePairsPerHead: MIN_ELIGIBLE_PER_HEAD,
      minimumPositivePairsPerHead: MIN_POSITIVE_PER_HEAD,
      minimumPositiveValuesPerHead: MIN_POSITIVE_VALUES_PER_HEAD,
      maximumSingleHeadPositiveShare: 0.6,
    },
    headReadiness,
    totalPositives,
    failures,
    verdict: failures.length ? "not-ready-for-training" : "ready-for-masked-trainer-development",
    trainingAllowed: failures.length === 0,
    critique: [
      "This gate assesses whether a trainer may be developed; it does not train, export or enable a model.",
      "Passing requires evidence across every head and more than one value, not one unusually large combat outlier.",
      "Scenario and human-play diversity remain additional manual requirements even after this numerical gate passes.",
    ],
  };
}

async function main() {
  const input = argument("input", "training/reports/v2-head-diagnostics-aggregate.json");
  const output = argument("output", "training/reports/v2-training-readiness.json");
  const aggregate = JSON.parse(await readFile(input, "utf8"));
  const report = assessNeuralV2TrainingReadiness(aggregate);
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", {recursive: true});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    verdict: report.verdict,
    trainingAllowed: report.trainingAllowed,
    totalPositives: report.totalPositives,
    failures: report.failures,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
