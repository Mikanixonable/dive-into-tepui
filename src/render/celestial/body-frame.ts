// 天体固定の基準系(歪んだ形の半軸が乗る軸)を、描画が受け取る行列へ解決する。
import * as THREE from 'three/webgpu';
import { spinOrientation } from '../../physics/body-orientation';
import type { CelestialBody } from '../../physics/celestial-body';

const tmpSpin = new THREE.Quaternion();

// 時刻 t の自転姿勢から、描画座標のベクトルを天体固定の向きへ回す行列を target へ書いて返す。
// 自転姿勢を持たない天体(真球として扱う)では単位行列を書く。
export function writeBodyFromWorld(
  target: THREE.Matrix4, motion: CelestialBody, t: number,
): THREE.Matrix4 {
  const orientation = motion.orientationAt(t);
  const spin = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
  if (spin === null) return target.identity();
  return target.makeRotationFromQuaternion(tmpSpin.set(spin.x, spin.y, spin.z, spin.w).invert());
}
