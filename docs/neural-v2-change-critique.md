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

A test-only authoritative server override translates v2 actions into production-world movement and fire permission. It runs after the v1 test controller only when a simulator explicitly installs an override. It is non-enumerable, is not part of the saved world and is cleared when a training battle starts or finishes.

The later causal discovery mode changes exactly one v2 head over the unchanged v1 controller. The other four heads remain under v1 and do not receive labels. This replaced the first five-head-at-once discovery design because one shared battle score could not identify which head caused a gain.

## Bugs found while building v2

- Boolean `fire: true` was initially converted to hold fire because it passed through string-class lookup. Fixed and tested.
- `safe_water` was initially replaced implicitly by `shore_gate` for a land target. Fixed so route heads are executed literally.
- Override diagnostics were initially deleted when a macro ended. Action removal now preserves diagnostics until scoring.
- The final recorded macro sample was initially removed before the following authoritative tick. Removal now happens after that tick and the before/after controlled-frame counters are stored.
- Water clamps were recorded as `waterClampFrames` but the shared score expected `waterGuardInterventions`. v2 now exposes the compatible counter so clamps reduce the score.
- Missing previous-action history initially looked like the default `cruise/straight/medium/safe_water` action. Missing history now encodes as five zeros and has dedicated tests.
- Metadata-only history such as `{source: "no-action"}` also initially triggered the default manoeuvre. Only actual action-head fields now establish previous history.
- The discovery generator initially passed the current v2 action into the previous-action slots. Current labels are now excluded from their own inputs.
- The first mechanical-effect test required a stationary steering actor to change position. Steering had changed its heading correctly, but zero speed made zero positional change legitimate. Head tests now require the physical quantity owned by that head: steering must change heading, throttle must change speed and fire must change only fire permission.

## Rejected first v2 discovery artifact

The first completed discovery workflow reported 256 identical-seed pairs and 512 authoritative rollouts, with two pairs above the 2.5-point advantage threshold. That artifact is **rejected and must never be used for training**.

The numerical pair and shard counts were real, but semantic inspection found two invalid properties:

- every retained sample encoded the fake default previous action instead of absent history;
- explored override diagnostics were empty, so water clamps did not receive the intended score penalty.

The two apparent positive pairs therefore do not establish useful v2 behaviour. The shard format was advanced from `echo-neural-v2-pairs-v1` to `echo-neural-v2-pairs-v2`; the aggregate rejects the obsolete format and requires semantic integrity summaries from every shard.

## Rejected clean five-head discovery evidence

A corrected five-head batch completed 256 identical-seed pairs and 512 authoritative rollouts with no integrity failure. Only two pairs, 0.78%, exceeded the unchanged 2.5-point threshold.

Both selected fire, direct route and hard-left steering while changing all five heads together. One merely prolonged a shoreline battle while causing more player-boat damage; the other produced one additional hit. Because all heads changed together, neither pair identifies whether throttle, steering, range, route or fire caused the difference. This valid artifact remains diagnostic evidence only and is not training data.

## Single-head causal discovery result

The replacement workflow changed exactly one head per explored rollout while baseline and explored worlds shared the same production seed. It completed 256 pairs and 512 authoritative rollouts with all five heads represented and all integrity checks passing.

The result contained **zero pairs at or above the unchanged 2.5-point acceptance threshold**. The best single-head result was 2.454. The threshold was not lowered and no trainer was created.

This result established that the broad five-head candidates were not hiding an immediately reusable set of causal labels. It did not establish that every head was mechanically inert, because a short change can alter a trajectory and later reconverge to the same full-episode score.

## Expanded 1,024-pair diagnostic result

The expanded diagnostic workflow completed 1,024 identical-seed single-head pairs, which means 2,048 authoritative server rollouts. It retained near misses for inspection but structurally forbade training labels.

Integrity evidence:

- 340 fully eligible interventions;
- 340 completed interventions with final authoritative-tick proof;
- 340 isolated-head application proofs;
- 3,951 sampled frames;
- zero training-eligible labels emitted by the diagnostic workflow.

The full-episode result was sharply imbalanced:

- **throttle:** 66 eligible pairs, maximum advantage 37.362, three pairs at or above 2.0 and two at or above 2.5;
- **steering:** 67 eligible pairs, every final-episode advantage exactly zero;
- **range:** 72 eligible pairs, every final-episode advantage exactly zero;
- **route:** 68 eligible pairs, every final-episode advantage exactly zero;
- **fire:** 67 eligible pairs, maximum advantage 0.035 and none at or above 1.0.

