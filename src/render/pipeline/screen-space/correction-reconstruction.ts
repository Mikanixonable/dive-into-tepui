// 走査の解像度で求めた符号付きの拡散照度補正を、受け手の面の重み(SurfaceWeight)で描画バッファの解像度へ復元する
// 段の部品。補正には受け手ごとの天体照が掛かっているので、内隅や輪郭を越えて混ぜない。
import type * as THREE from 'three/webgpu';
import {
  If, abs, clamp, cos, dot, exp2, float, floor, ivec2, length, max, min, normalize, round, screenSize, screenUV,
  select, sin, textureLoad, vec2, vec3,
} from 'three/tsl';
import { VOID_EXPONENT, type SurfaceReceiver, type SurfaceWeight } from './surface-weight';
import { projectedRadius } from './hemisphere-scan';
import type { ScanSurfaces, Texel, TexelSurface } from './texel-surface';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';

// 最後の拡大で読む疎なタップの数と、タップ間の黄金角 [rad]。
const UPSAMPLE_TAP_COUNT = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// 拡大の半径の下限 [全解像度の画素]。走査の解像度に起因するエイリアスを隠すので、受け手の距離によらず画面の画素で固定する。
const UPSAMPLE_FLOOR_RADIUS = 12 / Math.SQRT2;
// 補正が均されていない分の輝点を慣らす半径の、受け手の近傍の投影半径に対する比。
const UPSAMPLE_RADIUS_PER_PROJECTED_RADIUS = 0.0351;
// 拡大の楕円の異方性の柔らかさ a — 短い半軸を (a + c)/(a + 1) 倍、長い半軸をその逆数倍にする。c は受け手の法線と
// 視線のなす角の余弦。
const UPSAMPLE_ANISOTROPY_SOFTNESS = 1 / 2;
// 拡大の面の重みの、法線の重みが半分になる角 [rad](20°)。
const UPSAMPLE_HALF_WEIGHT_ANGLE = Math.PI / 9;

export class CorrectionReconstruction {
  // weight は受け手と標本の面の重み、surfaces は標本の面を読む走査の解像度の面、fullSize と scanSize は描画バッファと
  // 走査の解像度 [px]、projection は走査と同じ射影行列。
  public constructor(
    private readonly weight: SurfaceWeight, private readonly surfaces: ScanSurfaces,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node, private readonly projection: Mat4Uniform,
    private readonly forceAlphaOne: FloatNode,
  ) {}

