import * as THREE from 'three/webgpu';
import {
  buildProteinEnemyShip, replaceProteinEnemyShip, type ProteinRenderSource,
} from '../../render/protein-enemy-ship';
import { buildProteinCollisionRibbon } from '../../render/protein-ribbon';
import {
  PROTEIN_ASSET_IDS, proteinAssetBundleFor, proteinAssetFor, type ProteinAssetId,
} from './protein-asset-loader';
import type { ProteinAssetDefinition } from './protein-schema';
import type { ProteinDisplaySettings } from './protein-display';

export interface ProteinEnemyDefinition {
  readonly assetId: ProteinAssetId;
  readonly asset: ProteinAssetDefinition;
  readonly buildRenderObject: (display: ProteinDisplaySettings) => THREE.Object3D;
  readonly recolorRenderObject: (target: THREE.Object3D, display: ProteinDisplaySettings) => void;
  readonly buildCollisionObject: () => THREE.Object3D;
}

const PROTEIN_INTERNAL_RIBBON_COLOR = new THREE.Color(0xffffff);

/** 登録済み asset ID から描画用 source を取得する。 */
function proteinRenderSourceFor(id: ProteinAssetId): ProteinRenderSource {
  const bundle = proteinAssetBundleFor(id);
  if (!bundle) throw new Error(`Unknown protein asset bundle: ${id}`);
  return bundle;
}

/** 描画と固定衝突形状を共有 asset へ束ねた敵定義を作る。 */
function createProteinEnemyDefinition(
  assetId: ProteinAssetId,
  source: ProteinRenderSource,
): ProteinEnemyDefinition {
  // 表示の再構築だけが設定へ追従し、衝突形状は専用プロファイルに固定する。
  return {
    assetId,
    asset: source.semantic,
    buildRenderObject: (display) => buildProteinEnemyShip(source, display),
    recolorRenderObject: (target, display) => replaceProteinEnemyShip(
      target, buildProteinEnemyShip(source, display),
    ),
    buildCollisionObject: () => buildProteinCollisionRibbon(
      source, 'chain', PROTEIN_INTERNAL_RIBBON_COLOR,
    ),
  };
}

const PROTEIN_ENEMY_DEFINITIONS = Object.fromEntries(PROTEIN_ASSET_IDS.map((assetId) => [
  assetId,
  createProteinEnemyDefinition(assetId, proteinRenderSourceFor(assetId)),
])) as Readonly<Record<ProteinAssetId, ProteinEnemyDefinition>>;

/** 任意の文字列から登録済みタンパク質敵定義を検索する。 */
export function proteinEnemyDefinitionFor(id: string): ProteinEnemyDefinition | null {
  if (!proteinAssetFor(id)) return null;
  return PROTEIN_ENEMY_DEFINITIONS[id as ProteinAssetId] ?? null;
}
