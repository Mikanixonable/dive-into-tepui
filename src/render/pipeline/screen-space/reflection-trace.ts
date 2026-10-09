// 滑らかな面の画素 1 つから鏡の向きへ ray を 1 本出し、画面に写った深度の上を進めて、近くの物体に当たった位置と
// 距離、その像が遠方の鏡面光を置き換える重み w を求める。ray は画面空間で透視補正した刻みで進める(McGuire &
// Mara 2014「Efficient GPU Screen-Space Ray Tracing」)。判定は幾何 — 深度と、反射する面の位置・向き・粗さ —
// だけから決まる。
import type * as THREE from 'three/webgpu';
import {
  Break, If, Loop, dot, float, floor, ivec2, length, max, min, mix, select, smoothstep, textureLoad, vec2, vec4,
} from 'three/tsl';
import type { ShadingSample } from '../lighting/shading-sample';
import type { FloatNode, IntNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';

// 近くの物体として映す距離の上限 [m]。艦艇・基地の規模の構造は収め、天体には届かない長さ — 天体の鏡面像は
// 天体照の光源が持つ。
const MAX_TRACE_DISTANCE = 1000;
// 距離のフェードを始める、上限に対する割合。
const DISTANCE_FADE_START = 0.8;

// ray thickness: 深度に写った面がその奥へ続くとみなす厚みの、面の view 空間の奥行き |z| に対する割合。深度は
// 面の手前側しか持たないので、ray が面の奥へ入ったとき、この厚みの内側なら物体に当たった、外側なら物体の後ろを
// 抜けたとみなす。奥行きに比例させるのは、同じ見かけの大きさの物体は奥行きに比例した厚みを持つため — 厚みを
// 長さで固定すると、写る物体の規模(m の荷室から km の構造まで)ごとに当たり方が変わる。
const THICKNESS_PER_DISTANCE = 0.05;
// ray の起点を面の法線の向きへ浮かせる量の、面の奥行き |z| に対する割合。深度の量子化と縮小で、起点の面が
// 隣の画素で自分自身を遮らないための逃げ。
const ORIGIN_OFFSET_PER_DISTANCE = 1e-3;

// 当たった位置が画面の縁からこの幅 [uv] の内側にあれば、縁へ向けて重みを 0 へ落とす — 画面の外の物体は
// 映せないので、縁で像が切れて見えないようにする。
const EDGE_FADE_WIDTH = 0.1;
// 知覚的粗さがこの値までの面には全量を映し、NO_REFLECTION_ROUGHNESS で 0 にする。
const FULL_REFLECTION_ROUGHNESS = 0.3;
const NO_REFLECTION_ROUGHNESS = 0.6;
// 鏡の向きと視点への向きの余弦がこの範囲で、重みを 0 へ落とす。視点へ戻る ray が映すのはカメラの後ろで、
// 画面に写っていない。
const CAMERA_FACING_FADE_START = 0.6;
const CAMERA_FACING_FADE_END = 0.9;
// 当たった刻みの区間を二分して、当たった位置を詰める回数。
const REFINE_STEPS = 4;

// 判定の結果。当たらなかった画素ではどれも 0。
export interface ReflectionHit {
  // 当たった深度の画素の中心の uv(0..1、上端が原点)。
  readonly hitUV: Vec2Node;
  // 反射する面から当たった点までの view 空間の距離 [m]。
  readonly distance: FloatNode;
  // 置換の重み w = 粗さ × 画面の縁 × 距離 × 当たりの確からしさ。
  readonly weight: FloatNode;
}

// 面 sample の鏡の向きの ray を、寸法 traceSize [px] の素の深度 depth(逆 Z、虚空は 0)の上で stepCount 歩
// 進めて判定する。projection / projectionInverse は実カメラの射影行列とその逆、near は近クリップ距離 [m]、
// jitter は画素ごとの 0..1 で、歩みの位置をずらす。粗さが NO_REFLECTION_ROUGHNESS 以上の面は進めずに 0 を返す。
// **Fn の中から、面が写っている画素について呼ぶこと。**
export function traceReflection(
  depth: THREE.Texture, traceSize: Vec2Node, projection: Mat4Uniform, projectionInverse: Mat4Uniform,
  near: FloatNode, stepCount: IntNode, jitter: FloatNode, sample: ShadingSample,
): ReflectionHit {
  const hitUV = vec2(0).toVar();
  const distance = float(0).toVar();
  const weight = float(0).toVar();
  const direction = sample.reflected.toVar();
  // 当たり方によらない重み。0 の面は追跡を打ち切る。
  const roughnessFade = float(1).sub(smoothstep(FULL_REFLECTION_ROUGHNESS, NO_REFLECTION_ROUGHNESS, sample.roughness));
  const facingFade = float(1).sub(
    smoothstep(CAMERA_FACING_FADE_START, CAMERA_FACING_FADE_END, dot(direction, sample.viewDir)));
  const surfaceWeight = roughnessFade.mul(facingFade).toVar();
  If(surfaceWeight.greaterThan(0), () => {
    // ray の両端。視点へ向かう ray は近クリップ面で止める — その先は透視の除算が裏返る。
    const origin = sample.position.add(sample.normal.mul(sample.position.z.negate().mul(ORIGIN_OFFSET_PER_DISTANCE)))
      .toVar();
    const toNearPlane = select(direction.z.greaterThan(0),
      near.negate().sub(origin.z).div(max(direction.z, 1e-6)), float(MAX_TRACE_DISTANCE));
    const end = origin.add(direction.mul(max(min(toNearPlane, MAX_TRACE_DISTANCE), 0))).toVar();
    const segment = new ScreenSegment(origin, end, projection, traceSize);
    // 画面の中を、起点の画素を出たところから手前の刻みと今の刻みのあいだの奥行きで深度と比べる。
    const startCell = floor(segment.start).toVar();
    const previousT = float(0).toVar();
    const previousZ = origin.z.toVar();
    const hitT = float(-1).toVar();
    Loop({ start: 0, end: stepCount, type: 'int', condition: '<' }, ({ i }) => {
      const t = float(i).add(jitter).div(float(stepCount)).mul(segment.onScreen).toVar();
      const cell = segment.cellAt(t).toVar();
      const rayZ = segment.viewZAt(t).toVar();
      const sceneDepth = textureLoad(depth, ivec2(cell)).r.toVar();
      const leftStart = cell.x.notEqual(startCell.x).or(cell.y.notEqual(startCell.y));
      If(leftStart.and(sceneDepth.greaterThan(0)), () => {
        const sceneZ = viewZOf(sceneDepth, projectionInverse).toVar();
        const nearZ = max(previousZ, rayZ);
        const farZ = min(previousZ, rayZ);
        If(farZ.lessThan(sceneZ).and(nearZ.greaterThan(sceneZ.add(sceneZ.mul(THICKNESS_PER_DISTANCE)))), () => {
          hitT.assign(t);
          Break();
        });
      });
      previousT.assign(t);
      previousZ.assign(rayZ);
    });
    If(hitT.greaterThanEqual(0), () => {
      // 手前の刻み(深度の手前)と当たった刻み(深度の奥)のあいだを二分する。
      const low = previousT.toVar();
      const high = hitT.toVar();
      Loop(REFINE_STEPS, () => {
        const middle = low.add(high).mul(0.5).toVar();
        const sceneDepth = textureLoad(depth, ivec2(segment.cellAt(middle))).r.toVar();
        const behind = sceneDepth.greaterThan(0)
          .and(segment.viewZAt(middle).lessThan(viewZOf(sceneDepth, projectionInverse)));
        If(behind, () => {
          high.assign(middle);
        }).Else(() => {
          low.assign(middle);
        });
      });
      hitUV.assign(segment.cellAt(high).add(0.5).div(traceSize));
      distance.assign(length(segment.viewPositionAt(high).sub(origin)));
      // 当たった位置が画面の縁と距離の上限に近いほど、重みを 0 へ落とす。
      const edge = min(min(hitUV.x, hitUV.y), min(hitUV.x.oneMinus(), hitUV.y.oneMinus()));
      const edgeFade = smoothstep(0, EDGE_FADE_WIDTH, edge);
      const distanceFade = float(1).sub(
        smoothstep(MAX_TRACE_DISTANCE * DISTANCE_FADE_START, MAX_TRACE_DISTANCE, distance));
      weight.assign(surfaceWeight.mul(edgeFade).mul(distanceFade));
    });
  });
  return { hitUV, distance, weight };
}

// view 空間の線分 origin → end を、寸法 size [px] の画面へ写した線分。画面上の位置で線形に補間した t(0..1)で、
// 透視補正した view 空間の点を引ける。
class ScreenSegment {
  // 起点と終点の画面上の位置 [px]。
  public readonly start: Vec2Node;
  private readonly span: Vec2Node;
  // 透視補正の補間量 — 1/w と、view 空間の点に 1/w を掛けたもの。画面上の位置について線形。
  private readonly startK: FloatNode;
  private readonly endK: FloatNode;
  private readonly startQ: Vec3Node;
  private readonly endQ: Vec3Node;
  // 線分のうち画面の中にある t の上限。起点は画面の中にある。
  public readonly onScreen: FloatNode;

  // **Fn の中で作ること** — 両端の値を変数へ置く。
  public constructor(origin: Vec3Node, end: Vec3Node, projection: Mat4Uniform, size: Vec2Node) {
    // 両端のクリップ座標と、透視補正の補間量。
    const startClip = projection.mul(vec4(origin, 1)).toVar();
    const endClip = projection.mul(vec4(end, 1)).toVar();
    this.startK = float(1).div(startClip.w).toVar();
    this.endK = float(1).div(endClip.w).toVar();
    this.startQ = origin.mul(this.startK).toVar();
    this.endQ = end.mul(this.endK).toVar();
    // 画面上の両端と、画面の中に残る割合。
    this.start = pixelOf(startClip.xy.mul(this.startK), size).toVar();
    this.span = pixelOf(endClip.xy.mul(this.endK), size).sub(this.start).toVar();
    this.onScreen = min(min(exitFraction(this.start.x, this.span.x, size.x),
      exitFraction(this.start.y, this.span.y, size.y)), 1).toVar();
  }

  // t の画面上の画素(整数座標)。
  public cellAt(t: FloatNode): Vec2Node { return floor(this.start.add(this.span.mul(t))); }

  // t の view 空間の奥行き z。
  public viewZAt(t: FloatNode): FloatNode {
    return mix(this.startQ.z, this.endQ.z, t).div(mix(this.startK, this.endK, t));
  }

  // t の view 空間の点。
  public viewPositionAt(t: FloatNode): Vec3Node {
    return mix(this.startQ, this.endQ, t).div(mix(this.startK, this.endK, t));
  }
}

// NDC の xy を、寸法 size [px] の画面の位置 [px](上端が原点)へ写す。
function pixelOf(ndc: Vec2Node, size: Vec2Node): Vec2Node {
  return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).mul(size);
}

// 画面の中の位置 start [px] から delta [px] 進む線分が、幅 size [px] の画面を出る割合。出ないなら 1 以上。
function exitFraction(start: FloatNode, delta: FloatNode, size: FloatNode): FloatNode {
  // 画面の端の画素の中で止める — 端ちょうどの位置は floor で画面の外の画素になる。
  const toEdge = select(delta.greaterThan(0), size.sub(1e-3).sub(start), start.negate());
  return select(delta.equal(0), float(1), max(toEdge.div(delta), 0));
}

// 素の深度 depth(逆 Z)の面の view 空間の奥行き z。透視でも平行投影でも、z は画面上の位置によらない。
function viewZOf(depth: FloatNode, projectionInverse: Mat4Uniform): FloatNode {
  const position = projectionInverse.mul(vec4(0, 0, depth, 1));
  return position.z.div(position.w);
}
