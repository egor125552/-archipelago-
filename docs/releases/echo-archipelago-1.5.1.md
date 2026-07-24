# Echo Archipelago 1.5.1

Release date: 2026-07-24

## Scenario fixes

- Restores the original recorded starting-pistol shot.
- Preserves the contract-board navigation destination from the browser through the server simulation.
- Prevents an unextracted salvage object from being loaded directly from a boat.
- Makes salvage dismantling accessible on iPhone: one action starts crowbar work, progress continues while the player stays nearby, movement pauses the work, and pickup or loading requires a separate action after completion.
- Keeps physical combat targets available throughout an active threat even when the current ranged weapon has no ammunition.

## Merchant and progression

- Adds a complete dock service that restores the owned boat's hull, flooding, leaks, engine state and emergency timers.
- Adds three-level permanent upgrades purchased with team scrap: hull reinforcement, pump improvement, engine improvement and leak sealing.

## Heavy threat balance

- Sets the heavy pursuer to 700 hull in solo play and 1000 hull in cooperative play.
- Strengthens the turret and engine systems.
- Replaces the short burst with a telegraphed, finite 28-shot barrage followed by a reload.

## Browser delivery

- Bumps the free-roam entry, pistol audio wrapper, core, replication, target-menu, shop and heavy-pursuer cache versions so Safari does not retain the previous mechanics.
- Adds regression coverage for iPhone salvage interaction, board navigation, merchant service and upgrades, empty-ammo combat targeting, heavy-threat durability, sustained fire and the recorded pistol module.