The largest throttle result was a threat-five cooperative damage-control timeout. Full throttle on one interceptor increased enemy hits from 57 to 64 and reduced the player's boat hull from 100 to 56.4, producing a +37.362 score outlier. That is increased lethality, not broad tactical intelligence. A second throttle result added one enemy hit and reduced player health. These isolated examples cannot justify training a throttle head, much less all five heads.

## Strict readiness decision

The numerical readiness gate does not train, export or enable a model. It permits development of a masked trainer only when every head has:

- at least 80 eligible paired examples;
- at least eight examples above the unchanged 2.5 threshold;
- positive evidence for at least two values;
- no single head owning more than 60% of all positive evidence.

The current evidence fails this gate. Throttle has two positive outliers concentrated in one value; steering, range, route and fire have zero accepted examples. The verdict is `not-ready-for-training`.

## Mechanical-effect telemetry

Full-episode score alone can hide whether a head failed to execute or executed and later reconverged. The override therefore records per-head physical effects:

- controlled frames and changed frames;
- accumulated heading delta;
- accumulated speed delta;
- accumulated position delta;
- fire-allowed and fire-suppressed frames;
- whether the isolated fire decision differed from v1.

Steering tests require measured heading change, throttle tests require measured speed change and fire tests require no v2 movement replacement. A zero full-episode score can now be separated into either a mechanically ineffective action or a real short-lived trajectory change with no durable combat result.

## What remains heuristic or weak

- The server override still writes actor position after the production mechanics step. It can therefore mask an action that would have collided or failed under a fully native controller.
- Throttle scales, turn offsets, preferred ranges, role speeds and the shore gate are hand-written translations, not learned values.
- The score is hand-designed from outcome, damage pressure and guardrail counts. It can reward increased player damage that is unfair rather than intelligent.
- Full-episode scoring can erase short-lived geometric improvements after v1 control resumes. A separate paired short-horizon observation is still needed before interpreting zero steering, range or route scores as useless actions.
- Scripted players do not represent human timing, VoiceOver input, WebSocket delay, speech queues, Durable Object restarts or weak-client behaviour.
- The 53-feature schema has no learned map memory, multi-step route plan, projectile time-to-impact, ally formation objective or explicit landing sequence state machine.
- No v2 neural weights, multi-head model or inference runtime exist yet. Current v2 work is a schema, feature extractor, test override, paired discovery pipeline, diagnostic pipeline and rejection gate.

## Current discovery gate

A discovery batch is valid only when:

- every declared shard exists exactly once;
- completed pair counts match the exact indexed range;
- authoritative rollout count is exactly twice the pair count;
- baseline and explored outcome totals each equal the local pair count;
- every pair has finite override diagnostics, including the water-guard counter used by scoring;
- all recorded previous-action feature slots are zero in the one-macro discovery format;
- every fully completed intervention proves that controlled frames increased after its last recorded sample;
- every single-head intervention proves that only its selected head was applied;
- every retained sample has exactly 53 finite features;
- each retained sample carries one named head and one in-range value rather than labels for all five heads;
- obsolete or semantically invalid shard formats are rejected;
- zero positive pairs is accepted as a truthful result instead of lowering the advantage threshold.

A pull-request batch uses 256 identical-seed pairs, which means 512 authoritative server rollouts. Expanded diagnostics use 1,024 pairs and 2,048 rollouts. Manual workflows can cover larger indexed ranges, but each artifact proves only its own range. A declared target of one million pairs is not a completed million-pair campaign.

## Evidence required before training a v2 candidate

- A complete single-head paired aggregate with broad coverage across threats 2–5, water, shoreline, damage-control, aggressive and solo/co-op scenarios.
- At least the readiness-gate minimum for every head and at least two values per head.
- Short-horizon paired evidence showing that steering, range and route actions have measurable, correctly directed geometric effects even when full-episode scores reconverge.
- Positive pairs that are not concentrated in one threat, one actor role, one value or increased player lethality.
- Low reliance on post-step water clamps and route redirection.
- A separate masked multi-head trainer with episode-level validation and no current-label leakage.
- Identical held-out authoritative A/B against the unchanged v1 model, with scenario-specific rejection rather than aggregate-only acceptance.
- Manual review of downloadable battle records before any candidate can be considered for ordinary play.
