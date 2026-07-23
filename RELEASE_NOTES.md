# Echo Archipelago 1.1.2

Release date: 2026-07-23

## Reserve boat visibility

- A solo server room no longer leaves the absent second player's boat beside the starting boat.
- Boats for players who have never connected remain dormant, sunk and outside the playable world, so they cannot be heard, boarded, collided with or attached to a tow line.
- A player's boat is activated and placed near the existing player only when that player actually joins the room.
- Reconnecting players keep their existing boat position, cargo, hull state and other progress instead of having the boat placed again.

## Verification

- Added regression coverage for an empty room, solo start, second-player activation and reconnect preservation.
- Full Node, two-client browser and Cloudflare Worker checks run before merge.
- A physical iPhone still requires manual confirmation that no unexplained reserve boat is audible or towable at the solo start.

---

# Echo Archipelago 1.1.1

Release date: 2026-07-23

## iPhone guidance

- The opening salvage objective now uses touch instructions on iPhone: touch with two fingers for sonar and touch once with one finger for the contextual action.
- Desktop players continue to receive the existing `Q` and `F` keyboard instructions.

## Held ranged fire

- Holding three fingers now directly holds the attack input for both the pistol and the automatic weapon.
- Firing begins while the fingers remain on the screen instead of being delayed until release.
- Releasing any finger stops fire immediately and no longer triggers a second delayed heavy-attack pulse.

## Connection recovery

- Automatic WebSocket recovery now refuses an accidentally created replacement world when the previous socket still occupies the player's role for a brief moment.
- The client retries the original room and role instead of restarting the scenario at “deliver two ordinary crates”.
- Existing cargo, scenario progress and authoritative world state remain in the original room.

## Verification

- Node mechanics and regression tests passed.
- Two-client browser scenarios passed.
- The mobile WebKit scenario passed.
- The Cloudflare Worker bundle validation passed.
- A physical iPhone and a real unstable mobile connection still require manual confirmation.

---

# Echo Archipelago 1.1.0

Release date: 2026-07-23

## Starting pistol

- Every free-roam player now starts with a pistol and 36 pistol rounds.
- Pistol ammunition is separate from automatic ammunition and is replicated by the authoritative Cloudflare world.
- `Z` and the existing two-finger sideways gesture include the pistol in the normal weapon cycle.
- The pistol uses the same target selection and attack input as the automatic weapon.
- Holding three fingers fires either ranged weapon and releasing any finger stops firing immediately.
- The pistol deals 6 damage every 0.34 seconds. The automatic remains the stronger objective weapon at 11 damage every 0.13 seconds.
- The pistol uses a short recorded Colt .45 shot with a locally generated Web Audio fallback if the recording cannot be loaded.
- Target selection is available whenever either the pistol or automatic has ammunition.

## Compatibility

The 1.0 scenario, cargo loop, automatic crate, server-authoritative simulation, custom gestures and saved interface settings remain compatible. Version 1.1 adds one weapon type without replacing the existing progression.

---

# Echo Archipelago 1.0.0

Release date: 2026-07-22

## What 1.0.0 is

Echo Archipelago is an audio-first browser game built around boat handling, spatial navigation, cooperative play, cargo operations, survival systems and physical combat. The main release mode is Free Roam: a persistent shared bay for one or two players with a finite salvage-and-pursuit scenario followed by unrestricted exploration.

## Main features

- Server-authoritative multiplayer world hosted through Cloudflare Durable Objects.
- Two independent players and boats, reconnect support and persistent room state.
- Boat acceleration, inertia, braking, steering, collisions, towing and sinking.
- Walking, running, swimming, shore transitions, boarding and boat-roof movement.
- Cargo discovery, carrying, transfer, loading, delivery, loot and trophy recovery.
- Fuel, hull damage, flooding, pumping, emergency recovery and repair plates.
- Fists, knife and automatic weapon with ammunition, physical bullets, damage, knockdown, death and respawn.
- Marauder encounter, three physical pursuer boats and hostile gunners who can continue combat on shore.
- Finite victory condition with a spoken completion message, followed by an open-ended free world.
- Sonar navigation with spoken distance and direction, arrival signals and one-shot heading alignment.
- Spatial audio and local game speech designed for play without VoiceOver enabled.
- Keyboard controls on desktop and custom touch gestures on iPhone.

## Accessibility model

VoiceOver is supported for opening the page and creating or joining a world. Actual iPhone gameplay is designed for VoiceOver off, using the game's own gestures, speech and spatial sound. Desktop gameplay uses the keyboard. Full gameplay through VoiceOver itself is not claimed as a 1.0 requirement.

## Development path

Development began on 2026-07-13 with a minimal repository and an accessible Echo Archipelago prototype. The first phase established the mobile interface, layered audio, multiplayer transport, boat simulation, survival systems, rescue missions, finite bay navigation and regression tests.

The project then expanded into a larger operations campaign with persistent progression, upgrades, wrecks, pursuit, hunters, shoreline damage, fuel management and browser-level verification.

On 2026-07-18 the focus shifted to Free Roam. Cargo, shore movement, towing, melee and automatic combat, death and respawn, room reconnection and the staged salvage-to-pursuit scenario were added and repeatedly stabilized.

On 2026-07-19 the encounter grew into a physical three-boat pursuer squad with projectiles, collision damage, one-time rewards and a complete victory condition.

The final phase on 2026-07-21 and 2026-07-22 concentrated on iPhone gesture safety, target selection, sonar guidance, trophy unloading, server authority, network replication, speech reliability, map removal, separated runtime loops, release diagnostics and the final knife-navigation fixes.

The 1.0 version bump was committed as `462ba0cca7ea1003fd509dc3f1177239e13deef1`.

## Verification

The repository contains unit, regression, browser and end-to-end tests for major mechanics. GitHub did not report a separate status check for the final direct-to-main release commit. Manual iPhone testing confirmed custom gestures, game speech, the scenario completion flow and post-victory knife guidance. The last post-victory change only altered sonar target priority and did not modify cargo delivery or combat systems.

## Release policy

Version 1.0.0 is the first stable feature-complete release. Future changes should be treated as maintenance fixes or explicitly scoped additions rather than reopening the core design.
