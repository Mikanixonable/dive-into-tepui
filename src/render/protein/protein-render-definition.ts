// タンパク質1体ぶんの表示定義。表示ツリーを組むために読むアセットの面をここが宣言し、
// 表示設定から THREE ツリーを組む・組み直す手順を、そのアセットへ束ねて返す。
import * as THREE from 'three/webgpu';
import { buildProteinEnemyShip, replaceProteinEnemyShip } from './protein-enemy-ship';
import type { ProteinDisplaySettings } from './protein-display';
import type { ProteinDisplayAsset } from './protein-display-asset';
import type { ProteinMotionBinding } from './protein-motion-material';

/** 焼き込み済みの主鎖。座標は構造アセットと同じ中心寄せ済みの Å 系。 */
export interface ProteinBackboneAsset {
  readonly backboneCount: number;
  readonly backboneCoordinates: readonly number[];
  /** カルボニル酸素の座標。 */
  readonly backboneOCoordinates?: readonly number[];
  readonly backboneSecondary: readonly string[];
  readonly backboneChains: readonly string[];
  readonly backboneEntities: readonly number[];
  readonly backboneBFactors: readonly number[];
}

/** 表示が読む部位。座標は構造アセットの Å 系。 */
export interface ProteinRenderSite {
  readonly id: string;
  readonly position: readonly [number, number, number];
  /** 動くアンカーを引くための残基記述子。 */
  readonly residues?: readonly string[];
}

/** 表示が読む構造定義の面。 */
export interface ProteinRenderAsset {
  /** Å からオブジェクト座標への倍率。 */
  readonly coordinateScale: number;
  readonly components: readonly {
    readonly chains: readonly string[];
    readonly entities?: readonly number[];
    readonly role: string;
  }[];
  readonly ligands: readonly { readonly id: string; readonly residue: string }[];
  readonly sites: readonly ProteinRenderSite[];
  readonly bonds: readonly { readonly from: string; readonly to: string }[];
}

/** 表示が読む残基変形の面。 */
export interface ProteinRenderMotion {
  readonly residueCount: number;
  readonly residues: {
    readonly chains: readonly string[];
    readonly residueNumbers: readonly number[];
  };
  readonly bindings: {
    readonly atomResidues: readonly number[];
    readonly backboneResidues: readonly number[];
    readonly surfaceResidues: readonly number[];
    readonly ribbonResidues: readonly number[];
    readonly siteResidues: readonly number[];
  };
  readonly modes: readonly { readonly displacements: readonly number[] }[];
}

/** 表示ツリーと変形資源が読む、1体ぶんのアセット由来の入力。 */
export interface ProteinRenderSource {
  readonly semantic: ProteinRenderAsset;
  readonly motion: ProteinRenderMotion;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
}

/** 1体ぶんのアセットへ束ねた、表示ツリーの組み立て手順。 */
export interface ProteinRenderDefinition {
  readonly source: ProteinRenderSource;
  /** 表示設定に対応する THREE ツリーを新しく組む。 */
  readonly buildRenderObject: (display: ProteinDisplaySettings, motion?: ProteinMotionBinding) => THREE.Object3D;
  /** 既に置かれているツリーの中身を、新しい表示設定で組み直したものへ入れ替える。 */
  readonly recolorRenderObject: (
    target: THREE.Object3D, display: ProteinDisplaySettings, motion?: ProteinMotionBinding,
  ) => void;
}

/** アセット由来の入力へ、表示形態ごとの組み立てを束ねた表示定義を作る。 */
export function createProteinRenderDefinition(source: ProteinRenderSource): ProteinRenderDefinition {
  return {
    source,
    buildRenderObject: (display, motion) => buildProteinEnemyShip(source, display, motion),
    recolorRenderObject: (target, display, motion) => replaceProteinEnemyShip(
      target, buildProteinEnemyShip(source, display, motion),
    ),
  };
}
