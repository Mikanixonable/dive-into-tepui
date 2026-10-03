// 受け手の面に対する、G バッファの画素の面の重み。受け手の接平面から離れた面と、向きの違う面の重みを落とす。
import type * as THREE from 'three/webgpu';
import { cos, dot, float, getViewPosition, select, textureLoad, transpose, vec4 } from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { texelCenterUV } from './hemisphere-scan';
import type { GBufferPass } from '../gbuffer';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 面の写っていない標本の重みの指数。重みは 0 になる。
const VOID_EXPONENT = 1e4;

// G バッファの画素の整数座標。
export type Texel = THREE.Node<'ivec2'>;

// 重みを測る受け手の面。texel は受け手の G バッファの画素。接平面は、逆射影する前の座標 c = (NDC の xy, 素の深度, 1) の
// 一次式で持ち、dot(plane, c) / dot(w, c) が c の点の接平面からの符号付きの距離 [m] になる。footprint はそこに写る
// 全解像度の画素 1 つの幅 [m]。
export interface SurfaceReceiver {
  readonly texel: Texel;
  readonly plane: Vec4Node;
  readonly w: Vec4Node;
  readonly normal: Vec3Node;
  readonly footprint: FloatNode;
}

export class SurfaceWeight {
  // gbuffer は重みを測る深度と法線、projection / projectionInverse は実カメラの射影行列とその逆、fullSize は描画バッファの
  // 解像度 [px]。
  public constructor(
    private readonly gbuffer: GBufferPass, private readonly projection: Mat4Uniform,
    private readonly projectionInverse: Mat4Uniform, private readonly fullSize: Vec2Node,
  ) {}

  // G バッファの画素 texel の面を受け手とする。
  public receiverAt(texel: Texel): SurfaceReceiver {
    const depth = textureLoad(this.gbuffer.depthTexture, texel).r;
    const position = getViewPosition(texelCenterUV(texel, this.fullSize), depth, this.projectionInverse).toVar();
    const normal = octDecodeNormal(textureLoad(this.gbuffer.normalTexture, texel).rg).toVar();
    // 接平面 normal·p = normal·position と同次座標の w を、逆射影の転置で c の一次式へ写す。
    const toClip = transpose(this.projectionInverse);
    const clipW = this.projection.mul(vec4(position, 1)).w;
    const yScale = this.projection.mul(vec4(0, 1, 0, 0)).y;
    return {
      texel,
      plane: toClip.mul(vec4(normal, dot(normal, position).negate())).toVar(),
      w: toClip.mul(vec4(0, 0, 0, 1)).toVar(),
      normal,
      footprint: clipW.mul(2).div(yScale.mul(this.fullSize.y)).toVar(),
    };
  }

  // 受け手 receiver に対する、G バッファの画素 texel の面の重みの指数(重みは 2^−exponent)。接平面からの距離が受け手の
  // 足跡 × tolerance のとき、法線のなす角が halfWeightAngle [rad] のときに、それぞれ重みが半分になる。面の写って
  // いない画素の重みは 0。
  public exponentOf(
    receiver: SurfaceReceiver, texel: Texel, tolerance: FloatNode, halfWeightAngle: FloatNode,
  ): FloatNode {
    const depth = textureLoad(this.gbuffer.depthTexture, texel).r.toVar();
    const uv = texelCenterUV(texel, this.fullSize);
    const clip = vec4(uv.x.mul(2).sub(1), uv.y.oneMinus().mul(2).sub(1), depth, 1).toVar();
    const plane = dot(receiver.plane, clip).div(dot(receiver.w, clip).mul(receiver.footprint.mul(tolerance)));
    const normal = octDecodeNormal(textureLoad(this.gbuffer.normalTexture, texel).rg);
    const bend = float(1).sub(dot(receiver.normal, normal)).div(float(1).sub(cos(halfWeightAngle)));
    return select(depth.greaterThan(0), plane.mul(plane).add(bend.mul(bend)), float(VOID_EXPONENT));
  }
}
