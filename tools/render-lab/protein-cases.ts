// Render Lab のタンパク質 baseline。ゲームの runtime へ依存せず、catalog の既存 asset と
// protein-enemy-ship の現行描画経路を controller + GPU binding 込みで組み立てる。
import * as THREE from 'three/webgpu';
import { proteinAssetBundleFor, type ProteinAssetId } from '../../src/game/protein/protein-asset-loader';
import type { ProteinDisplaySettings, ProteinRepresentation } from '../../src/game/protein/protein-display';
import { buildProteinEnemyShip, type ProteinRenderSource } from '../../src/render/protein-enemy-ship';
import { ProteinMotionController } from '../../src/game/protein/protein-motion-controller';
import { createProteinMotionBinding, disposeProteinMotionBinding, updateProteinMotionBinding, type ProteinMotionBinding } from '../../src/render/protein-motion-material';
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
  /** 静止比較で使用する最高詳細度。 */
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

const PUBLICATION_FRAMED_RADIUS = 4.25;
const PUBLICATION_FRAME_FILL = 0.76;
const PUBLICATION_ROTATION = new THREE.Euler(0.14, -0.34, 0.08);

const PUBLICATION_DISPLAY: ProteinDisplaySettings = {
  representation: 'ribbon',
  colorMode: 'publication',
};

/** 個体数に対応した従来比較ケースの固定カメラを返す。 */
function cameraFor(asset: ProteinLabAsset, count: ProteinLabPopulation): THREE.PerspectiveCamera {
  const definition = ASSETS[asset];
  const columns = count === 1 ? 1 : definition.columns;
  const rows = Math.ceil(count / columns);
  const depth = count === 1 ? 10 : definition.depth;
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  // グリッド寸法を保持し、各 representation の GPU 計測条件をそろえる。
  camera.userData.proteinGrid = { columns, rows, depth };
  return camera;
}

/** 登録済み asset を描画 source として取得する。 */
function sourceFor(assetId: ProteinAssetId): ProteinRenderSource {
  const bundle = proteinAssetBundleFor(assetId);
  if (!bundle) throw new Error(`Unknown Render Lab protein asset: ${assetId}`);
  return { semantic: bundle.semantic, backbone: bundle.backbone, structure: bundle.structure, motion: bundle.motion };
}

/** 比較グリッド内の個体位置を返す。 */
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

/** 指定 asset・表示形態・個体数の比較ケースを生成する。 */
function proteinCase(
  asset: ProteinLabAsset,
  representation: ProteinLabRepresentation,
  count: ProteinLabPopulation,
): LabCase {
  const definition = ASSETS[asset];
  const display = DISPLAY_BY_REPRESENTATION[representation];
  const source = sourceFor(definition.assetId);
  const objects: THREE.Object3D[] = [];
  // 全個体に同じ表示設定を適用し、指定グリッドへ並べる。
  const controllers: ProteinMotionController[] = [];
  const bindings: ProteinMotionBinding[] = [];
  for (let index = 0; index < count; index++) {
    const controller = new ProteinMotionController(source.motion, `render-lab-${asset}-${index}`);
    const binding = createProteinMotionBinding(source.motion.residueCount);
    const object = buildProteinEnemyShip(source, display, binding);
    controllers.push(controller);
    bindings.push(binding);
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
    updateProteinMotion(displayTime) {
      const startedAt = performance.now();
      for (let index = 0; index < controllers.length; index++) {
        updateProteinMotionBinding(bindings[index]!, controllers[index]!.update(displayTime, 'near'));
      }
      return {
        cpuMs: performance.now() - startedAt,
        uploadBytes: source.motion.residueCount * 4 * Float32Array.BYTES_PER_ELEMENT * count,
        lodCounts: { near: count },
      };
    },
    disposeProteinMotion() { for (const binding of bindings) disposeProteinMotionBinding(binding); },
  };
}

/** 比較ケースの安定した識別名を返す。 */
function proteinCaseName(asset: ProteinLabAsset, representation: ProteinLabRepresentation, count: number): string {
  return `protein-${asset}-${representation}-${count}`;
}

/** モデル全体を収める固定カメラを返す。 */
function publicationCamera(distance: number, modelDepth: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, distance + modelDepth * 2,
  );
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  return camera;
}

/** 論文調 Ribbon の形状・陰影・リガンドを1体の固定構図で返す。 */
function publicationCase(asset: ProteinLabAsset): LabCase {
  const definition = ASSETS[asset];
  const source = sourceFor(definition.assetId);
  const controller = new ProteinMotionController(source.motion, `render-lab-${asset}-publication`);
  const binding = createProteinMotionBinding(source.motion.residueCount);
  const object = buildProteinEnemyShip(source, PUBLICATION_DISPLAY, binding);
  object.rotation.copy(PUBLICATION_ROTATION);
  object.updateMatrixWorld(true);

  // asset 間で比較しやすいよう外接球半径を共通化する。
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw new Error(`Protein Render Lab model has no bounds: ${definition.assetId}`);
  const sphere = new THREE.Sphere();
  bounds.getBoundingSphere(sphere);
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    throw new Error(`Protein Render Lab model has invalid bounds: ${definition.assetId}`);
  }

  object.scale.multiplyScalar(PUBLICATION_FRAMED_RADIUS / sphere.radius);
  object.updateMatrixWorld(true);
  // 回転後の箱を透視投影へ収め、形状を判読できる画面占有率にする。
  const framedBounds = new THREE.Box3().setFromObject(object);
  const framedCenter = framedBounds.getCenter(new THREE.Vector3());
  const halfSize = framedBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const verticalFov = FOV_DEG * Math.PI / 180;
  const verticalTangent = Math.tan(verticalFov / 2);
  const horizontalTangent = verticalTangent * VIEW_WIDTH / VIEW_HEIGHT;
  const distance = halfSize.z + Math.max(
    halfSize.x / (horizontalTangent * PUBLICATION_FRAME_FILL),
    halfSize.y / (verticalTangent * PUBLICATION_FRAME_FILL),
  );
  object.position.set(
    -framedCenter.x,
    -framedCenter.y,
    -framedCenter.z - distance,
  );
  object.updateMatrixWorld(true);

  return {
    objects: [object],
    camera: publicationCamera(distance, halfSize.z),
    proteinMotion: {
      family: 'protein',
      assetId: definition.assetId,
      pdbId: definition.pdbId,
      representation: 'ribbon',
      instanceCount: 1,
      baselineLod: 'near',
    },
    updateProteinMotion(displayTime) {
      const startedAt = performance.now();
      updateProteinMotionBinding(binding, controller.update(displayTime, 'near'));
      return {
        cpuMs: performance.now() - startedAt,
        uploadBytes: source.motion.residueCount * 4 * Float32Array.BYTES_PER_ELEMENT,
        lodCounts: { near: 1 },
      };
    },
    disposeProteinMotion() { disposeProteinMotionBinding(binding); },
  };
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

PROTEIN_CASES['protein-5i4r-publication'] = () => publicationCase('5i4r');
PROTEIN_CASES['protein-1mbn-publication'] = () => publicationCase('1mbn');

export { PROTEIN_CASES };
