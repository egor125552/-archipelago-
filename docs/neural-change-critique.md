# Neural controller change critique

This document is deliberately written as a rejection checklist, not as release marketing. Every neural-control change must add a dated section covering what improved, what remains fake or heuristic, which measurements could be misleading, and what evidence would justify promotion.

## 2026-08-01 — Initial neural-only test mode

### What changed

- A GRU policy was allowed to choose one of five movement classes and a binary fire decision.
- The policy could be enabled only inside an exact production threat 2–5 training world.

### What was wrong with my implementation

- I described the mode too confidently as “only neural”, while movement decisions below a confidence threshold silently fell back to production behaviour.
- The model had only 1,472 validation frames. That is nowhere near enough evidence for a varied water-and-shore combat game.
- The feature vector had no explicit shoreline route, safe water corridor, landing state, turret component state, collision forecast, or stuck duration.
- The controller wrote positions after the production physics step. This can hide collision and navigation defects rather than teaching the model to solve them.
- The heavy hull and heavy turret were represented as one actor. A movement decision could therefore cancel the turret wind-up repeatedly.
- The original A/B harness used only eight short scenarios and mostly measured damage pressure. It could not detect “looks confused in water” reliably.

### Evidence required before ordinary play

- Recorded human and adversarial scripted battles across all threat levels.
- Separate shoreline, open-water, damaged-boat, target-on-land and heavy-turret evaluations.
- A held-out dataset that was never used for tuning.
- Comparison against production AI for success, fairness, stuck time, water legality and player damage distribution.

## 2026-08-01 — Water guard, separate heavy turret and authoritative simulator

### What changed

- Low-confidence neural movement is no longer silently discarded in neural-only mode.
- Boat targets located on land are redirected to the production shore-access corridor.
- A boundary guard prevents neural boats from leaving navigable water and a stuck escape can rotate a blocked actor.
- The heavy hull and heavy turret are separate neural actors. The turret receives a latched fire permission long enough to finish its production wind-up and burst.
- If the current model never permits the heavy turret to fire, test mode opens one explicitly marked exploration window after several seconds so the production turret can generate a real aim-and-burst sample instead of remaining permanently silent.
- A distributed simulator executes `createServerFreeRoom`, `startServerTrainingBattle`, `applyServerFreeInput` and `tickServerFreeRoom` for every simulation.
- The neural settings panel can finish the current fight and download the persisted ZIP archive.
- Recorded frames now include compact neural decisions, confidence, raw and effective fire, exploration markers and cumulative guardrail diagnostics.

### What the first 1,024-run report proved

- Exactly 1,024 requested short windows were completed across eight shards.
- No neural-control samples were missing and no controlled enemy boats crossed the configured water bounds.
- All 256 level-five windows exposed an active heavy turret; each produced one wind-up and five shots, for 256 wind-ups and 1,280 shots total.
- The production game emitted 563 `contract-threat-cleared` events during those windows.

### What was wrong with my first report

- I called twelve-second windows “battles”. They were useful mechanical probes, but level-five encounters were still active at the end and they were not full episodes.
- The victory counter looked for a generic victory name instead of the real production event `contract-threat-cleared`, so it incorrectly reported zero victories despite 563 clears.
- A zero stationary ratio and zero water-boundary ratio only showed that the post-physics controller kept moving entities inside its guardrails. They did not prove sensible tactics.
- The report did not distinguish mechanical failures from policy-quality findings such as timeouts and team wipes.
- A workflow input of one million battles implied that one ordinary GitHub Actions run could finish a million full episodes. That is not a credible compute claim.

### Corrections after the report

- The simulator now has explicit `window` and `episode` profiles.
- The episode profile runs until production victory, simultaneous team wipe or a clearly recorded timeout, with a default cap of ninety simulated seconds.
- Victory is counted only from the real production clear event or cleared threat state.
- Mechanical rejection and policy-quality findings are reported separately.
- Million-scale work is represented as an accountable multi-batch campaign. Each artifact states its exact battle-index range; requested ranges cannot be silently skipped or duplicated.

### What is still weak or heuristic

