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

## 2026-08-01 — Water guard, separate heavy turret and real-server simulator

### What changed

- Low-confidence neural movement is no longer silently discarded in neural-only mode.
- Boat targets located on land are redirected to the production shore-access corridor.
- A boundary guard prevents neural boats from leaving navigable water and a stuck escape can rotate a blocked actor.
- The heavy hull and heavy turret are separate neural actors. The turret receives a latched fire permission long enough to finish its production wind-up and burst.
- A distributed simulator now executes `createServerFreeRoom`, `startServerTrainingBattle`, `applyServerFreeInput` and `tickServerFreeRoom` for every battle.
- Threat-five reports fail when a healthy heavy turret never winds up or fires.
- The neural settings panel can finish the current fight and download the persisted ZIP archive.

### What is still weak or heuristic

- The water guard is not learned intelligence. It can make a bad policy look less broken by preventing illegal movement.
- Shore redirection uses a fixed safe corridor. It does not plan around other boats, projectiles, ramming angles or congestion.
- The stuck escape is a deterministic emergency turn, not a neural decision.
- The heavy-turret fire threshold and latch duration are manually calibrated. They repair activation but do not prove good target timing.
- Scripted simulation players are repetitive and exploitable. A policy can overfit their turns and still fail against a person.
- The simulator uses the authoritative server mechanics but does not include WebSocket delay, browser input jitter, speech queues, deployment restarts or Durable Object migration.
- Running one million evaluations does not retrain the generated model. A separate dataset and training pipeline are still required.
- Downloading the current fight currently returns the room archive, not a server-produced ZIP containing only one selected episode.

### Automatic rejection conditions

- Any neural-control sample is missing while neural-only mode is active.
- Any controlled enemy boat leaves the navigable water bounds.
- A healthy threat-five turret remains available for a meaningful interval but never winds up or fires.
- Shards report fewer completed battles than requested while the aggregate is presented as complete.
- The report omits the limitations above.

## Required format for the next change

Add another dated section with:

1. exact behaviour changed;
2. defect or misleading claim in the previous version;
3. new tests and their blind spots;
4. metrics that became better or worse;
5. remaining reason not to enable the model in ordinary play.
