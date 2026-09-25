// 走査の解像度で求めた符号付きの拡散照度補正を、描画バッファの解像度へ joint bilateral で復元する。走査の解像度で
// 近い 5×5 を均し、描画バッファの解像度で囲む 2×2 から拡大する。標本の重みは、標本の面が受け手の接平面から
// どれだけ離れているか(全解像度の画素の足跡で測る)と法線のなす角で半分ずつ落ちる — 補正には受け手ごとの天体照が
// 掛かっているので、内隅や輪郭を越えて混ぜない。
import type * as THREE from 'three/webgpu';
import {
  clamp, dot, exp2, float, floor, getViewPosition, ivec2, max, screenSize, screenUV, select, textureLoad, transpose,
  vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { gbufferTexelOf, texelCenterUV } from './hemisphere-scan';
import type { GBufferPass } from '../gbuffer';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 重みが半分になる法線のなす角 [rad]。接平面からの距離は、全解像度の画素の足跡 1 つで重みが半分になる。
const HALF_WEIGHT_NORMAL_ANGLE = Math.PI / 6;
// 均しの半径と、空間の重みの標準偏差 [走査の画素]。
const DENOISE_RADIUS = 2;
const DENOISE_SIGMA = 1;
// 重みの和がこれ以下なら、受け手と同じ面の標本がないとみなして補正を 0 とする。0 で割らないための値。
const WEIGHT_EPSILON = 1e-6;
// 面の写っていない標本の重みの指数。重みは 0 になる。
const VOID_EXPONENT = 1e4;

type Texel = THREE.Node<'ivec2'>;

// 重みを測る受け手の面。接平面は、逆射影する前の座標 c = (NDC の xy, 素の深度, 1) の一次式で持ち、
// dot(plane, c) / dot(w, c) が c の点の接平面からの符号付きの距離 [m] になる。footprint はそこに写る全解像度の
// 画素 1 つの幅 [m]。
interface Receiver {
  readonly plane: Vec4Node;
  readonly w: Vec4Node;
  readonly normal: Vec3Node;
  readonly footprint: FloatNode;
}

export class CorrectionReconstruction {
  // gbuffer は重みを測る深度と法線、projection / projectionInverse は実カメラの射影行列とその逆、fullSize と
  // scanSize は描画バッファと走査の解像度 [px]。
  public constructor(
    private readonly gbuffer: GBufferPass, private readonly projection: Mat4Uniform,
    private readonly projectionInverse: Mat4Uniform, private readonly fullSize: Vec2Node,
    private readonly scanSize: Vec2Node,
  ) {}

  // 走査の解像度で描いている画素の補正を、近い 5×5 の走査の画素の補正 raw から均す。受け手と同じ面の標本が
  // なければ 0。**Fn の中の、受け手が補正を受ける分岐から呼ぶこと。**
  public denoised(raw: THREE.Texture): Vec3Node {
    // 受け手は描いている画素自身が表す G バッファの画素の面。
    const texel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.receiverAt(this.gbufferTexelOfScan(texel));
    // 空間の重みは、中心からの距離の二項係数に近いガウス関数。
    const sum = new WeightedSum();
    for (let dy = -DENOISE_RADIUS; dy <= DENOISE_RADIUS; dy++) {
      for (let dx = -DENOISE_RADIUS; dx <= DENOISE_RADIUS; dx++) {
        const tap = this.clampToScan(texel.add(ivec2(dx, dy))).toVar();
        const spatial = (dx * dx + dy * dy) * 0.5 * Math.LOG2E / (DENOISE_SIGMA * DENOISE_SIGMA);
        const exponent = this.exponentOf(receiver, this.gbufferTexelOfScan(tap)).add(spatial);
        sum.add(textureLoad(raw, tap).rgb, exponent, float(1));
      }
    }
    return sum.average();
  }

  // 描画バッファの解像度で描いている画素の補正を、走査の画面の上で囲む 2×2 の走査の画素の補正 denoised から、
  // 双線形の重みと面の重みで拡大する。受け手と同じ面の標本がなければ 0。**Fn の中の、受け手が補正を受ける
  // 分岐から呼ぶこと。**
  public upsampled(denoised: THREE.Texture): Vec3Node {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.receiverAt(pixel);
    // 画素の中心を囲む 4 つの走査の画素の中心のうち左上のものと、そこからのずれ [走査の画素]。
    const onScan = vec2(pixel).add(0.5).mul(this.scanSize).div(this.fullSize).sub(0.5).toVar();
    const corner = floor(onScan).toVar();
    const fraction = onScan.sub(corner).toVar();
    const sum = new WeightedSum();
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const tap = this.clampToScan(ivec2(corner.add(vec2(dx, dy)))).toVar();
      const bilinear = (dx === 0 ? fraction.x.oneMinus() : fraction.x)
        .mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
      sum.add(textureLoad(denoised, tap).rgb, this.exponentOf(receiver, this.gbufferTexelOfScan(tap)), bilinear);
    }
    return sum.average();
  }

  // G バッファの画素 texel の面を受け手とする。
  private receiverAt(texel: Texel): Receiver {
    const depth = textureLoad(this.gbuffer.depthTexture, texel).r;
    const position = getViewPosition(texelCenterUV(texel, this.fullSize), depth, this.projectionInverse).toVar();
    const normal = octDecodeNormal(textureLoad(this.gbuffer.normalTexture, texel).rg).toVar();
    // 接平面 normal·p = normal·position と同次座標の w を、逆射影の転置で c の一次式へ写す。
    const toClip = transpose(this.projectionInverse);
    const clipW = this.projection.mul(vec4(position, 1)).w;
    const yScale = this.projection.mul(vec4(0, 1, 0, 0)).y;
    return {
      plane: toClip.mul(vec4(normal, dot(normal, position).negate())).toVar(),
      w: toClip.mul(vec4(0, 0, 0, 1)).toVar(),
      normal,
      footprint: clipW.mul(2).div(yScale.mul(this.fullSize.y)).toVar(),
    };
  }

  // G バッファの画素 texel の面の、受け手 receiver に対する重みの指数(重みは 2^−exponent)。
  private exponentOf(receiver: Receiver, texel: Texel): FloatNode {
    const depth = textureLoad(this.gbuffer.depthTexture, texel).r.toVar();
    const uv = texelCenterUV(texel, this.fullSize);
    const clip = vec4(uv.x.mul(2).sub(1), uv.y.oneMinus().mul(2).sub(1), depth, 1).toVar();
    const plane = dot(receiver.plane, clip).div(dot(receiver.w, clip).mul(receiver.footprint));
    const normal = octDecodeNormal(textureLoad(this.gbuffer.normalTexture, texel).rg);
    const bend = float(1).sub(dot(receiver.normal, normal)).div(1 - Math.cos(HALF_WEIGHT_NORMAL_ANGLE));
    return select(depth.greaterThan(0), plane.mul(plane).add(bend.mul(bend)), float(VOID_EXPONENT));
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

// 標本を重みつきで積む器。**Fn の中で作ること。**
class WeightedSum {
  private readonly sum = vec3(0).toVar();
  private readonly weightSum = float(0).toVar();

  // 値 value を、重み scale·2^−exponent で積む。
  public add(value: Vec3Node, exponent: FloatNode, scale: FloatNode): void {
    const weight = exp2(exponent.negate()).mul(scale).toVar();
    this.sum.addAssign(value.mul(weight));
    this.weightSum.addAssign(weight);
  }

  // 重みつきの平均。重みの和が WEIGHT_EPSILON 以下なら 0。
  public average(): Vec3Node {
    const average = this.sum.div(max(this.weightSum, WEIGHT_EPSILON));
    return select(this.weightSum.greaterThan(WEIGHT_EPSILON), average, vec3(0));
  }
}
