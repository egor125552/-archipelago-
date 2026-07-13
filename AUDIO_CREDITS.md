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
