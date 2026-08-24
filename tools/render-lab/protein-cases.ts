// Render Lab のタンパク質 baseline。ゲームの runtime へ依存せず、catalog の既存 asset と
// protein-enemy-ship の現行描画経路をそのまま組み立てる。Phase 0 では表示を動かさないため、
// 後続の motion controller が注入する CPU/upload/LOD telemetry は LabCase の metadata と
// 同じ識別子で結び付けられる。
import * as THREE from 'three/webgpu';
import { proteinAssetBundleFor, type ProteinAssetId } from '../../src/game/protein/protein-asset-loader';
import type { ProteinDisplaySettings, ProteinRepresentation } from '../../src/game/protein/protein-display';
import { buildProteinEnemyShip, type ProteinRenderSource } from '../../src/render/protein-enemy-ship';
import type { LabCase } from './cases';

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 540;
const FOV_DEG = 50;
const NEAR = 0.1;

export type ProteinLabRepresentation = ProteinRepresentation;

export interface ProteinLabCaseMetadata {
  readonly family: 'protein';
  readonly assetId: ProteinAssetId;
  readonly pdbId: '5I4R' | '1MBN';
  readonly representation: ProteinLabRepresentation;
  readonly instanceCount: number;
  /** Current render-lab baseline has no motion controller, so all visible instances are full quality. */
  readonly baselineLod: 'near';
}

type ProteinLabAsset = '5i4r' | '1mbn';
type ProteinLabPopulation = 1 | 10 | 20;

const DISPLAY_BY_REPRESENTATION: Readonly<Record<ProteinLabRepresentation, ProteinDisplaySettings>> = {
  molecular: { representation: 'molecular', colorMode: 'element' },
  ribbon: { representation: 'ribbon', colorMode: 'secondary-structure' },
  silhouette: { representation: 'silhouette', colorMode: 'surface-charge' },
};

const ASSETS: Readonly<Record<ProteinLabAsset, {
  readonly assetId: ProteinAssetId;
  readonly pdbId: '5I4R' | '1MBN';
  readonly count: ProteinLabPopulation;
  readonly columns: number;
  readonly spacing: number;
  readonly depth: number;
}>> = {
  '5i4r': { assetId: 'pdb-5i4r', pdbId: '5I4R', count: 10, columns: 5, spacing: 6.3, depth: 38 },
  '1mbn': { assetId: 'pdb-1mbn-myoglobin', pdbId: '1MBN', count: 20, columns: 5, spacing: 5.2, depth: 32 },
};

function cameraFor(asset: ProteinLabAsset, count: ProteinLabPopulation): THREE.PerspectiveCamera {
  const definition = ASSETS[asset];
  const columns = count === 1 ? 1 : definition.columns;
  const rows = Math.ceil(count / columns);
  const depth = count === 1 ? 10 : definition.depth;
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  // Keep a little margin around the grid. The camera is fixed at the origin, matching the other
  // Render Lab cases, so the resulting GPU timings remain comparable across representations.
  camera.userData.proteinGrid = { columns, rows, depth };
  return camera;
}

function sourceFor(assetId: ProteinAssetId): ProteinRenderSource {
  const bundle = proteinAssetBundleFor(assetId);
  if (!bundle) throw new Error(`Unknown Render Lab protein asset: ${assetId}`);
  return { semantic: bundle.semantic, backbone: bundle.backbone, structure: bundle.structure };
}

function gridPosition(index: number, count: number, columns: number, spacing: number): THREE.Vector3 {
  if (count === 1) return new THREE.Vector3(0, 0, -10);
  const row = Math.floor(index / columns);
  const column = index % columns;
  const rows = Math.ceil(count / columns);
  return new THREE.Vector3(
    (column - (columns - 1) / 2) * spacing,
    ((rows - 1) / 2 - row) * spacing,
    -1,
  );
}

function proteinCase(
  asset: ProteinLabAsset,
  representation: ProteinLabRepresentation,
  count: ProteinLabPopulation,
): LabCase {
  const definition = ASSETS[asset];
  const display = DISPLAY_BY_REPRESENTATION[representation];
  const source = sourceFor(definition.assetId);
  const objects: THREE.Object3D[] = [];
  for (let index = 0; index < count; index++) {
    const object = buildProteinEnemyShip(source, display);
    const position = gridPosition(index, count, definition.columns, definition.spacing);
    object.position.copy(position);
    if (count > 1) object.position.z = -definition.depth;
    objects.push(object);
  }
  return {
    objects,
    camera: cameraFor(asset, count),
    proteinMotion: {
      family: 'protein',
      assetId: definition.assetId,
      pdbId: definition.pdbId,
      representation,
      instanceCount: count,
      baselineLod: 'near',
    },
  };
}

function proteinCaseName(asset: ProteinLabAsset, representation: ProteinLabRepresentation, count: number): string {
  return `protein-${asset}-${representation}-${count}`;
}

const PROTEIN_CASES: Record<string, () => LabCase> = {};
for (const asset of Object.keys(ASSETS) as ProteinLabAsset[]) {
  const count = asset === '5i4r' ? 10 : 20;
  for (const representation of ['molecular', 'ribbon', 'silhouette'] as const) {
    for (const population of [1, count] as const) {
      PROTEIN_CASES[proteinCaseName(asset, representation, population)] = () => proteinCase(
        asset, representation, population,
      );
    }
  }
}

export { PROTEIN_CASES };
