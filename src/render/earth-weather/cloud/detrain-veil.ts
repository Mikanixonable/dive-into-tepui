// 発達した塔が上層へ放出した氷雲(かなとこ雲)の写し。焼いた雲場の脱出水の源を、圏界面での
// 発散(全方向へ届くタップ)と上層の風への移流(風上へ遡るタップ)で運び、源からの距離で
// 減衰させて重ねる。読み手はこの写しを巻雲の量へ合成する
// (DEVELOP/SPEC/RENDERING.md「対流雲は下層から発達する」)。
import { clamp, exp, float, log2, normalize, vec4 } from 'three/tsl';
import { cloudMotionFromTexel } from './cloud-field-sample';
import { CLOUD_TUNING } from './cloud-tuning';
import { eastAt, northAt } from '../sphere-frame';
import type { BakedField } from '../../baked-field';
import type { FieldProjection } from '../../field-projection';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 発散のタップ数と、風上へ遡る歩数。細かいほど輪郭が滑らかになり、移流の尾が長く届く。
const DETRAIN_SPREAD_TAPS = 20;
const DETRAIN_ADVECT_TAPS = 4;
// 発散が届く半径 [m]。圏界面へぶつかった氷雲が親の塔のまわり全方向へ広がる程度 — 個々の
// かなとこの直径は数十キロ(DEVELOP/SPEC/RENDERING.md「対流雲は下層から発達する」)。
const DETRAIN_SPREAD_RADIUS = CLOUD_TUNING.detrainSpreadRadius;
// 発散のタップ 1 個ぶんの重みの基準。タップの重みは円盤の縁へ行くほど細くなる。
const DETRAIN_SPREAD_WEIGHT = CLOUD_TUNING.detrainSpreadWeight;
// 風上へ遡る 1 歩の経過時間 [s] と、発射からの経過で掛かる減衰の時定数 [s]。尾の届く長さは
// 上層風 × 減衰で決まる。
const DETRAIN_ADVECT_STEP = CLOUD_TUNING.detrainAdvectStep;
const DETRAIN_DECAY = CLOUD_TUNING.detrainDecaySeconds;
// 重ねた量をベールの強さへ飽和させる利得。大きいほど少ない放出で不透明度へ近づく。
const DETRAIN_GAIN = CLOUD_TUNING.detrainGain;
// 群れの盾の成分 — 発達した塔が群れをなす所で、個々のかなとこが重なり合って塔のあいだの
// 晴れ間まで高い層で覆う天蓋(DEVELOP/SPEC/RENDERING.md「対流雲は下層から発達する」)。
// この半径で均した放出の平均へ掛ける利得。均すのでタップと違い隙間なく埋まり、孤立した
// 一本の塔では平均が薄くてほとんど乗らない。
const DETRAIN_SHIELD_RADIUS = CLOUD_TUNING.detrainShieldRadius;
const DETRAIN_SHIELD_GAIN = CLOUD_TUNING.detrainShieldGain;
// ミップの段の上限。球の写しほど texel が細かいので段を深く取れるよう幅を持たせる。
const DETRAIN_SHIELD_LEVEL_MAX = 9;

// 焼いた雲場と風の写しから、脱出水のベールの texel(R = ベールの強さ)を組む。
// surfaceRadius は雲を載せる天体の半径 [m]。cloudField は雲・環境・セル径の3出力を焼いた写しで、
// 脱出水の源を出力 2 の B、渦の眼を同じ A から読む。
export function detrainVeilTexelAt(
  cloudField: BakedField, motionField: BakedField, projection: FieldProjection,
  direction: Vec3Node, surfaceRadius: number,
): Vec4Node {
  // 円板(cap)の定義域の外は 0 — 縁の値をタップが引きずって帯にならないようにする。
  const inside = (dir: Vec3Node): FloatNode => projection.insideAt(projection.uvAt(dir));
  // dir の柱が上層へ放出する氷雲の強さ。
  const emitAt = (dir: Vec3Node): FloatNode => cloudField.at(dir, 2).b.mul(inside(dir));
  // 盾の成分は、盾の半径ぶん均した放出の平均としてミップ段から読む。均す半径を texel へ
  // 換算して段を選ぶ — 段が上がるほど 1 texel の張る範囲が倍になる。
  const shieldLevel = clamp(
    log2(DETRAIN_SHIELD_RADIUS.div(projection.texelAngle.mul(surfaceRadius))),
    float(0), float(DETRAIN_SHIELD_LEVEL_MAX));
  const emitShieldAt = (dir: Vec3Node): FloatNode =>
    cloudField.atLevel(dir, shieldLevel, 2).b.mul(inside(dir));
  // dir で氷雲を運ぶ上層の風の東・北の成分 [m/s]。
  const upperWindAt = (dir: Vec3Node): Vec2Node => cloudMotionFromTexel(motionField.at(dir)).upperWind;
  // タップが拾った量の和。飽和は最後の 1 − e^(−G·x) が担うので、和は素のまま積む。
  let sum = emitAt(direction);
  // 圏界面での発散: まわりの円盤内から届く放出。タップは Vogel 螺旋で円盤を満遍なく埋め、
  // 縁へ行くほど重みを細くしてかなとこの縁が薄く消えるようにする。塔のあいだの
  // 晴れ間も上層で覆う成分。
  const east = eastAt(direction);
  const north = northAt(direction);
  const spreadAngle = DETRAIN_SPREAD_RADIUS.div(surfaceRadius);
  for (let k = 0; k < DETRAIN_SPREAD_TAPS; k++) {
    const r = Math.sqrt((k + 0.5) / DETRAIN_SPREAD_TAPS);
    const angle = k * 2.399963;
    const point = normalize(direction
      .add(east.mul(Math.cos(angle)).add(north.mul(Math.sin(angle))).mul(spreadAngle.mul(r))));
    sum = sum.add(emitAt(point).mul(DETRAIN_SPREAD_WEIGHT.mul(1.15 - r)));
  }
  // 上層の風への移流: 風上へ遡った点から届く放出。各点の風で遡る向きが曲がるので逐次遡る。
  let point = direction;
  for (let k = 1; k <= DETRAIN_ADVECT_TAPS; k++) {
    const wind = upperWindAt(point);
    const step = eastAt(point).mul(wind.x).add(northAt(point).mul(wind.y))
      .mul(DETRAIN_ADVECT_STEP.div(surfaceRadius));
    point = normalize(point.sub(step));
    // 発射からの経過秒で減衰する — 源から離れるほど薄くなる。
    sum = sum.add(emitAt(point).mul(exp(float(-k).mul(DETRAIN_ADVECT_STEP).div(DETRAIN_DECAY))));
  }
  // 群れの盾: まわりの放出の平均を足す。塔が群れる所では塔のあいだの晴れ間まで届き、
  // 孤立した塔では平均が薄くて自身のかなとこのみ残る。
  sum = sum.add(emitShieldAt(direction).mul(DETRAIN_SHIELD_GAIN));
  // 眼の上には傘を掛けない(DEVELOP/SPEC/RENDERING.md「眼の上に巻雲の傘が架かって霞むことはない」)。
  const veil = exp(sum.mul(DETRAIN_GAIN).negate()).oneMinus()
    .mul(cloudField.at(direction, 2).a.oneMinus());
  return vec4(veil, 0, 0, 0);
}
