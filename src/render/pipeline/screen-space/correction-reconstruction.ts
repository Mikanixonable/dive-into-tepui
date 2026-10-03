// 走査の解像度で求めた符号付きの拡散照度補正を、受け手の面の重み(SurfaceWeight)で描画バッファの解像度へ復元する
// 段の部品。補正には受け手ごとの天体照が掛かっているので、内隅や輪郭を越えて混ぜない。
import type * as THREE from 'three/webgpu';
import { If, bool, clamp, exp2, float, floor, ivec2, screenSize, screenUV, select, vec2, vec3 } from 'three/tsl';
import { gbufferTexelOf } from './hemisphere-scan';
import { bandsAt } from './band-pyramid';
import { SurfaceWeight, WEIGHT_EPSILON, type Texel } from './surface-weight';
import type { GBufferPass } from '../gbuffer';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';

// 拡大が読む、描画バッファの画素の中心を囲む 2×2 の走査の画素の、左上からのずれ。
const UPSAMPLE_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;

export class CorrectionReconstruction {
  private readonly weight: SurfaceWeight;

  // gbuffer は重みを測る深度と法線、projection / projectionInverse は実カメラの射影行列とその逆、fullSize と
  // scanSize は描画バッファと走査の解像度 [px]。
  public constructor(
    gbuffer: GBufferPass, projection: Mat4Uniform, projectionInverse: Mat4Uniform,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node,
  ) {
    this.weight = new SurfaceWeight(gbuffer, projection, projectionInverse, fullSize);
  }

  // 描画バッファの解像度で描いている画素の補正を、走査の画面の上で囲む 2×2 の走査の画素から 1 つ選び、その画素の
  // 帯の和を写す。帯ごとの補正は、帯の数 bandCount の補正を詰めたテクスチャ bands から読む。選ぶ確率は双線形の
  // 重み × 面の重みに比例し、choice(0..1)で引く。受け手と同じ面の標本がなければ 0。**Fn の中の、受け手が補正を
  // 受ける分岐から呼ぶこと。**
  public stochasticUpsampled(bands: readonly THREE.Texture[], bandCount: number, choice: FloatNode): Vec3Node {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.weight.receiverAt(pixel);
    // 囲む 4 つの、双線形の重み × 面の重み。
    const { corner, fraction } = this.upsampleCornerOf(pixel);
    const taps = UPSAMPLE_OFFSETS.map(([dx, dy]) => {
      const tap = this.clampToScan(ivec2(corner.add(vec2(dx, dy)))).toVar();
      const exponent = this.weight.exponentOf(receiver, this.gbufferTexelOfScan(tap), float(1));
      return { tap, weight: exp2(exponent.negate()).mul(bilinearWeightOf(fraction, dx, dy)).toVar() };
    });
    const total = float(0).toVar();
    for (const { weight } of taps) total.addAssign(weight);
    // 重みの累積が、choice を両端を除いた区間へ写した値 × 重みの和を初めて超えたタップを選ぶ。
    const threshold = choice.mul(255 / 256).add(0.5 / 256).mul(total).toVar();
    const chosen = ivec2(taps[taps.length - 1]!.tap).toVar();
    const pending = bool(true).toVar();
    const cumulative = float(0).toVar();
    for (const { tap, weight } of taps) {
      cumulative.addAssign(weight);
      If(pending.and(cumulative.greaterThan(threshold)), () => {
        chosen.assign(tap);
        pending.assign(bool(false));
      });
    }
    const bandSum = bandsAt(bands, bandCount, chosen).reduce((sum, band) => sum.add(band));
    return select(total.greaterThan(WEIGHT_EPSILON), bandSum, vec3(0));
  }

  // 描画バッファの画素 pixel の中心を囲む 4 つの走査の画素の中心のうち左上のもの corner と、そこからのずれ
  // fraction [走査の画素]。
  private upsampleCornerOf(pixel: Texel): { readonly corner: Vec2Node; readonly fraction: Vec2Node } {
    // 走査の上の位置 ((2·pixel + 1)·scanSize − fullSize) / (2·fullSize) を整数で割る — 浮動小数の割り算では、解像度が
    // 同じとき整数に乗る位置が下へずれ、左上の隣が重みを持つ。割られる数は fullSize を足して非負にしてある。
    const span = ivec2(this.fullSize).mul(2).toVar();
    const shifted = ivec2(pixel).mul(2).add(1).mul(ivec2(this.scanSize)).add(ivec2(this.fullSize)).toVar();
    const quotient = shifted.div(span).toVar();
    return {
      corner: vec2(quotient.sub(1)).toVar(),
      fraction: vec2(shifted.sub(quotient.mul(span))).div(vec2(span)).toVar(),
    };
  }

  // 走査の画素 texel が表す G バッファの画素。
  private gbufferTexelOfScan(texel: Texel): Texel {
    return gbufferTexelOf(vec2(texel), this.fullSize, this.scanSize);
  }

  // 走査の画素 texel を画面の内側へ寄せる。
  private clampToScan(texel: Texel): Texel {
    return ivec2(clamp(vec2(texel), vec2(0), this.scanSize.sub(1)));
  }
}

// 左上の角からのずれ fraction [走査の画素] の点に対する、角から (dx, dy) の走査の画素の双線形の重み。
function bilinearWeightOf(fraction: Vec2Node, dx: 0 | 1, dy: 0 | 1): FloatNode {
  return (dx === 0 ? fraction.x.oneMinus() : fraction.x).mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
}
