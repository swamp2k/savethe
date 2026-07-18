/**
 * 3D trophy models: species -> GLB in public/models/. Purely cosmetic and
 * client-side — the server knows nothing about assets. Species without a
 * model (or whose model fails to load) fall back to the emoji stage.
 *
 * Adding an animal: drop `<species>.glb` into public/models/ (self-contained,
 * textures embedded — see public/models/README.md) and list the species here.
 */
const MODELED_SPECIES = new Set([
  'bear',
  'beaver',
  'bee',
  'bunny',
  'cat',
  'caterpillar',
  'cow',
  'crab',
  'deer',
  'dog',
  'duck',
  'elephant',
  'fish',
  'fox',
  'giraffe',
  'hog',
  'koala',
  'lion',
  'monkey',
  'panda',
  'parrot',
  'penguin',
  'pig',
  'tiger',
]);

/** Animation clip names present in the Kenney Cube Pets rigs. */
export type PlushieAnimation =
  | 'idle'
  | 'dance'
  | 'walk'
  | 'run'
  | 'eat'
  | 'gesture-positive'
  | 'gesture-negative';

export function modelFor(species: string): string | undefined {
  return MODELED_SPECIES.has(species) ? `/models/${species}.glb` : undefined;
}

/** A random species that definitely has a model — for purely cosmetic
 *  client-side casting (e.g. Obstacle Run's runner). */
export function randomModeledSpecies(): string {
  const all = [...MODELED_SPECIES];
  return all[Math.floor(Math.random() * all.length)];
}
