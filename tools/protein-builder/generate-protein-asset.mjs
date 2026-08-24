#!/usr/bin/env node
// Generate the semantic protein asset and deterministic coarse-grained thermal modes.
import { readFile, writeFile } from 'node:fs/promises';

const configFile = process.argv[2] ?? 'assets-src/proteins/5i4r/protein.config.json';
const config = JSON.parse(await readFile(configFile, 'utf8'));
const semantic = JSON.parse(await readFile(config.semanticAsset, 'utf8'));
const backbone = JSON.parse(await readFile(config.source, 'utf8'));
const COMPONENT_COUNT = semantic.components.length;
const CONTACT_CUTOFF = 12;
const HESSIAN_SIZE = COMPONENT_COUNT * 3;
const EPSILON = 1e-12;

const round = (value) => {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
};
const distanceSquared = (a, b) => {
  const dx = a[0] - b[0]; const dy = a[1] - b[1]; const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};
function outerUnit(a, b) {
  const unitLength = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (unitLength <= EPSILON) return null;
  const unit = [(b[0] - a[0]) / unitLength, (b[1] - a[1]) / unitLength, (b[2] - a[2]) / unitLength];
  return unit.map((row) => unit.map((column) => row * column));
}
function addBlock(matrix, rowComponent, columnComponent, block, scale) {
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
    matrix[rowComponent * 3 + row][columnComponent * 3 + column] += block[row][column] * scale;
  }
}

