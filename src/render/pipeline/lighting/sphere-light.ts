// 一様な放射輝度の球光源がランバート面へ届ける放射照度の閉じた解(Snyder の解析解)。
// 球の見かけが地平線で切られる場合を含み、視半径が小さくなると点光源の N·L へ連続に
// 縮退するので、近距離用・遠距離用の分岐を持たない。
import { Fn, acos, atan, clamp, float, max, select, sqrt } from 'three/tsl';
import type { FloatNode } from '../../tsl-types';

// 放射照度の係数 0..1。cosBeta は面の法線と光源中心方向のなす角の余弦(負も受ける)、
// sinSigmaSqr は視半径 σ の正弦の 2 乗(= (R/d)²)。点光源の放射照度 I/d² にこれを
// 掛けると球光源の放射照度になる — 球が完全に地平線の上にあれば saturate(cosBeta) と
// 一致し、点光源と同じ値を返す。
export const sphereIrradianceFactor = Fn(
  ([cosBeta, sinSigmaSqr]: readonly [FloatNode, FloatNode]) => {
    const sinBeta = sqrt(max(float(1).sub(cosBeta.mul(cosBeta)), 1e-12));
    // 視半径 0 でも比が定義されるよう床を置く。床が効く領域では全可視の枝が選ばれる。
    const safeSigmaSqr = max(sinSigmaSqr, 1e-12);
    // 地平線が球を切っている(π/2 − σ < β < π/2 + σ)ときの月形の積分。
    const x = sqrt(max(float(1).div(safeSigmaSqr).sub(1), 0));
    const y = clamp(x.negate().mul(cosBeta.div(sinBeta)), -1, 1);
    const sinBetaSqrtY = sinBeta.mul(sqrt(max(float(1).sub(y.mul(y)), 0)));
    const clipped = cosBeta.mul(acos(y)).sub(x.mul(sinBetaSqrtY)).mul(safeSigmaSqr)
      .add(atan(sinBetaSqrtY, max(x, 1e-12)));
    // cos²β > sin²σ は「球がまるごと地平線の上(cosβ > 0)か下(cosβ < 0)」を表す。
    return select(
      cosBeta.mul(cosBeta).greaterThan(safeSigmaSqr),
      clamp(cosBeta, 0, 1),
      max(clipped.div(safeSigmaSqr.mul(Math.PI)), 0),
    );
  },
);
