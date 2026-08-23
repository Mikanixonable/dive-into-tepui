// G バッファの深度から画素ごとの描画座標を復元し、そこへ恒星の直射光がどれだけ届くかを
// 1 枚の透過率へ書く。遮蔽するのは天体の球(本影・半影)と環の帯で、合成は透過率の積。
// ライティングパスはこの 1 枚を読んで恒星の放射照度へ掛ける。
//
// 遮蔽器は毎フレーム呼び出し側が選んで渡す。天体の球は MAX_OCCLUDERS 体、環は 1 体ぶんの
// MAX_RING_BANDS 帯まで — 環付き天体が画面に複数写る状況は実質起きないため、環は最も
// 目立つ 1 体だけを受ける。
//
// 受け手が乗っている天体自身も遮蔽器に数える。昼側は「中心が太陽と逆側」で早々に外れ、
// 夜側は本影として落ちるので破綻しないが、昼夜境界では N·L と幾何遮蔽が二重に効く。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  Fn, PI, abs, acos, and, asin, clamp, dot, exp, float, getViewPosition, greaterThan, length,
  lessThan, max, min, normalize, screenUV, select, sqrt, texture, uniform, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import type { GBufferPass } from './gbuffer';
import type { SunLight } from './sun-light';

export const MAX_OCCLUDERS = 4;
export const MAX_RING_BANDS = 32;

// 環の帯 1 本。半径は描画座標と同じメートル、tau は環面に垂直な光学的深さ。
export type RingBand = {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly normalOpticalDepth: number;
};

// 遮蔽する天体 1 体。中心は描画座標。
export type Occluder = {
  readonly center: THREE.Vector3;
  readonly radius: number;
};

type OccluderUniforms = { readonly center: Vec3Uniform; readonly radius: FloatUniform };
type RingBandUniforms = {
  readonly inner: FloatUniform;
  readonly outer: FloatUniform;
  readonly tau: FloatUniform;
  readonly active: FloatUniform;
};

// 環面と視線の交差判定が発散しないよう、環面と太陽方向のなす角の余弦へ入れる下限。
const RING_GRAZING_MIN = 0.015;

// 半径 r1・r2 の 2 円が中心距離 d で重なる面積(すべて同じ角度単位)。
const circleOverlapArea = Fn(([r1, r2, d]: readonly FloatNode[]) => {
  const safeD = max(d!, 1e-12);
  const d1 = safeD.mul(safeD).sub(r2!.mul(r2!)).add(r1!.mul(r1!)).div(safeD.mul(2));
  const d2 = safeD.sub(d1);
  const lens = (r: FloatNode, h: FloatNode) => r.mul(r).mul(acos(clamp(h.div(max(r, 1e-12)), -1, 1)))
    .sub(h.mul(sqrt(max(r.mul(r).sub(h.mul(h)), 0))));
  const contained = PI.mul(min(r1!, r2!).mul(min(r1!, r2!)));
  return select(
    greaterThan(d!, r1!.add(r2!)), float(0),
    select(lessThan(d!, abs(r1!.sub(r2!))), contained, lens(r1!, d1).add(lens(r2!, d2))),
  );
});

// 点 p から見た恒星円盤のうち、球 (center, radius) に遮られずに残る面積比 0..1。
// physics/shadow.ts の occludedFraction と同じ式で、本影・金環・半影・完全日照が
// 場合分け無しに1つの閉じた形から出る。
const sphereTransmittance = Fn((
  [p, sunDir, sunDist, sunAngRadius, center, radius]: readonly [Vec3Node, Vec3Node, FloatNode, FloatNode, Vec3Node, FloatNode],
) => {
  const toCenter = center.sub(p);
  const along = dot(toCenter, sunDir);
  const dist = max(length(toCenter), 1e-6);
  const occAngRadius = asin(clamp(radius.div(dist), 0, 1));
  const separation = acos(clamp(along.div(dist), -1, 1));
  const overlap = circleOverlapArea(sunAngRadius, occAngRadius, separation);
  const lit = clamp(float(1).sub(overlap.div(PI.mul(sunAngRadius).mul(sunAngRadius))), 0, 1);
  // 半径 0 の空きスロット、恒星より遠い側/背後にある天体、視点が天体の内側にある場合。
  const outOfPlay = lessThan(radius, 1).or(lessThan(along, 0)).or(greaterThan(along, sunDist));
  return select(outOfPlay, float(1), select(lessThan(dist, radius), float(0), lit));
});

