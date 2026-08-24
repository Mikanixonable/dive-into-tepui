#!/usr/bin/env node
// Generate the semantic protein asset. Runtime thermal motion is generated separately
// as the residue-level ProteinMotionAsset.
import { readFile, writeFile } from 'node:fs/promises';

const positionalArguments = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const checkOnly = process.argv.includes('--check');
const configFile = positionalArguments[0] ?? 'assets-src/proteins/5i4r/protein.config.json';
const config = JSON.parse(await readFile(configFile, 'utf8'));
if (!config.definitionAsset) throw new Error(`${configFile}: definitionAsset is required`);
const semantic = JSON.parse(await readFile(config.definitionAsset, 'utf8'));
const backbone = JSON.parse(await readFile(config.source, 'utf8'));
const distanceSquared = (a, b) => {
  const dx = a[0] - b[0]; const dy = a[1] - b[1]; const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

function componentMembership() {
  const byEntity = new Map();
  semantic.components.forEach((component, index) => {
    for (const entity of component.entities ?? []) if (!byEntity.has(entity)) byEntity.set(entity, index);
  });
  const points = [];
  const centroids = semantic.components.map(() => ({ sum: [0, 0, 0], count: 0 }));
  const coordinates = backbone.backboneCoordinates ?? [];
  const entities = backbone.backboneEntities ?? [];
  for (let pointIndex = 0; pointIndex < Math.floor(coordinates.length / 3); pointIndex += 1) {
    const componentIndex = byEntity.get(entities[pointIndex]);
    if (componentIndex === undefined) continue;
    const point = [coordinates[pointIndex * 3], coordinates[pointIndex * 3 + 1], coordinates[pointIndex * 3 + 2]];
    points.push({ point, componentIndex });
    const centroid = centroids[componentIndex];
    centroid.sum[0] += point[0]; centroid.sum[1] += point[1]; centroid.sum[2] += point[2]; centroid.count += 1;
  }
  if (points.length === 0 || centroids.some((centroid) => centroid.count === 0)) throw new Error('backbone has no coordinates for one or more semantic components');
  return { points, centroids: centroids.map((centroid) => centroid.sum.map((value) => value / centroid.count)) };
}
function nearestComponent(position, centroids) {
  let nearest = 0; let nearestDistance = Number.POSITIVE_INFINITY;
  centroids.forEach((centroid, index) => {
    const currentDistance = distanceSquared(position, centroid);
    if (currentDistance < nearestDistance) { nearest = index; nearestDistance = currentDistance; }
  });
  return semantic.components[nearest].id;
}
const { centroids } = componentMembership();
const output = {
  ...semantic,
  source: { ...semantic.source, structureFile: config.source },
  components: semantic.components,
  sites: semantic.sites.map((site) => ({ ...site, componentId: nearestComponent(site.position, centroids) })),
  modificationSlots: semantic.modificationSlots.map((slot) => ({ ...slot, componentId: nearestComponent(slot.position, centroids) })),
  generated: {
    ...semantic.generated,
    backend: 'existing-backbone',
    backboneCount: backbone.backboneCount,
    secondaryKinds: [...new Set(backbone.backboneSecondary)],
    chains: [...new Set(backbone.backboneChains)],
    entities: [...new Set(backbone.backboneEntities)],
  },
};
const outputFile = positionalArguments[1] ?? config.semanticAsset;
const serializedOutput = `${JSON.stringify(output, null, 2)}\n`;
if (checkOnly) {
  const existing = await readFile(outputFile, 'utf8');
  if (existing !== serializedOutput) {
    console.error(`${configFile}: generated output differs from ${outputFile}`);
    process.exitCode = 1;
  } else {
    console.log(`${configFile}: ${outputFile} is up to date`);
  }
} else {
  await writeFile(outputFile, serializedOutput);
  console.log(`generated ${outputFile} from ${config.source}`);
}
