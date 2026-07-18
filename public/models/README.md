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

Current models are from [Kenney — Cube Pets](https://kenney.nl/assets/cube-pets)
(CC0), with the colormap embedded. Species mapping: bear → polar bear,
duck → chick; bunny/penguin/cat are direct.
