// 前線骨格の数値評価 — pressure-feature.ts の TSL と同じ式の JS 版。腕は閉塞点(三点)を
// 根元に「半径 r で向きが θ(r) の半直線」として表し、向きは下流(東)から循環の向き
// (両半球で反時計)を正に取る。天気図(tools/cloud-lab)が谷へ繋がる前線を折れ線として
// 引くのに使う。
import { CLOUD_TUNING } from './cloud-tuning';
import {
  FEATURE_REACH, FRONT_BAND_DEPTH, FRONT_INNER_RADIUS, FRONT_WIND_LIMIT, TAIL_WARM_FULL,
  TAIL_WARM_ONSET,
} from './pressure-feature';
import { vortexEdgeOf, vortexProfileAt, vortexSpinOf } from './wind-law';
import type { PressurePlacement } from './tracks';

const DEGREE = Math.PI / 180;
const RAD = 180 / Math.PI;
// 腕の背骨を折れ線へ切る刻み数。
const SAMPLES = 48;

// 背骨の上の点。緯度・経度 [°]、nx・ny は循環側(+θ、帯の進行側)の法線の東向き・北向き成分。
export interface SpinePoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly nx: number;
  readonly ny: number;
}

// 前線の腕 1 本の背骨。kind は描き分け(寒冷・温暖・閉塞)そのままの種別。
export interface FrontSpine {
  readonly kind: 'cold' | 'warm' | 'occluded';
  readonly points: readonly SpinePoint[];
}

