// 表示形態ごとの構造メッシュを、外から倍率と姿勢を掛けられる1本の root へ束ねる。
import * as THREE from 'three/webgpu';
import {
  buildProteinAtoms,
  buildProteinLigands,
} from './protein-atom-view';
import { type ProteinMotionBinding } from './protein-motion-material';
import { disposeOwnedRenderResources } from '../dispose-owned-render-resources';
import { markLitOpaque, markShadowCaster } from '../pipeline/lit-layer';
import { buildProteinSilhouette } from './protein-silhouette-view';
import { buildProteinRibbon } from './protein-ribbon';
import type { ProteinDisplaySettings, ProteinRibbonColorMode } from './protein-display';
import type { ProteinRenderSource } from './protein-render-definition';

// binding の残基数が asset と食い違えば例外を投げる。食い違ったまま描くと別の体の変位を読む。
function validateMotionBinding(source: ProteinRenderSource, motion?: ProteinMotionBinding): void {
  if (motion && motion.residueCount !== source.motion.residueCount) {
    throw new Error(`Protein motion binding residueCount ${motion.residueCount} does not match asset ${source.motion.residueCount}`);
  }
}

/** Å からオブジェクト座標への変換を、外から倍率を掛けられる root の下へ閉じ込める。 */
function proteinCoordinateRoot(structure: THREE.Group, coordinateScale: number): THREE.Group {
  const root = new THREE.Group();
  structure.scale.setScalar(coordinateScale);
  structure.userData.proteinStructureRoot = true;
  root.add(structure);
  return root;
}

/** Cartoon リボンとリガンドを、指定した着色で1体ぶんの root へ組む。 */
export function buildProteinRibbonShip(
  source: ProteinRenderSource,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null = null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  validateMotionBinding(source, motion);
  const structure = buildProteinRibbon(source, mode, fixedColor, motion);
  if (source.semantic.ligands.length) structure.add(buildProteinLigands(source, motion));
  const root = proteinCoordinateRoot(structure, source.semantic.coordinateScale);
  markLitOpaque(root);
  markShadowCaster(root);
  return root;
}

/** 表示設定が指す表現形態で、1体ぶんの root を組む。 */
export function buildProteinEnemyShip(
  source: ProteinRenderSource,
  display: ProteinDisplaySettings,
  motion?: ProteinMotionBinding,
): THREE.Group {
  validateMotionBinding(source, motion);
  let structure: THREE.Group;
  if (display.representation === 'molecular') structure = buildProteinAtoms(source, null, false, motion);
  else if (display.representation === 'silhouette') structure = buildProteinSilhouette(source, display.colorMode, motion);
  else return buildProteinRibbonShip(source, display.colorMode, null, motion);
  const root = proteinCoordinateRoot(structure, source.semantic.coordinateScale);
  markLitOpaque(root);
  markShadowCaster(root);
  // 半透明の外殻は world パスで合成する。G バッファに残すと内部リボンの深度と法線を上書きする。
  if (display.representation === 'silhouette') {
    root.traverse((child) => {
      if (child.userData.proteinTranslucentShell === true) child.layers.set(0);
    });
  }
  return root;
}

/** target の子を破棄して replacement の子へ入れ替え、replacement は空になる。target 自身の姿勢と倍率は残る。 */
export function replaceProteinEnemyShip(target: THREE.Object3D, replacement: THREE.Object3D): void {
  for (const child of [...target.children]) {
    disposeOwnedRenderResources(child);
    target.remove(child);
  }
  for (const child of [...replacement.children]) target.add(child);
  replacement.clear();
}