// 点 p から恒星へ向かう視線が環の帯 (inner, outer) を横切るときの透過率。
const ringTransmittance = Fn((
  [p, sunDir, center, axis, inner, outer, tau, active]: readonly [Vec3Node, Vec3Node, Vec3Node, Vec3Node, FloatNode, FloatNode, FloatNode, FloatNode],
) => {
  const cosIncidence = dot(axis, sunDir);
  const grazingSafe = select(
    greaterThan(cosIncidence, 0), max(cosIncidence, RING_GRAZING_MIN), min(cosIncidence, -RING_GRAZING_MIN),
  );
  const planeDistance = dot(p.sub(center), axis).negate().div(grazingSafe);
  const radial = length(p.add(sunDir.mul(planeDistance)).sub(center));
  const inside = and(
    greaterThan(planeDistance, 0),
    and(greaterThan(radial, inner), lessThan(radial, outer)),
  );
  const transmission = exp(tau.div(max(abs(cosIncidence), RING_GRAZING_MIN)).negate());
  return select(and(inside, greaterThan(active, 0.5)), transmission, float(1));
});

export class OcclusionPass {
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む(light-prepass.ts の逆射影行列と同じ理由)。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;
  private readonly occluders: readonly OccluderUniforms[];
  private readonly ringCenter: Vec3Uniform;
  private readonly ringAxis: Vec3Uniform;
  private readonly ringBands: readonly RingBandUniforms[];

  // 透過率の書き込み先と、遮蔽器・環の帯ぶんの uniform を確保し、それらを畳み込む
  // シェーダグラフを一度だけ組む。件数は固定なので、遮蔽器や帯が増減してもグラフは変わらない。
  constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    sunLight: SunLight,
    private readonly gpu: GpuTimings,
  ) {
    this.target = new THREE.RenderTarget(1, 1, {
      format: THREE.RedFormat, type: THREE.HalfFloatType, depthBuffer: false, samples: 0,
    });

    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    this.occluders = Array.from({ length: MAX_OCCLUDERS }, () => ({
      center: uniform(new THREE.Vector3()),
      radius: uniform(0),
    }));
    this.ringCenter = uniform(new THREE.Vector3());
    this.ringAxis = uniform(new THREE.Vector3(0, 1, 0));
    this.ringBands = Array.from({ length: MAX_RING_BANDS }, () => ({
      inner: uniform(0),
      outer: uniform(0),
      tau: uniform(0),
      active: uniform(0),
    }));

    const rawDepth = texture(gbuffer.depthTexture, screenUV).r;
    const viewPos = getViewPosition(screenUV, rawDepth, this.projMatrixInverse);
    const worldPos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    const toSun = sunLight.position.sub(worldPos);
    const sunDist = max(length(toSun), 1);
    const sunDir = normalize(toSun);
    const sunAngRadius = asin(clamp(sunLight.radius.div(sunDist), 1e-9, 1));

    let transmittance: FloatNode = float(1);
    for (const occluder of this.occluders) {
      transmittance = transmittance.mul(
        sphereTransmittance(worldPos, sunDir, sunDist, sunAngRadius, occluder.center, occluder.radius),
      );
    }
    for (const band of this.ringBands) {
      transmittance = transmittance.mul(
        ringTransmittance(worldPos, sunDir, this.ringCenter, this.ringAxis, band.inner, band.outer, band.tau, band.active),
      );
    }
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.colorNode = vec4(vec3(transmittance), 1);
    this.quad = new QuadMesh(this.material);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  // このフレームで遮蔽器として扱う天体の列(描画座標)。MAX_OCCLUDERS を超えた分は捨てる。
  setOccluders(occluders: readonly Occluder[]): void {
    for (const [i, slot] of this.occluders.entries()) {
      const occluder = occluders[i];
      slot.radius.value = occluder === undefined ? 0 : occluder.radius;
      if (occluder !== undefined) slot.center.value.copy(occluder.center);
    }
  }

  // 環の影を落とす天体 1 体ぶんの帯。center/axis は描画座標、bands が空なら影は落ちない。
  setRings(center: THREE.Vector3, axis: THREE.Vector3, bands: readonly RingBand[]): void {
    this.ringCenter.value.copy(center);
    this.ringAxis.value.copy(axis).normalize();
    for (const [i, slot] of this.ringBands.entries()) {
      const band = bands[i];
      slot.active.value = band === undefined ? 0 : 1;
      if (band === undefined) continue;
      slot.inner.value = band.innerRadius;
      slot.outer.value = band.outerRadius;
      slot.tau.value = band.normalOpticalDepth;
    }
  }

  // G バッファの深度だけを読んで透過率を書く(フルスクリーン1枚)。camera は逆射影行列と
  // view→描画座標の行列を毎フレーム引き直すためだけに使う。
  render(camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);

    this.renderer.setRenderTarget(this.target);
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.occlusion);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
