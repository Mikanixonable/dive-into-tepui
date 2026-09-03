// 一様な放射輝度の球光源が届ける照度。拡散はランバート面への放射照度の閉じた解(Snyder の
// 解析解)、鏡面は同じ視半径を張る多角形の LTC 積分(ltc.ts)。どちらも球の見かけが地平線で
// 切られる場合を含み、視半径が小さくなると点光源へ連続に縮退するので、近距離用・遠距離用の
// 分岐を持たない。
import { Fn, acos, atan, clamp, float, max, select, sqrt, texture } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';
import { ltcEvaluate, ltcInverseTransform, ltcUv, sphereOctagonPoints } from './ltc';
import { createLtcTables } from './ltc-table.generated';
import type { ShadingSample } from './shading-sample';

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

// 球光源の鏡面。係数表をテクスチャとして持つので、生成した側が dispose() で解放する。
export class SphereSpecular {
  private readonly tables = createLtcTables();

  // 球光源(中心・半径は view 空間)の放射輝度へ掛ける鏡面の係数。粗さと視線の傾きで係数表を
  // 引き、輪郭円盤と同じ視半径の多角形が張る立体角を積分する。F0=1 で仮に評価した値。
  factor(sample: ShadingSample, center: Vec3Node, radius: FloatNode): FloatNode {
    const uv = ltcUv(sample.normal, sample.viewDir, sample.roughness);
    const inverseTransform = ltcInverseTransform(texture(this.tables.ltc1, uv));
    const formFactor = ltcEvaluate(
      sample.normal, sample.viewDir, sample.position, inverseTransform,
      sphereOctagonPoints(center, radius, sample.position),
    );
    // 表 2 の x が、逆変換で歪めた立体角を元へ戻す正規化係数。
    return texture(this.tables.ltc2, uv).x.mul(formFactor);
  }

  dispose(): void {
    this.tables.ltc1.dispose();
    this.tables.ltc2.dispose();
  }
}
