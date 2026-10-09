import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shuffled } from './screen-space-blind-order.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = path.join(root, '.render-lab-shots', 'ssd-8-blind');
const workDir = path.join(shotDir, 'work');
const keyDir = path.join(workDir, 'keys');
const privateKeyPath = path.join(keyDir, 'all-scenes-key.json');
const sourceKeyPath = path.join(keyDir, 'key.json');
const sourceViewerPath = path.join(shotDir, 'viewer-data.json');
const templatePath = path.join(root, 'tools', 'render-lab', 'ssd-blind-viewer.html');

const sourceKey = JSON.parse(readFileSync(sourceKeyPath, 'utf8'));
const sourceViewer = JSON.parse(readFileSync(sourceViewerPath, 'utf8'));
const scenes = sourceKey.scenes.map(({ id }) => id);
const originalByScene = new Map(scenes.map((scene) => [scene, []]));
for (const set of sourceKey.assignments) {
  for (const [symbol, candidate] of Object.entries(set.bySymbol)) {
    originalByScene.get(set.scene)?.push({
      budget: set.budget,
      variant: candidate.variant,
      stimulusId: candidate.stimulusId,
    });
  }
}

// 隣り合う 2 つの候補が同じ方式か同じ予算か。
const sameSource = (a, b) => a.variant === b.variant || a.budget === b.budget;

function createPrivateKey() {
  const seed = randomBytes(32).toString('hex');
  const assignments = [];
  for (const scene of scenes) {
    const candidates = originalByScene.get(scene) ?? [];
    if (candidates.length !== 12) throw new Error(`${scene} must have 12 source candidates`);
    const ids = new Set(candidates.map(({ stimulusId }) => stimulusId));
    if (ids.size !== 12) throw new Error(`${scene} has duplicate source candidate IDs`);
    for (const [index, candidate] of shuffled(candidates, seed, scene, sameSource).entries()) {
      assignments.push({ scene, label: String(index + 1).padStart(2, '0'), ...candidate });
    }
  }
  return {
    createdAt: new Date().toISOString(),
    randomizationSeed: seed,
    rule: 'Independent seeded shuffle per scene; adjacent entries cannot share a source method or budget.',
    sourceKeyPath: 'work/keys/key.json',
    assignments,
  };
}

function validatePrivateKey(key) {
  if (!Array.isArray(key.assignments) || typeof key.randomizationSeed !== 'string') {
    throw new Error('all-scenes private key has an invalid shape');
  }
  const sourcePairs = new Set(sourceKey.assignments.flatMap((set) => Object.values(set.bySymbol)
    .map(({ variant, stimulusId }) => `${set.scene}|${set.budget}|${variant}|${stimulusId}`)));
  const foundPairs = new Set();
  for (const scene of scenes) {
    const rows = key.assignments.filter((item) => item.scene === scene);
    const labels = new Set(rows.map((item) => item.label));
    if (rows.length !== 12 || labels.size !== 12) throw new Error(`${scene} must have labels 01..12 exactly once`);
    for (let index = 0; index < rows.length; index++) {
      const item = rows[index];
      if (item.label !== String(index + 1).padStart(2, '0')) throw new Error(`${scene} key rows must be ordered by label`);
      const previous = rows[index - 1];
      if (previous && sameSource(previous, item)) {
        throw new Error(`${scene} has adjacent source categories in its blind label order`);
      }
      const pair = `${item.scene}|${item.budget}|${item.variant}|${item.stimulusId}`;
      if (!sourcePairs.has(pair) || foundPairs.has(pair)) throw new Error(`invalid or duplicate source assignment: ${pair}`);
      foundPairs.add(pair);
    }
  }
  if (foundPairs.size !== sourcePairs.size) throw new Error('private key does not cover every source candidate');
}

mkdirSync(keyDir, { recursive: true });
const privateKey = existsSync(privateKeyPath)
  ? JSON.parse(readFileSync(privateKeyPath, 'utf8'))
  : createPrivateKey();
validatePrivateKey(privateKey);
if (!existsSync(privateKeyPath)) writeFileSync(privateKeyPath, `${JSON.stringify(privateKey, null, 2)}\n`, { flag: 'wx' });

const sourceImages = new Map((sourceViewer.pngs ?? sourceViewer.images)
  .map((item) => [`${item.stimulusId}|${item.view}`, item.path]));
function referenceOf(scene) {
  if (Array.isArray(sourceViewer.assignments)) {
    return sourceViewer.assignments.find((item) => item.scene === scene)?.reference ?? null;
  }
  const referenceId = sourceViewer.sets.find((item) => item.scene === scene)?.referenceId;
  return sourceViewer.pngs.find((image) => image.view === 'B' && image.stimulusId === referenceId) ?? null;
}
const candidateViews = ['first', 'second', 'mean', 'deviation0', 'deviation1', 'variance'];
const publicData = {
  scenes,
  labels: Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0')),
  views: candidateViews,
  assignments: scenes.map((scene) => ({
    scene,
    candidates: privateKey.assignments.filter((item) => item.scene === scene)
      .map(({ label, stimulusId }) => ({ label, stimulusId })),
    reference: null,
  })),
  images: [],
};

const outputImages = new Map();
for (const assignment of publicData.assignments) {
  const privateRows = privateKey.assignments.filter((item) => item.scene === assignment.scene);
  for (const item of privateRows) {
    for (const view of candidateViews) {
      const pathInSet = sourceImages.get(`${item.stimulusId}|${view}`);
      if (!pathInSet) throw new Error(`missing ${view} source for ${assignment.scene}/${item.label}`);
      const absoluteImagePath = path.join(shotDir, pathInSet);
      if (!existsSync(absoluteImagePath)) throw new Error(`missing image file: ${pathInSet}`);
      outputImages.set(`${item.stimulusId}|${view}`, { stimulusId: item.stimulusId, view, path: pathInSet });
    }
  }
  const reference = referenceOf(assignment.scene);
  if (!reference || !existsSync(path.join(shotDir, reference.path))) throw new Error(`missing B image for ${assignment.scene}`);
  const publicReference = { stimulusId: reference.stimulusId, view: 'B', path: reference.path };
  assignment.reference = publicReference;
  outputImages.set(`${reference.stimulusId}|B`, publicReference);
}
publicData.images = [...outputImages.values()];

const serialized = JSON.stringify(publicData).replaceAll('<', '\\u003c');
const html = readFileSync(templatePath, 'utf8').replace('__VIEWER_DATA__', serialized);
if (html.includes('__VIEWER_DATA__')) throw new Error('viewer data placeholder was not replaced');
writeFileSync(path.join(shotDir, 'viewer-data.json'), `${JSON.stringify(publicData, null, 2)}\n`);
writeFileSync(path.join(shotDir, 'index.html'), html);
console.log(JSON.stringify({
  privateKey: path.relative(root, privateKeyPath),
  assignments: privateKey.assignments.length,
  publicScenes: publicData.assignments.length,
  publicCandidateImages: publicData.images.filter((image) => image.view !== 'B').length,
  publicReferences: publicData.images.filter((image) => image.view === 'B').length,
}));