  // 描画バッファの画素の補正を、走査の画素の補正 source(rgb。α は粗い段まで均された割合 A)から K 本を疎に読み、面の
  // 重みで平均して求める。タップは受け手の面を画面に写した楕円(surfaceEllipseOf)に黄金角の螺旋で置き、半径は受け手の
  // 近傍の投影半径に比例させ、最寄りの走査の画素の A が大きいほど縮める。rotation(0..1)は画素ごとに独立な螺旋の回転。
  // 空だけなら最寄りの走査の画素へ延長する。
  // **Fn の中の、受け手が補正を受ける分岐から呼ぶこと。**
  public sparseUpsampled(source: THREE.Texture, rotation: FloatNode): Vec3Node {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.weight.receiverAt(this.weight.surfaceAt(pixel));
    const position = vec2(pixel).add(0.5).mul(this.scanSize).div(this.fullSize).sub(0.5).toVar();
    const scale = this.scanSize.div(this.fullSize).toVar();
    const nearest = textureLoad(source, this.clampToScan(ivec2(round(position)))).toVar();
    const projected = projectedRadius(receiver.position, this.projection, this.fullSize);
    const share = select(this.forceAlphaOne.greaterThan(0.5), float(1), clamp(nearest.a, 0, 1));
    const radius = max(float(UPSAMPLE_FLOOR_RADIUS),
      projected.mul(UPSAMPLE_RADIUS_PER_PROJECTED_RADIUS).mul(float(1).sub(share)));
    const { across, along } = this.surfaceEllipseOf(receiver, radius);
    const angle = rotation.mul(2 * Math.PI).toVar();
    const cosAngle = cos(angle).toVar();
    const sinAngle = sin(angle).toVar();
    const taps = Array.from({ length: UPSAMPLE_TAP_COUNT }, (_, index) => {
      // 単位円盤の螺旋の点。中心を空けて、どのタップも画素ごとに回す。
      const radial = Math.sqrt((index + 0.5) / UPSAMPLE_TAP_COUNT);
      const x = radial * Math.cos(index * GOLDEN_ANGLE);
      const y = radial * Math.sin(index * GOLDEN_ANGLE);
      const offset = across.mul(cosAngle.mul(x).sub(sinAngle.mul(y)))
        .add(along.mul(sinAngle.mul(x).add(cosAngle.mul(y)))).mul(scale);
      const tap = this.clampToScan(ivec2(round(position.add(offset)))).toVar();
      const scanSurface = this.surfaces.scanSurfaceAt(tap);
      const surface: TexelSurface = { ...scanSurface, texel: scanSurface.texel.toVar() };
      const tolerance = max(length(vec2(surface.texel.sub(pixel))), 1);
      const exponent = this.weight.exponentOf(receiver, surface, tolerance,
        float(UPSAMPLE_HALF_WEIGHT_ANGLE)).toVar();
      return { tap, exponent };
    });
    // 指数の最小値を引くと、全タップの重みが float の丸めで 0 になる場合も平均を保てる。
    const least = float(VOID_EXPONENT).toVar();
    for (const { exponent } of taps) least.assign(min(least, exponent));
    const result = vec3(0).toVar();
    If(least.lessThan(VOID_EXPONENT), () => {
      const sum = vec3(0).toVar();
      const total = float(0).toVar();
      for (const { tap, exponent } of taps) {
        const weight = select(exponent.lessThan(VOID_EXPONENT), exp2(least.sub(exponent)), float(0));
        sum.addAssign(textureLoad(source, tap).rgb.mul(weight));
        total.addAssign(weight);
      }
      result.assign(sum.div(total));
    }).Else(() => {
      result.assign(nearest.rgb);
    });
    return result;
  }

  // 受け手 receiver の面の上の円を画面に写した楕円の、面積が半径 radius の円と同じ半軸 [全解像度の画素] — 法線を画面へ
  // 写した向きの across と、それに垂直な along。法線が視線から傾くほど across が縮み、along が同じ比で伸びる
  // (UPSAMPLE_ANISOTROPY_SOFTNESS)。
  private surfaceEllipseOf(
    receiver: SurfaceReceiver, radius: FloatNode,
  ): { readonly across: Vec2Node; readonly along: Vec2Node } {
    const view = normalize(receiver.position).toVar();
    const facing = abs(dot(receiver.normal, view));
    // 法線の視線に垂直な成分を透視で画面へ写した向き(画面の y は下向き)。受け手が正面を向くと定まらないので x 軸にする。
    const tangent = receiver.normal.sub(view.mul(dot(receiver.normal, view))).toVar();
    const projected = tangent.xy.sub(receiver.position.xy.mul(tangent.z.div(receiver.position.z))).mul(vec2(1, -1))
      .toVar();
    const projectedLength = length(projected);
    const direction = select(projectedLength.greaterThan(1e-6), projected.div(projectedLength), vec2(1, 0)).toVar();
    const squash = facing.add(UPSAMPLE_ANISOTROPY_SOFTNESS).div(1 + UPSAMPLE_ANISOTROPY_SOFTNESS).toVar();
    return {
      across: direction.mul(radius.mul(squash)),
      along: vec2(direction.y.negate(), direction.x).mul(radius.div(squash)),
    };
  }

  // 走査の画素 texel を画面の内側へ寄せる。
  private clampToScan(texel: Texel): Texel {
    return ivec2(clamp(vec2(texel), vec2(0), this.scanSize.sub(1)));
  }
}
