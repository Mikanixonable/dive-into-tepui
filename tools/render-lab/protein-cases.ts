// Render Lab のタンパク質ケース。catalog へ登録済みの asset から、motion controller と GPU
// binding 込みでゲーム本体と同じ描画経路を組み立て、1 体を固定構図で返す。
import * as THREE from 'three/webgpu';
import { proteinAssetBundleFor, type ProteinAssetId } from '../../src/game/protein/protein-asset-loader';
import type { ProteinDisplaySettings, ProteinRepresentation } from '../../src/game/protein/protein-display';
import { buildProteinEnemyShip, type ProteinRenderSource } from '../../src/render/protein-enemy-ship';
import { ProteinMotionController } from '../../src/game/protein/protein-motion-controller';
import {
  createProteinMotionBinding, disposeProteinMotionBinding, updateProteinMotionBinding,
} from '../../src/render/protein-motion-material';
import type { LabCase } from './cases';

// 描画は cases.ts と同じ 960×540 固定。
const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 540;
const FOV_DEG = 50;
const NEAR = 0.1;
const FAR = 100;

// カメラから模型までの距離 [m]。形が判読できる画面占有率になる位置。
const MODEL_DEPTH = 10;

const ASSET_ID: ProteinAssetId = 'pdb-5i4r';
const PDB_ID = '5I4R';
const DISPLAY: ProteinDisplaySettings = { representation: 'molecular', colorMode: 'element' };

// 計測の駆動が標本へ結び付ける、ケースの素性。
export interface ProteinLabCaseMetadata {
  readonly family: 'protein';
  readonly assetId: ProteinAssetId;
  readonly pdbId: string;
  readonly representation: ProteinRepresentation;
  readonly instanceCount: number;
  /** 静止比較で使用する最高詳細度。 */
  readonly baselineLod: 'near';
}

// 登録済み asset を描画 source として取得する。未登録の id なら投げる。
function sourceFor(assetId: ProteinAssetId): ProteinRenderSource {
  const bundle = proteinAssetBundleFor(assetId);
  if (!bundle) throw new Error(`Unknown Render Lab protein asset: ${assetId}`);
  return { semantic: bundle.semantic, backbone: bundle.backbone, structure: bundle.structure, motion: bundle.motion };
}

// 1 体を固定構図で描くケース。残基 motion は updateProteinMotion を呼んだぶんだけ進む。
function proteinCase(): LabCase {
  const source = sourceFor(ASSET_ID);
  const controller = new ProteinMotionController(source.motion, `render-lab-${ASSET_ID}`);
  const binding = createProteinMotionBinding(source.motion.residueCount);
  const object = buildProteinEnemyShip(source, DISPLAY, binding);
  object.position.set(0, 0, -MODEL_DEPTH);

  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, FAR);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();

  return {
    objects: [object],
    camera,
    proteinMotion: {
      family: 'protein',
      assetId: ASSET_ID,
      pdbId: PDB_ID,
      representation: DISPLAY.representation,
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

export const PROTEIN_CASES: Record<string, () => LabCase> = {
  'protein-5i4r-molecular-1': proteinCase,
};
