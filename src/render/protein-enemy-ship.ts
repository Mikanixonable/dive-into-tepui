import * as THREE from 'three/webgpu';
import type { ProteinDisplaySettings, ProteinRibbonColorMode } from '../game/protein/protein-display';
import {
  buildProteinAtoms,
  buildProteinLigands,
} from './protein-atom-view';
import { type ProteinMotionBinding } from './protein-motion-material';
import { disposeOwnedRenderResources } from './dispose-owned-render-resources';
import { markLitOpaque, markShadowCaster } from './pipeline/lit-layer';
import { buildProteinSilhouette } from './protein-silhouette-view';
import { buildProteinRibbon, type ProteinRenderSource } from './protein-ribbon';

export type { ProteinBackboneAsset, ProteinRenderSource } from './protein-ribbon';

function validateMotionBinding(source: ProteinRenderSource, motion?: ProteinMotionBinding): void {
  if (motion && motion.residueCount !== source.motion.residueCount) {
    throw new Error(`Protein motion binding residueCount ${motion.residueCount} does not match asset ${source.motion.residueCount}`);
  }
}

/** Keep the Å-to-object conversion below the enemy root, whose scale is game-owned. */
function proteinCoordinateRoot(structure: THREE.Group, coordinateScale: number): THREE.Group {
  const root = new THREE.Group();
  structure.scale.setScalar(coordinateScale);
  structure.userData.proteinStructureRoot = true;
  root.add(structure);
  return root;
}

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
  // 半透明の外殻は world パスで合成する。不透明の G バッファに残すと、内部リボンの深度と
  // 法線を上書きしてしまう。
  if (display.representation === 'silhouette') {
    root.traverse((child) => {
      if (child.userData.proteinTranslucentShell === true) child.layers.set(0);
    });
  }
  return root;
}

export function replaceProteinEnemyShip(target: THREE.Object3D, replacement: THREE.Object3D): void {
  for (const child of [...target.children]) {
    disposeOwnedRenderResources(child);
    target.remove(child);
  }
  for (const child of [...replacement.children]) target.add(child);
  replacement.clear();
}
