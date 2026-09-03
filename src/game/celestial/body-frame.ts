// 天体固定の基準系を、描画が受け取る行列へ解決する。歪んだ形を持つ天体は半軸を天体固定の
// 軸で持つので、その形を使う描画(積雲の殻が落とす影・遮蔽器)には必ずこの向きが要る。
import * as THREE from 'three/webgpu';
import { spinOrientation } from '../../physics/body-orientation';
import type { CelestialMotion } from '../../physics/celestial-motion';

const tmpSpin = new THREE.Quaternion();

// 時刻 t の自転姿勢から、描画座標のベクトルを天体固定の向きへ回す行列を target へ書く。
// **自転姿勢を持たない天体では単位行列を書く** — 向きの定まらない形は真球としてしか意味を
// 持たないので、どう回しても同じ答えになる。
export function writeBodyFromWorld(
  target: THREE.Matrix4, motion: CelestialMotion, t: number,
): THREE.Matrix4 {
  const orientation = motion.orientationAt(t);
  const spin = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
  if (spin === null) return target.identity();
  return target.makeRotationFromQuaternion(tmpSpin.set(spin.x, spin.y, spin.z, spin.w).invert());
}
