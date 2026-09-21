// 描画テスト環境の観察の向きの語彙。恒星とカメラの向きを方位角・仰角で表し、向きのベクトルと
// 相互に変換する。
import * as THREE from 'three/webgpu';

// 観察の向き。角度は度、sunDistanceLogAu は恒星までの距離(天文単位)の常用対数、
// cameraDistanceLog はケース既定の距離に対する倍率の常用対数、cameraZoomLog はケース既定の
// 画角を狭める倍率の常用対数。
export interface LabViewAngles {
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly sunDistanceLogAu: number;
  readonly cameraAzimuthDeg: number;
  readonly cameraElevationDeg: number;
  readonly cameraDistanceLog: number;
  readonly cameraZoomLog: number;
}

// 方位角・仰角 [deg] から単位ベクトルを組み、out へ書いて返す。方位角 0 が +Z、+90 度が +X。
export function directionFromAngles(azimuthDeg: number, elevationDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(elevation);
  return out.set(Math.sin(azimuth) * horizontal, Math.sin(elevation), Math.cos(azimuth) * horizontal);
}

// directionFromAngles の逆写像。長さ 0 でない任意のベクトルを受ける。
export function anglesFromDirection(v: THREE.Vector3): { azimuthDeg: number; elevationDeg: number } {
  const unitY = THREE.MathUtils.clamp(v.y / Math.max(v.length(), 1e-12), -1, 1);
  return {
    azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(v.x, v.z)),
    elevationDeg: THREE.MathUtils.radToDeg(Math.asin(unitY)),
  };
}
