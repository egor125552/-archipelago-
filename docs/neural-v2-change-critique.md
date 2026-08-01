# Neural policy v2 change critique

This document is a rejection-oriented engineering record. It is not a claim that the game now contains an intelligent neural opponent.

## Why v1 fine-tuning was stopped

The checked-in v1 policy has five movement classes (`hold`, `approach`, `retreat`, `flank_left`, `flank_right`) and one binary fire output. Those outputs cannot independently express throttle, turn strength, desired combat range, water routing, landing approach, collision avoidance or weapon timing.

Three candidate paths were rejected:

1. **Whole-trajectory elite cloning** increased aggregate pressure but hid a large regression in the held-out `5:shoreline:solo` scenario. It did not reduce any of the 14 held-out timeouts.
2. **Scenario-diverse elite cloning** reproduced nearly the same candidate because unchanged old-policy decisions dominated each retained trajectory. The data did not identify which explored action caused the improvement.
3. **Identical-seed macro cloning** used one coherent v1 macro per pair and a hard trust region. The candidate still increased held-out timeouts from 14 to 16 and regressed in `4:damage-control:coop`, `5:water-escape:coop` and `5:shoreline:solo`. Movement accuracy on held-out explored frames was only 10%, and no held-out fire exploration frame was available.

No rejected candidate was written to `main`, enabled in ordinary play or described as trained successfully.

## What v2 changes

Policy v2 defines five independent action heads:

- throttle: stop, slow, cruise, full;
- steering: hard left, left, straight, right, hard right;
- preferred range: close, medium, far, disengage;
- route: direct, safe water, shore gate;
- fire: hold fire, fire.

The v2 state has 53 features, including water-boundary distances, a local vector to the legal shore gate, target mode and land/water state, collision sectors, hull and flooding state, engine and turret state, aiming/burst state, threat level and explicitly validated previous-action fields.

A test-only authoritative server override translates a selected five-head action into production-world movement and fire permission. It runs after the v1 test controller only when a simulator explicitly installs an override. It is non-enumerable, is not part of the saved world and is cleared when a training battle starts or finishes.

## Bugs found while building v2

- Boolean `fire: true` was initially converted to hold fire because it passed through string-class lookup. Fixed and tested.
- `safe_water` was initially replaced implicitly by `shore_gate` for a land target. Fixed so route heads are executed literally.
- Override diagnostics were initially deleted when a macro ended. Action removal now preserves diagnostics until scoring.
- The final recorded macro sample was initially removed before the following authoritative tick. Removal now happens after that tick.
- Water clamps were recorded as `waterClampFrames` but the shared score expected `waterGuardInterventions`. v2 now exposes the compatible alias so clamps reduce the score.
- Missing previous-action history initially looked like the default `cruise/straight/medium/safe_water` action. Missing history now encodes as five zeros and has dedicated tests.
- The discovery generator initially passed the current v2 action into the previous-action slots. Current labels are now excluded from their own inputs.

## What remains heuristic or weak

- The server override still writes actor position after the production mechanics step. It can therefore mask an action that would have collided or failed under a fully native controller.
- Throttle scales, turn offsets, preferred ranges, role speeds and the shore gate are hand-written translations, not learned values.
- A full five-head action is changed at once. A positive paired outcome cannot yet identify which individual head caused the gain.
- The score is hand-designed from outcome, damage pressure and guardrail counts. It may reward behaviour that feels unfair or tactically foolish.
- Scripted players do not represent human timing, VoiceOver input, WebSocket delay, speech queues, Durable Object restarts or weak-client behaviour.
- The 53-feature schema has no learned map memory, multi-step route plan, projectile time-to-impact, ally formation objective or explicit landing sequence state machine.
- No v2 neural weights, multi-head model or inference runtime exist yet. Current v2 work is a schema, feature extractor, test override and paired discovery pipeline.

## Current discovery gate

A discovery batch is valid only when:

- every declared shard exists exactly once;
- completed pair counts match the exact indexed range;
- authoritative rollout count is exactly twice the pair count;
- baseline and explored outcome totals each equal the local pair count;
- every retained sample has exactly 53 finite features;
- every retained action has five in-range head indices;
- water and route interventions survive action removal and affect scoring;
- zero positive pairs is accepted as a truthful result instead of lowering the advantage threshold.

A pull-request batch uses 256 identical-seed pairs, which means 512 authoritative server rollouts. The manual workflow can cover larger indexed ranges, but each artifact proves only its own range. A declared target of one million pairs is not a completed million-pair campaign.

## Evidence required before training a v2 candidate

- A complete paired discovery aggregate with sufficient coverage across threats 2–5, water, shoreline, damage-control, aggressive and solo/co-op scenarios.
- Positive pairs that are not concentrated in one threat, one actor role or one action-head pattern.
- Low reliance on post-step water clamps and route redirection.
- A separate multi-head trainer with episode-level validation and no current-label leakage.
- Identical held-out authoritative A/B against the unchanged v1 model, with scenario-specific rejection rather than aggregate-only acceptance.
- Manual review of downloadable battle records before any candidate can be considered for ordinary play.
