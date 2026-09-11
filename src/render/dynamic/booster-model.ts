// ブースター1段と段間カバーのモデル。機首(前端)が +Z。geometry/material は全個体の共有物なので、
// 片付けは親から外すだけでよい。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../pipeline/lit-layer';
import { memoTemplate } from './baked-model';
import boosterStageData from '../../assets/models/boosterStage.json';
import boosterInterstageCoverData from '../../assets/models/boosterInterstageCover.json';

const boosterStageTemplate = memoTemplate<THREE.Group>(boosterStageData);
const boosterInterstageCoverTemplate = memoTemplate<THREE.Group>(boosterInterstageCoverData);

// 一段ぶんのブースターを生成する。interstageCover なら段間カバーを被せる。
export function buildBoosterStage(interstageCover: boolean): THREE.Group {
  const stage = boosterStageTemplate().clone(true);
  if (interstageCover) stage.add(boosterInterstageCoverTemplate().clone(true));
  markLitOpaque(stage);
  markShadowCaster(stage);
  return stage;
}

// 段間カバーの segment 番目のパネルを、原点に置いて複製する。
export function buildBoosterInterstageCoverPanelMesh(segment: number): THREE.Mesh {
  return interstageCoverPart(`interstage-cover-panel-${segment}`);
}

// 段間カバーの segment 番目の爆砕ボルトを、原点に置いて複製する。
export function buildBoosterExplosiveBoltMesh(segment: number): THREE.Mesh {
  return interstageCoverPart(`interstage-explosive-bolt-${segment}`);
}

// 段間カバーから name の部品を、段の中での取り付け位置を外して複製する。
function interstageCoverPart(name: string): THREE.Mesh {
  const part = boosterInterstageCoverTemplate().getObjectByName(name)!.clone() as THREE.Mesh;
  part.position.set(0, 0, 0);
  part.userData.ownsGeometry = false;
  part.userData.ownsMaterial = false;
  markLitOpaque(part);
  markShadowCaster(part);
  return part;
}
