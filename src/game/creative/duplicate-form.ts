// マップ上の既存オブジェクトを「複製」するための、状態→物体配置フォーム値の逆変換。
// elements.ts の orbitPlaneBasis(inc, raan, argp → pHat/qHat) の逆方向を解くだけで、
// 新しい軌道計算はしない。中心天体の選定・要素化・真近点角の算出は celestial-body.ts/elements.ts の
// 既存関数(strongestAttractor/elementsAround/trueAnomalyAt/apsisAltitudes)をそのまま使う。
import { KinematicState } from '../../physics/kinematic-state';
import { CelestialBody, CelestialBodyId, orbitalElementsOf, frameOfCelestialBody, strongestAttractor } from '../../physics/celestial-body';
import { OrbitalElements, apsisAltitudes, trueAnomalyAt } from '../../physics/elements';
import { toFrameState } from '../../physics/frame';
import { Vec3, cross, dot, len, norm, v3 } from '../../physics/vec3';
import type { ElementsForm } from './object-placer-panel';

const RAD_TO_DEG = 180 / Math.PI;
const Y_POLE: Vec3 = v3(0, 1, 0);
const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

// 軌道面の法線・近点方向(hHat/pHat)から昇交点赤経Ω・近点引数ωを求める
// (elements.ts の orbitPlaneBasis の逆方向)。傾斜角が0または180°ちょうどの赤道面軌道は
// 昇交点が定まらないので、その場合は Ω=0 の慣例に従う。
function raanArgpFromBasis(el: OrbitalElements): { raanDeg: number; argpDeg: number } {
  const nodeRaw = cross(Y_POLE, el.hHat);
  const node = len(nodeRaw) > 1e-8 ? norm(nodeRaw) : v3(1, 0, 0);
  const raanDeg = wrap360(Math.atan2(-node.z, node.x) * RAD_TO_DEG);
  const argpDeg = wrap360(Math.atan2(dot(el.pHat, cross(el.hHat, node)), dot(el.pHat, node)) * RAD_TO_DEG);
  return { raanDeg, argpDeg };
}

// state の接触軌道要素を、物体配置パネルの軌道要素フォーム値(サイズ/形は近地点+遠地点高度)へ
// 逆算する。中心天体は state に最も強く働く重力源から選ぶが、パネルが基準天体に選べるのは
// 公転天体のみなので、恒星が選ばれた場合は ECI 原点(origin)へ落とす。放物線・双曲線軌道
// (e>=1)は遠地点高度も基準天体の選択も意味を持たないため null。
export function elementsFormFromState(
  state: KinematicState, celestialBodies: readonly CelestialBody[], origin: CelestialBodyId,
): ElementsForm | null {
  const strongest = strongestAttractor(state.r, celestialBodies);
  const center = strongest.isStar ? celestialBodies.find((a) => a.id === origin) ?? strongest : strongest;
  const el = orbitalElementsOf(state, center);
  if (!el || el.e >= 1) return null;

  const { pe, ap } = apsisAltitudes(el);
  const { raanDeg, argpDeg } = raanArgpFromBasis(el);
  // trueAnomalyAt は中心天体相対の位置を要求する(elements.ts 参照) — 絶対 ECI のまま渡すと
  // 中心が地球でない限り誤った真近点角になる。
  const relative = toFrameState(frameOfCelestialBody(center), state);
  const nuDeg = wrap360(trueAnomalyAt(el, relative.r) * RAD_TO_DEG);

  return {
    placementMode: 'elements',
    celestialBody: center.id,
    sizeMode: 'apsides',
    peAltKm: pe / 1e3,
    apAltKm: ap / 1e3,
    incDeg: el.incDeg,
    raanDeg,
    argpDeg,
    nuDeg,
  };
}
