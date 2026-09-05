// 遮蔽パスがこの1フレームに扱う遮蔽器・環・積雲の殻を選ぶ。絵に出ない遮蔽を落とす閾値も、環を
// 1体に絞る判断も、積雲の影を出す設定の読み方も、遮蔽パスのグラフの形が決めるものなのでここが持つ。
import { maxShadowedFraction } from '../../../physics/shadow';
import { len, sub } from '../../../math/vec3';
import { MAX_SHADOW_BODIES } from './body-shadow';
import { CUMULUS_DETAIL } from '../../cumulus-shell';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import type { Vec3 } from '../../../math/vec3';
import type { RingBand } from './ring-shadow';
import type { GraphicsSettingsData } from '../../graphics-settings';

// 遮蔽器として残す最大遮蔽率の下限。これを下回る天体は、どの向きでも恒星面の 1% 未満しか
// 隠せないので、落としても絵に出ない(physics/shadow.ts の maxShadowedFraction)。
const MIN_SHADOWED_FRACTION = 1e-2;

// 遮蔽器と環を順位づける尺度。視半径が大きい天体ほど、その影が画面に写っている何かへ落ちる
// 見込みが高い。恒星の視半径が同じなら最大遮蔽率は視半径に比例するので、この並びは最大遮蔽率の
// 降順と一致する。
function apparentRadius(radius: number, center: Vec3, cameraPos: Vec3): number {
  return radius / Math.max(1, len(sub(center, cameraPos)));
}

// celestialBody が cameraPos か focusPos のまわりへ、絵に出るだけの影を落としうるか。
// **カメラ位置だけで測ってはいけない** — 土星から引いたマップビューでは土星自身が閾値を
// 切り、環の影が本体から消える。
function castsVisibleShadow(
  star: CelestialMotion, celestialBody: CelestialMotion, pivot: number,
  cameraPos: Vec3, focusPos: Vec3 | null,
): boolean {
  if (maxShadowedFraction(cameraPos, star, celestialBody, pivot) >= MIN_SHADOWED_FRACTION) return true;
  return focusPos !== null
    && maxShadowedFraction(focusPos, star, celestialBody, pivot) >= MIN_SHADOWED_FRACTION;
}

// 環の影を落としうる天体 1 体ぶんの候補。すべて ECI。
export interface RingShadowCandidate {
  readonly center: Vec3;
  // 環面の法線(自転軸)。向きが得られない天体では null。
  readonly axis: Vec3 | null;
  readonly radius: number;
  readonly bands: readonly RingBand[];
}

// このフレームに遮蔽器として扱う天体を、視半径の大きい順に MAX_SHADOW_BODIES 体まで返す。
// **星系の全天体を渡すこと** — 恒星と半径 0 の天体はここで落とす。focusPos はマップの
// 注視点(天体でない対象を注視しているなら null)。
export function selectShadowBodies(
  celestialBodies: readonly CelestialMotion[], pivot: number, cameraPos: Vec3, focusPos: Vec3 | null,
): readonly CelestialMotion[] {
  const star = celestialBodies.find((celestialBody) => celestialBody.kind === 'star') ?? null;
  // 恒星・半径 0 の天体・絵に出る影を落とせない天体を落とし、視半径の大きい順に切る。
  return celestialBodies
    .filter((celestialBody) => celestialBody.kind !== 'star' && celestialBody.def.radius > 0
      && (star === null || castsVisibleShadow(star, celestialBody, pivot, cameraPos, focusPos)))
    .map((celestialBody) => ({
      celestialBody,
      apparent: apparentRadius(
        celestialBody.def.radius, celestialBody.positionAt(pivot), cameraPos),
    }))
    .sort((a, b) => b.apparent - a.apparent)
    .slice(0, MAX_SHADOW_BODIES)
    .map(({ celestialBody }) => celestialBody);
}

// 積雲の殻を遮蔽の源として数える設定か。積雲を描かない設定(雲オフ・積雲の段オフ)では影も消える。
export function castsCumulusShadow(graphics: GraphicsSettingsData): boolean {
  return graphics.clouds && graphics.cumulusShadow
    && graphics.cumulusDetail !== CUMULUS_DETAIL.off;
}

// 環の影を落とす天体を1体選ぶ。画面に環付き天体が複数写る状況は実質起きないので、最も大きく
// 見える1体だけを扱う。**候補は環を持つ天体だけを渡すこと。** 環を描かない設定では null。
export function selectRingShadow(
  candidates: readonly RingShadowCandidate[], cameraPos: Vec3, graphics: GraphicsSettingsData,
): RingShadowCandidate | null {
  if (!graphics.rings) return null;
  let best: RingShadowCandidate | null = null;
  let bestApparent = 0;
  // 視半径が最大の候補を残す。
  for (const candidate of candidates) {
    const apparent = apparentRadius(candidate.radius, candidate.center, cameraPos);
    if (apparent <= bestApparent) continue;
    bestApparent = apparent;
    best = candidate;
  }
  return best;
}
