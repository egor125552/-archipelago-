# Audio credits

The gameplay/navigation cue set remains unchanged from the existing project. Version 6 replaces the ambient sea, motorboat, pump, hull impact and warning layers with the following recordings.

- **Beach/Ocean Ambience** — IanStarGem, Freesound sound 271097, CC0 1.0. Mirrored as `ambient_clear_water.mp3` in `yuryAB/Mermaid`.
- **Motorboat Engine** — chungus43A, Freesound sound 609616, CC0 1.0. Mirrored as `boat_muffled_pass.mp3` in `yuryAB/Mermaid`.
- **Floor standing hand pump, air release, 2x short bursts** — ZapSplat, Attribution 4.0. Mirrored in the source project as `HandCrank.mp3` in `evilbocchi/eternal-empire` and used for the bilge-pump layer.
- **Siren Loudspeakers Sound Warning Systems SPb 2021 01** — Summerson, Freesound sound 591197, CC BY 3.0. Mirrored as `tsunami_siren.ogg` in `dsheedes/cd_easytime`.
- **Hatch Seal.wav** — paul368, Freesound sound 264063, CC0 1.0. Mirrored as `hatch_close1.ogg` in `Aurorastation/Aurora.3` and used as the hull impact layer.

Source metadata and attribution files are preserved in the upstream repositories referenced by `public/src/audio-engine-v6.js`.

Version 10 ships the navigation-critical water layers locally so a temporary CDN or CORS failure cannot silently remove them.

- **[Stream](https://freesound.org/people/mystiscool/sounds/7138/)** — mystiscool, CC BY. The seamless OGG mirror is from [Muges/ambientsounds](https://github.com/Muges/ambientsounds) and is stored as `public/assets/audio/river-ambience.ogg`.
- **Water loops 01 and 02** — [lavenderdotpet/CC0-Public-Domain-Sounds](https://github.com/lavenderdotpet/CC0-Public-Domain-Sounds), CC0 1.0. Stored as `bilge-water.ogg` and `boat-wake.ogg`.

Version 25 adds local MP3 effects for salvage, combat and the injury mix. They are stored in `public/assets/audio/free-roam-v25/` and were normalized during conversion for consistent in-game loudness.

## Sonniss GDC 2026 Game Audio Bundle

The bundle readme describes these files as royalty-free for personal and commercial use without attribution. The original `License - GDC Game Audio.pdf` and `Readme.txt` remain in the user's downloaded bundle.

- **344 Audio — Cinematic Fight Vol. 1**: `FGHTImpt_4 x Punch, Body 02` → `punch-body-set.mp3`.
- **344 Audio — Elemental Palette Designed Vol. 1**: `WATRMisc_Water, Liquid Impact, Bubble, Sci Fi, Hit 04` → `swim-impact.mp3`.
- **David Dumais Audio — Melee Weapons Sound Effects Pack 2**: an excerpt from `SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01` → `swing-heavy.mp3`.
- **Epic Stock Media — Public Spaces: Storms, Lakes, Parks and Rural Nature Exteriors**: `WATRLap_Summer Tennessee Lake Dock Water Ripples Wake Wave Gentle 05 Distant` → `lake-water.mp3`.

## Local combat prototypes

The following effects were supplied by the user from the local `fighter-game` and `ATOMIC HEART EDITION` projects.

- `fighter-game/public/sounds/`: heartbeat, death sequence, light swing, hit feedback, three punches, heavy punch, knife draw and three knife hits.
- `ATOMIC HEART EDITION/Resources/Audio/`: automatic shot, enemy hit and four footsteps.

Those source projects do not state an audio redistribution license in their readmes. Before publishing this repository or distributing a build, confirm that these recordings may be redistributed. The implementation intentionally records their provenance here instead of claiming a license that is not present in the source folders.

## Version 1.1 pistol shot

The starting pistol uses a deterministic Web Audio buffer generated in `public/src/free-roam-pistol-audio.js`. Its short dry envelope, low/mid body, high-frequency crack and two restrained reflections were tuned after comparing several short pistol-shot references. No third-party pistol recording is embedded in the repository, and the sound is recreated locally by the browser before play.
