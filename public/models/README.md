# Trophy models

One self-contained `.glb` per plushie species, named `<species>.glb` (species
ids live in `src/server/engine/plushies.ts`). Rendered by `PlushieShowcase`
on the client only; species without a file here fall back to their emoji.

To add one:

1. Drop `<species>.glb` in this folder. It must be self-contained (textures
   embedded). Kenney packs ship GLBs referencing an external
   `Textures/colormap.png` — embed it first, e.g. with a small repack script
   or `gltf-transform copy in.glb out.glb`.
2. Add the species to `MODELED_SPECIES` in `src/client/models.ts`.
3. If the rig's animation clips aren't the Kenney Cube Pets set
   (`idle`, `dance`, `walk`, `run`, `eat`, …), check what `PlushieShowcase`
   requests — an unknown clip name means the model just holds its base pose.

Current models are the full [Kenney — Cube Pets](https://kenney.nl/assets/cube-pets)
pack (CC0), with the colormap embedded. Species mapping is 1:1 by name except
bear → polar bear and duck → chick. Species without a model (frog, turtle,
octopus, unicorn) intentionally stay emoji-only.