- The water guard is not learned intelligence. It can make a bad policy look less broken by preventing illegal movement.
- Shore redirection uses a fixed safe corridor. It does not plan around other boats, projectiles, ramming angles or congestion.
- The stuck escape is a deterministic emergency turn, not a neural decision.
- The heavy-turret fire threshold, latch duration and exploration interval are manually calibrated. The exploration window deliberately overrides a repeatedly negative model decision; it is useful for collecting data but must not be presented as learned skill.
- Scripted simulation players are repetitive and exploitable. A policy can overfit their turns and still fail against a person.
- The simulator uses the authoritative server mechanics but runs them in GitHub compute, not through deployed WebSockets and Durable Object scheduling. It does not include network delay, browser input jitter, speech queues, deployment restarts or migration.
- Running one million evaluations does not retrain the generated model. A separate dataset and training pipeline are still required.
- Downloading the current fight returns the room archive, not a server-produced ZIP containing only one selected episode.
- The archive contains decision probabilities and diagnostics, but it still does not contain full hidden-state tensors or every pre-softmax logit. It is enough to audit actions, not to reconstruct the GRU numerically bit-for-bit.

### Automatic rejection conditions

- Any neural-control sample is missing while neural-only mode is active.
- Any controlled enemy boat leaves the navigable water bounds.
- A healthy threat-five turret remains available for a meaningful interval but never winds up or fires.
- Shards report fewer completed simulations than requested or omit an index in the declared batch range.
- A short window is presented as a completed full battle.
- The report omits timeouts, team wipes or the limitations above.

## 2026-08-01 — Exploratory self-play candidate training

### Exact behaviour changed

- Authoritative server battles can now perturb a small fraction of movement and fire decisions only inside the offline self-play generator.
- Every explored action stores the exact forty-value policy input, the base action, the selected action, confidence, fire probability, actor role and timestamp.
- Each shard retains its highest-scoring complete trajectories separately for threats two, three, four and five instead of saving millions of nearly duplicate frames.
- The candidate is fine-tuned from the checked-in quantized GRU rather than initialized randomly.
- A parameter anchor penalizes large weight drift from the current model.
- The unchanged base model and candidate are evaluated in separate processes on identical held-out authoritative episodes.
- The candidate is rejected for mechanical failures, water regression, increased stationary behaviour, more timeouts, reduced pressure, excessive lethality in threats two or three, or worse threat-five resolution.
- The old archive-training workflow no longer has write permission and no longer pushes a model directly to `main`.

### Defect in the previous version

- The simulation pipeline evaluated the same fixed policy repeatedly. A million evaluations could measure the policy but could not change a single weight.
- The original trainer learned from player input in room archives, while the deployed tactical GRU was being used to control enemy actors. That domain mismatch could reward labels that were irrelevant to enemy navigation.
- Offline imitation metrics were treated as sufficient for publishing a candidate. They did not establish that server combat improved.
- Automatic pushing to `main` made a validation mistake capable of changing production weights without a held-out battle comparison.

### New tests and their blind spots

- Unit tests verify scoring, per-level elite selection and mandatory rejection of water regressions.
- The self-play workflow runs repository tests with candidate weights installed only in the temporary CI checkout.
- Held-out evaluation uses different battle indices and random seeds from trajectory collection.
- The blind spot remains that generation and evaluation share the same family of scripted players. A candidate can learn their rhythm without becoming generally intelligent.
- Elite-only cross-entropy training is not a full reinforcement-learning objective. Failed exploratory actions are summarized but are not used as explicit negative samples.

### Metrics that can become better or worse

- Better: fewer full-episode timeouts, lower stationary ratio, fewer guardrail interventions, higher threat-five resolution and useful pressure without lower-level over-lethality.
- Worse: a candidate may imitate lucky aggressive actions, increase difficulty unevenly, depend more heavily on water clamps, or reduce tactical diversity despite higher average pressure.
- A successful CI verdict means only `candidate-acceptable-for-manual-review`; it is intentionally not called trained, promoted or production-ready.

### Remaining reason not to enable the model in ordinary play

- No self-play candidate has yet passed the new end-to-end workflow.
- Human battle archives remain too small, especially for swimming, shoreline congestion, damaged boats and heavy-turret component play.
- The five movement classes are still coarse and cannot express throttle, turn rate, formation spacing, collision forecast or landing plans independently.
- Million-scale training is an indexed multi-batch campaign. A declared target of one million is not completion evidence until artifacts cover every range without gaps.

## Required format for the next change

Add another dated section with:

1. exact behaviour changed;
2. defect or misleading claim in the previous version;
3. new tests and their blind spots;
4. metrics that became better or worse;
5. remaining reason not to enable the model in ordinary play.
