import {
  RADIATOR_DEPLOY_TILT,
  RADIATOR_FOLD_COUNT,
  RADIATOR_SEGMENT_LENGTH,
  SOLAR_PANEL_COUNT,
  SOLAR_PANEL_WIDTH,
} from './player-shape';
import { v3, type Vec3 } from '../math/vec3';

export interface PanelLayout {
  readonly center: Vec3;
  readonly normal: Vec3;
}

const STOW_TILT = Math.PI / 2;

function rotateY(value: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return v3(value.x * cosine + value.z * sine, value.y, -value.x * sine + value.z * cosine);
}

function rotateX(value: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return v3(value.x, value.y * cosine - value.z * sine, value.y * sine + value.z * cosine);
}

function add(a: Vec3, b: Vec3): Vec3 {
  return v3(a.x + b.x, a.y + b.y, a.z + b.z);
}

function zRotatedOffset(angle: number, length: number): Vec3 {
  return rotateY(v3(0, 0, length), angle);
}

// 太陽電池の3枚を、モジュール端面のヒンジから接続面に垂直（+Z方向）へ順に配置する。
// 完全展開時は接続面法線方向へ連なり、収納時はフランジ面へ折りたたまれた薄い束になる。
export function solarPanelLayout(moduleLength: number, deployed: number): readonly PanelLayout[] {
  const fraction = Math.max(0, Math.min(1, deployed));
  const tilt = (1 - fraction) * Math.PI / 2;
  const result: PanelLayout[] = [];
  for (let index = 0; index < SOLAR_PANEL_COUNT; index++) {
    const distance = (index + 0.5) * SOLAR_PANEL_WIDTH * fraction;
    const center = add(
      v3(0, 0, moduleLength / 2),
      v3(0, 0, distance),
    );
    result.push({
      center,
      normal: rotateX(v3(0, 1, 0), tilt),
    });
  }
  return result;
}

// ラジエーターの6枚を、モジュール端面から接続面に垂直（+Z方向）へ展開する蛇腹として配置する。
// パネル面の法線は収納時に接続面法線方向、完全展開時に左右（X方向）に近い面を向く。
export function radiatorPanelLayout(moduleLength: number, deployed: number): readonly PanelLayout[] {
  const fraction = Math.max(0, Math.min(1, deployed));
  const tilt = STOW_TILT + (RADIATOR_DEPLOY_TILT - STOW_TILT) * fraction;
  const result: PanelLayout[] = [];
  let origin: Vec3 = v3(0, 0, moduleLength / 2);
  for (let index = 0; index < RADIATOR_FOLD_COUNT; index++) {
    const angle = index % 2 === 0 ? tilt : -tilt;
    const center = add(origin, zRotatedOffset(angle, RADIATOR_SEGMENT_LENGTH / 2));
    result.push({
      center,
      normal: rotateY(v3(1, 0, 0), angle),
    });
    origin = add(origin, zRotatedOffset(angle, RADIATOR_SEGMENT_LENGTH));
  }
  return result;
}