type Vec3 = readonly [number, number, number];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1e-9;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);
const smoothstep = (x: number, e0: number, e1: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// 緯度 lat・経度 lon [rad] の点での、芯の単位方向と極側・下流(東)の単位接ベクトル。
// pressure-feature の occlusionFrame と同じ式。
function occlusionFrame(lat: number, lon: number): {
  readonly center: Vec3; readonly poleward: Vec3; readonly downstream: Vec3;
} {
  const center: Vec3 = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
  const hemisphere = Math.sign(center[1]);
  return {
    center,
    poleward: norm([
      -center[0] * Math.abs(center[1]),
      hemisphere - center[1] * Math.abs(center[1]),
      -center[2] * Math.abs(center[1]),
    ]),
    downstream: norm(cross([0, 1, 0], center)),
  };
}

// 配置 placement(表面半径 surfaceRadius)の谷が持つ前線の背骨の束。返るのは帯ではなく
// 背骨の折れ線 — 帯の幅と滲みは描き側が決める。前線を持たない配置では空。anchor を
// 渡すと谷の芯をその緯度・経度へ置く — 天気図のように記号が場の極値へ寄る描きで、
// 骨格を同じ芯から生やすために使う。
export function frontSpinesOf(
  placement: PressurePlacement, surfaceRadius: number, rotationPeriod: number,
  anchor?: { readonly latitude: number; readonly longitude: number },
): readonly FrontSpine[] {
  if (placement.fronts === undefined) return [];
  const tuning = CLOUD_TUNING;
  const lat = anchor?.latitude ?? placement.latitude;
  const lon = anchor?.longitude ?? placement.longitude;
  const { center, poleward, downstream } = occlusionFrame(lat, lon);
  const coreRad = placement.radius / surfaceRadius;
  const triple = (placement.occlusion ?? 0) * tuning.frontTripleRadius.value;
  // 循環 — 腕を巻き上げる角速度の形と、腕が届く半径(循環が縁の速さを下回る外縁)。
  // 駆動するのは谷の深さではなく前線の深さ — 谷が埋まったあと残る停滞前線は
  // 残った境目の深さで形を保つ。
  const frontDepth = placement.frontDepth ?? placement.depth;
  const spin = vortexSpinOf(
    frontDepth, placement.radius, placement.latitude, FEATURE_REACH, rotationPeriod);
  const reach = vortexEdgeOf(spin, placement.radius, FEATURE_REACH, tuning.frontEdgeSpeed.value);
  // この半径で回った角 [°] — 積算の巻き上げ角(見える分は一周ぶんへ飽和) × 循環の
  // 半径プロファイル。
  const wound = FRONT_WIND_LIMIT * Math.tanh((placement.wound ?? 0) / FRONT_WIND_LIMIT) * RAD;
  const woundAt = (r: number): number => wound * vortexProfileAt(r, spin);
  // 腕の根元の向き — 三点が出ると寒冷・温暖とも三点の向きへ寄り、3 本が同じ点へ繋がる。
  const rootJoin = smoothstep(triple, 0, 0.2);
  const coldRoot = tuning.frontColdAngleDeg.value
    + (tuning.frontTripleAngleDeg.value - tuning.frontColdAngleDeg.value) * rootJoin;
  const warmRoot = tuning.frontWarmAngleDeg.value
    + (tuning.frontTripleAngleDeg.value - tuning.frontWarmAngleDeg.value) * rootJoin;
  const coldTip = tuning.frontColdTipAngleDeg.value;
  const warmTip = tuning.frontWarmTipAngleDeg.value;

  const pointAt = (r: number, angleDeg: number): SpinePoint => {
    const a = angleDeg * DEGREE;
    const chord = r * coreRad;
    const d = norm([
      center[0] + chord * (Math.cos(a) * downstream[0] + Math.sin(a) * poleward[0]),
      center[1] + chord * (Math.cos(a) * downstream[1] + Math.sin(a) * poleward[1]),
      center[2] + chord * (Math.cos(a) * downstream[2] + Math.sin(a) * poleward[2])]);
    const east = norm(cross([0, 1, 0], d));
    const north = cross(d, east);
    // 循環側(+θ)の法線 — その点での +θ の向きを、点の局所の東・北へ写す。
    const n: Vec3 = [
      -Math.sin(a) * downstream[0] + Math.cos(a) * poleward[0],
      -Math.sin(a) * downstream[1] + Math.cos(a) * poleward[1],
      -Math.sin(a) * downstream[2] + Math.cos(a) * poleward[2]];
    return {
      latitude: Math.asin(Math.min(Math.max(d[1], -1), 1)) * RAD,
      longitude: Math.atan2(d[0], d[2]) * RAD,
      nx: dot(n, east),
      ny: dot(n, north),
    };
  };
  const spine = (
    kind: FrontSpine['kind'], angleAt: (r: number) => number, rMin: number, rMax: number,
  ): FrontSpine => ({
    kind,
    points: Array.from({ length: SAMPLES + 1 }, (_, i) => {
      const r = rMin + (rMax - rMin) * i / SAMPLES;
      return pointAt(r, angleAt(r));
    }),
  });
  const progress = (r: number, armLength: number): number =>
    clamp01((r - triple) / Math.max(armLength - triple, 1e-3));

  const isTail = placement.fronts === 'tail';
  // 寒冷(赤道側)の腕 — 熱帯の渦ではこの腕が赤道側の尾。腕の届く長さは循環が渦の縁の
  // 速さを下回る半径まで。
  const coldLength = reach;
  const spines: FrontSpine[] = [];
  if (coldLength > Math.max(triple, FRONT_INNER_RADIUS)) {
    spines.push(spine(
      'cold',
      r => coldRoot
        + (coldTip - coldRoot) * progress(r, coldLength)
          ** tuning.frontColdBend.value
        + woundAt(r),
      Math.max(triple, FRONT_INNER_RADIUS), coldLength));
  }
  // 温暖(極側〜下流)の腕 — 寒冷の腕より短く、熱帯の渦では温帯化が進むまで立たない。
  const warmLength = coldLength * tuning.frontWarmRatio.value;
  const warmGate = isTail
    ? smoothstep(placement.occlusion ?? 0, TAIL_WARM_ONSET, TAIL_WARM_FULL) : 1;
  if (warmGate > 0 && warmLength > Math.max(triple, FRONT_INNER_RADIUS)) {
    spines.push(spine(
      'warm',
      r => warmRoot
        + (warmTip - warmRoot) * progress(r, warmLength)
          ** tuning.frontWarmBend.value
        + woundAt(r),
      Math.max(triple, FRONT_INNER_RADIUS), warmLength));
  }
  // 閉塞の腕 — 中心から三点へ、ほぼ真っ直ぐに近い短い弧。三点が出るまで無い。
  if (triple > FRONT_INNER_RADIUS) {
    spines.push(spine(
      'occluded',
      r => tuning.frontTripleAngleDeg.value
        + tuning.frontOccSwingDeg.value * clamp01((triple - r) / triple) ** tuning.frontOccBend.value
        + woundAt(r),
      FRONT_INNER_RADIUS, triple));
  }
  return spines;
}

// 配置 placement の谷の前線の帯の強さ 0..1 — 深さに比例し、熱帯の渦の尾は温帯へ
// 近づくにつれ育つ。TSL 側の strength × gate と同じ式。描き側が腕を引くかどうかの目安に使う。
export function frontStrengthOf(placement: PressurePlacement): number {
  const strength = Math.min((placement.frontDepth ?? placement.depth) / FRONT_BAND_DEPTH, 1);
  if (placement.fronts !== 'tail') return placement.fronts === 'pair' ? strength : 0;
  const gate = smoothstep(
    Math.abs(placement.latitude) / DEGREE,
    CLOUD_TUNING.frontTailLatitudeStartDeg.value,
    CLOUD_TUNING.frontTailLatitudeFullDeg.value);
  return strength * gate;
}
