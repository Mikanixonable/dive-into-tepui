// render-lab で局所雲 sampler の周波数応答を見る、既知周期の被覆タイルを作る。
import * as THREE from 'three/webgpu';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import { OrthographicCap } from '../../src/render/field-projection';
import type { CloudPresentationDetailTile } from '../../src/render/cloud/cloud-presentation';

export const CLOUD_DETAIL_DIAGNOSTIC_SIZE = 1024; // 一辺 [texel]。
export const CLOUD_DETAIL_DIAGNOSTIC_RADIUS = THREE.MathUtils.degToRad(2); // 接平面タイルの外縁 [rad]。
export const CLOUD_DETAIL_DIAGNOSTIC_BLEND_ANGLE = THREE.MathUtils.degToRad(1); // 全寄与へ達する角度 [rad]。
export const CLOUD_DETAIL_DIAGNOSTIC_WAVELENGTH_KM = 2; // 基準被覆波長 [km]。
// 診断時に設定する周期 [km] と波数方向 [deg]。
export const CLOUD_DETAIL_DIAGNOSTIC_WAVELENGTHS_KM = [1, 1.5, 2, 3, 4] as const;
export const CLOUD_DETAIL_DIAGNOSTIC_DIRECTIONS_DEG = [0, 45, 90, 135] as const;

export interface CloudDetailDiagnosticTile extends CloudPresentationDetailTile {
  readonly texture: THREE.DataTexture;
}

// 周期と波数方向を固定した sinusoidal coverage。directionDeg は東から北への波数ベクトルの角度。
export function cloudDetailDiagnosticCoverage(
  eastKm: number, northKm: number, wavelengthKm: number, directionDeg: number, phaseDeg = 0,
): number {
  if (![eastKm, northKm, wavelengthKm, directionDeg, phaseDeg].every(Number.isFinite) || wavelengthKm <= 0) {
    throw new RangeError('cloud detail diagnostic requires finite coordinates, angle, and positive wavelength');
  }
  const direction = THREE.MathUtils.degToRad(directionDeg);
  const phaseDistance = eastKm * Math.cos(direction) + northKm * Math.sin(direction);
  return 0.5 + 0.5 * Math.cos((2 * Math.PI * phaseDistance) / wavelengthKm + THREE.MathUtils.degToRad(phaseDeg));
}

// 地表へ割り当てた球面接平面上へ周期被覆を焼き、固定容量の RGBA8 タイルを返す。
export function createCloudDetailDiagnosticTile(
  wavelengthKm = CLOUD_DETAIL_DIAGNOSTIC_WAVELENGTH_KM,
  directionDeg = 0,
  phaseDeg = 0,
  composition: CloudPresentationDetailTile['composition'] = 'absolute',
): CloudDetailDiagnosticTile {
  if (!Number.isFinite(wavelengthKm) || wavelengthKm <= 0 || !Number.isFinite(directionDeg)
    || !Number.isFinite(phaseDeg)) {
    throw new RangeError('cloud detail diagnostic requires a finite angle and positive wavelength');
  }
  const size = CLOUD_DETAIL_DIAGNOSTIC_SIZE;
  const radius = CLOUD_DETAIL_DIAGNOSTIC_RADIUS;
  const halfSpanKm = (R_EARTH_EQ * Math.sin(radius)) / 1000;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const northKm = ((size / 2 - y - 0.5) / size) * halfSpanKm * 2;
    for (let x = 0; x < size; x += 1) {
      const eastKm = ((x + 0.5 - size / 2) / size) * halfSpanKm * 2;
      const coverage = Math.round(255 * cloudDetailDiagnosticCoverage(
        eastKm, northKm, wavelengthKm, directionDeg, phaseDeg,
      ));
      const offset = (y * size + x) * 4;
      data[offset] = coverage;
      data[offset + 1] = 128;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'render-lab-cloud-detail-diagnostic';
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  const blendAngle = CLOUD_DETAIL_DIAGNOSTIC_BLEND_ANGLE;
  return {
    texture,
    cap: new OrthographicCap(size, 0, 0, radius),
    radius,
    blendStartCos: Math.cos(blendAngle),
    composition,
  };
}