// Deterministic, plain-JS symmetric Jacobi eigensolver. Columns of vectors are eigenvectors.
function jacobiEigenvaluesAndVectors(input) {
  const matrix = input.map((row) => [...row]);
  const vectors = Array.from({ length: HESSIAN_SIZE }, (_, row) =>
    Array.from({ length: HESSIAN_SIZE }, (_, column) => (row === column ? 1 : 0)));
  const maxIterations = HESSIAN_SIZE * HESSIAN_SIZE * 100;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let p = 0; let q = 1; let largest = 0;
    for (let row = 0; row < HESSIAN_SIZE; row += 1) for (let column = row + 1; column < HESSIAN_SIZE; column += 1) {
      if (Math.abs(matrix[row][column]) > largest) { largest = Math.abs(matrix[row][column]); p = row; q = column; }
    }
    if (largest <= 1e-10) break;
    const app = matrix[p][p]; const aqq = matrix[q][q]; const apq = matrix[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = (tau < 0 ? -1 : 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t); const s = t * c;
    matrix[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    matrix[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    matrix[p][q] = 0; matrix[q][p] = 0;
    for (let k = 0; k < HESSIAN_SIZE; k += 1) {
      if (k === p || k === q) continue;
      const akp = matrix[k][p]; const akq = matrix[k][q];
      matrix[k][p] = c * akp - s * akq; matrix[p][k] = matrix[k][p];
      matrix[k][q] = s * akp + c * akq; matrix[q][k] = matrix[k][q];
    }
    for (let k = 0; k < HESSIAN_SIZE; k += 1) {
      const vkp = vectors[k][p]; const vkq = vectors[k][q];
      vectors[k][p] = c * vkp - s * vkq; vectors[k][q] = s * vkp + c * vkq;
    }
  }
  return matrix.map((row, index) => ({ value: row[index], vector: vectors.map((values) => values[index]) }));
}

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
function buildModes(points) {
  const hessian = Array.from({ length: HESSIAN_SIZE }, () => Array(HESSIAN_SIZE).fill(0));
  const cutoffSquared = CONTACT_CUTOFF * CONTACT_CUTOFF;
  for (let first = 0; first < points.length; first += 1) for (let second = first + 1; second < points.length; second += 1) {
    const left = points[first]; const right = points[second];
    if (left.componentIndex === right.componentIndex || distanceSquared(left.point, right.point) > cutoffSquared) continue;
    const block = outerUnit(left.point, right.point);
    if (!block) continue;
    addBlock(hessian, left.componentIndex, left.componentIndex, block, 1);
    addBlock(hessian, right.componentIndex, right.componentIndex, block, 1);
    addBlock(hessian, left.componentIndex, right.componentIndex, block, -1);
    addBlock(hessian, right.componentIndex, left.componentIndex, block, -1);
  }
  const eigenpairs = jacobiEigenvaluesAndVectors(hessian);
  const largestEigenvalue = Math.max(...eigenpairs.map((pair) => Math.abs(pair.value)), 1);
  const threshold = Math.max(1e-10, largestEigenvalue * 1e-10);
  const positive = eigenpairs.filter((pair) => pair.value > threshold).sort((left, right) => left.value - right.value);
  // A one-component asset has no internal elastic modes. Its three rigid translations are
  // still valid overdamped Brownian coordinates when the visual is treated as weakly confined.
  if (positive.length === 0 && COMPONENT_COUNT === 1) {
    return [
      { id: 'rigid-translation-x', translation: [1, 0, 0] },
      { id: 'rigid-translation-y', translation: [0, 1, 0] },
      { id: 'rigid-translation-z', translation: [0, 0, 1] },
    ].map(({ id, translation }) => ({
      id,
      relaxationRate: 0.6,
      rmsAmplitude: 0.16,
      components: [{ componentId: semantic.components[0].id, translation }],
    }));
  }
  if (positive.length === 0) throw new Error('elastic network has no positive modes');
  const slowest = positive[0].value;
  return positive.slice(0, Math.min(4, positive.length)).map((pair, modeIndex) => {
    const relative = pair.value / slowest;
    const translations = []; let maxLength = 0;
    for (let componentIndex = 0; componentIndex < COMPONENT_COUNT; componentIndex += 1) {
      const translation = pair.vector.slice(componentIndex * 3, componentIndex * 3 + 3);
      maxLength = Math.max(maxLength, Math.hypot(...translation)); translations.push(translation);
    }
    const scale = maxLength > EPSILON ? 1 / maxLength : 1;
    const normalized = translations.map((translation) => translation.map((value) => value * scale));
    let largestIndex = 0;
    for (let index = 1; index < HESSIAN_SIZE; index += 1) {
      const candidate = Math.abs(normalized[Math.floor(index / 3)][index % 3]);
      const current = Math.abs(normalized[Math.floor(largestIndex / 3)][largestIndex % 3]);
      if (candidate > current) largestIndex = index;
    }
    if (normalized[Math.floor(largestIndex / 3)][largestIndex % 3] < 0) for (const translation of normalized) for (let index = 0; index < 3; index += 1) translation[index] *= -1;
    return {
      id: `mode-${modeIndex + 1}`,
      relaxationRate: round(Math.min(2.4, 0.45 * relative)),
      rmsAmplitude: round(Math.max(0.35, 1.2 / Math.sqrt(relative))),
      components: normalized.map((translation, componentIndex) => ({ componentId: semantic.components[componentIndex].id, translation: translation.map(round) })),
    };
  });
}

const { points, centroids } = componentMembership();
const motion = { model: 'overdamped-normal-modes', sampleHz: 30, visualGain: 4, modes: buildModes(points) };
const output = {
  ...semantic,
  source: { ...semantic.source, structureFile: config.source },
  components: semantic.components,
  sites: semantic.sites.map((site) => ({ ...site, componentId: nearestComponent(site.position, centroids) })),
  modificationSlots: semantic.modificationSlots.map((slot) => ({ ...slot, componentId: nearestComponent(slot.position, centroids) })),
  motion,
  generated: {
    ...semantic.generated,
    backend: 'existing-backbone',
    backboneCount: backbone.backboneCount,
    secondaryKinds: [...new Set(backbone.backboneSecondary)],
    chains: [...new Set(backbone.backboneChains)],
    entities: [...new Set(backbone.backboneEntities)],
    modalDerivation: {
      ...semantic.generated?.modalDerivation,
      model: COMPONENT_COUNT === 1
        ? 'confined-rigid-body-brownian-translation'
        : 'rigid-domain-anisotropic-elastic-network',
      contactCutoffAngstrom: CONTACT_CUTOFF,
      modeCount: motion.modes.length,
    },
  },
};
const outputFile = process.argv[3] ?? config.semanticAsset;
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`);
console.log(`generated ${outputFile} from ${config.source} (${motion.modes.length} normal modes)`);
