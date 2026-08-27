// 大気を、幾何形状ではなく画面空間のフィルタとして不透明の絵の上へ重ねる。G バッファの深度から
// 復元した位置と視線で大気シェルとの交差を解き、内部散乱と透過率を求めて前乗算アルファで合成する
// (色は乗算済み、アルファは 1 − 透過率)。天体本体による遮蔽も同じ視線のレイ・スフィア交差で
// 解くので、深度テストの精度には依存しない。
//
// 大気を持つ天体は 1 体ぶんだけ受ける。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  and, clamp, dot, exp, float, greaterThan, length, lessThan, max, mix, normalize,
  screenUV, select, smoothstep, sqrt, sub, texture, uniform, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import type { GBufferPass } from './gbuffer';
import type { OcclusionPass } from './occlusion';
import type { SunOcclusion } from './sun-occlusion';
import type { SunLight } from './sun-light';
import { viewPositionAt, viewRayAt } from './view-ray';

// 昼側の大気の色と、昼夜境界で寄っていく夕焼けの色。
const ATMO_COLOR = vec3(0.36, 0.62, 0.91);
const SUNSET_COLOR = vec3(1.0, 0.4, 0.1);
// リム光の可視上限高度・下限高度・指数減衰のスケールハイト [m]。
const RIM_MAX_H = 340e3;
const RIM_MIN_H = 20e3;
const RIM_SCALE_H = 90e3;
// 天体本体による遮蔽境界をぼかす幅 [m](視線の最接近高度で測る)。地表すれすれの視線では
// 奥行きが高度に対して急峻に変化するため、奥行きで測るとぼかし幅が画素未満に潰れる。
const RIM_EDGE_SOFTEN = 25e3;
// リム光の明るさ。下地(宇宙空間)から奪うものが無い加算ぶんなので、透過率ではなく輝度に掛かる。
const RIM_BRIGHTNESS = 0.6;
// 地表付近のもやの濃さ(視線が真上からのときの光学的厚み)。
const HAZE_TAU0 = 0.34;
// 視線が地平線と平行に近づいたときの光路長の上限(cosθ の下限)。
const HAZE_MIN_COS = 0.05;

export class AtmospherePass {
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  // 下地と合成する前の、大気が足す内部散乱だけ(前乗算アルファの色そのもの)。
  private readonly scattered: Vec3Node;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む(light-prepass.ts の逆射影行列と同じ理由)。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;
  private readonly bodyCenter: Vec3Uniform;
  private readonly surfaceRadius: FloatUniform;

  // 大気の合成先は world パスと共有する HDR ターゲットで、前乗算アルファで重ねる。
  // 大気を持つ天体が画面に無いフレームは surfaceRadius が 0 になり、何も足さない。
  constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    sunLight: SunLight,
    sunOcclusion: SunOcclusion,
    occlusion: OcclusionPass,
    private readonly gpu: GpuTimings,
  ) {
    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    this.bodyCenter = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);

    const viewPos = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse);
    const opaquePos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    // 視線は投影方式に依らない形(view-ray.ts)から取る — 平行投影の視線はカメラ位置から
    // 放射状に出ないので、「カメラ位置から復元位置へ」の形では組めない。
    const ray = viewRayAt(this.projMatrixInverse);
    const rayOrigin: Vec3Node = this.viewToWorld.mul(vec4(ray.origin, 1)).xyz;
    const rayDir: Vec3Node = this.viewToWorld.mul(vec4(ray.direction, 0)).xyz;
    const opaqueDist = length(sub(opaquePos, rayOrigin));

    const surface = this.surfaceRadius;
    const shell = surface.add(RIM_MAX_H);
    const toOrigin = sub(rayOrigin, this.bodyCenter);
    const b = dot(toOrigin, rayDir);
    const centerDistSq = dot(toOrigin, toOrigin);

    // 視線と大気シェルの交差のうち奥側。ここが、加算シェルを裏面で描いていたときの面にあたる。
    const shellDisc = b.mul(b).sub(centerDistSq.sub(shell.mul(shell)));
    const shellFar = b.negate().add(sqrt(max(shellDisc, 0)));
    const shellPoint: Vec3Node = rayOrigin.add(rayDir.mul(shellFar));

    // 天体本体による遮蔽。視線が本体を貫くなら、最接近高度で測った幅で縁をぼかして落とす。
    const bodyDisc = b.mul(b).sub(centerDistSq.sub(surface.mul(surface)));
    const bodyNear = b.negate().sub(sqrt(max(bodyDisc, 0)));
    const rayMinDist = sqrt(max(centerDistSq.sub(b.mul(b)), 0));
    const edgeVisible = smoothstep(surface, surface.add(RIM_EDGE_SOFTEN), rayMinDist);
    const occluded = and(greaterThan(bodyDisc, 0), and(greaterThan(bodyNear, 0), lessThan(bodyNear, shellFar)));
    const bodyVisible = select(occluded, edgeVisible, float(1));

    // 大気シェル上の高度による指数減衰と、その点での太陽の当たり方。奥側の交点で測る法線は
    // カメラを向く側 — 地球を背にした視線ほどリムが強く出る、逆光の縁光りになる。
    const inward = normalize(sub(this.bodyCenter, shellPoint));
    const altitudeExcess = max(shell.sub(surface.add(RIM_MIN_H)), 0);
    const falloff = exp(altitudeExcess.div(-RIM_SCALE_H));
    const sunDot = dot(inward, normalize(sub(sunLight.position, shellPoint)));
    // 大気も遮蔽を受ける。**シェル上の点は G バッファの画素位置とは別の点**なので、遮蔽パスが
    // 書いた 1 枚は引けない — 同じ遮蔽関数をこの点で評価し直す。日食のとき月の影が大気にも落ちる。
    const sunFactor: FloatNode = clamp(sunDot, 0, 1)
      .mul(sunOcclusion.transmittance(shellPoint, {
        rings: false, meshNormal: null, selfViewDistance: null,
      }));
    const color: Vec3Node = mix(SUNSET_COLOR, ATMO_COLOR, smoothstep(0, 0.2, sunDot));

    // シェルに当たらない・視線の起点より後ろ・不透明面の方が手前・大気を持つ天体が無いフレーム。
    const inShell = and(greaterThan(shellDisc, 0), greaterThan(shellFar, 0));
    const hasAtmosphere = and(inShell, greaterThan(surface, 0));
    const rim = select(and(hasAtmosphere, lessThan(shellFar, opaqueDist)), falloff.mul(sunFactor).mul(bodyVisible).mul(RIM_BRIGHTNESS), float(0));

    // もや(aerial perspective): 大気層の内側にある不透明面は、視線が地平線に近いほど長い
    // 光路を通って見える。Beer-Lambert 則で haze = 1 − exp(−τ₀/cosθ)。
    const surfaceNormal = normalize(sub(opaquePos, this.bodyCenter));
    const cosTheta = clamp(dot(surfaceNormal, rayDir.negate()), HAZE_MIN_COS, 1);
    const hazeDepth = float(1).sub(exp(float(HAZE_TAU0).div(cosTheta).negate()));
    const hazeSunDot = dot(surfaceNormal, normalize(sub(sunLight.position, opaquePos)));
    const insideShell = lessThan(length(sub(opaquePos, this.bodyCenter)), shell);
    // もやが評価する点は G バッファ深度から復元した位置そのものなので、遮蔽パスが同じ点で
    // 書いた 1 枚をそのまま読む。
    const hazeSunFactor: FloatNode = clamp(hazeSunDot, 0, 1).mul(texture(occlusion.texture, screenUV).r);
    // 奪う割合にも戻る量にも、その空気柱への日の当たり方を掛ける。太陽の高度が低いほど
    // 太陽光自身がより長い大気を通ってくることの近似で、厳密な光路長は Phase 10 の課題。
    const haze = select(and(hasAtmosphere, insideShell), hazeDepth.mul(hazeSunFactor), float(0));
    const hazeColor: Vec3Node = mix(SUNSET_COLOR, ATMO_COLOR, smoothstep(0, 0.2, hazeSunDot))
      .mul(hazeSunFactor);

    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    // 前乗算アルファ: 色は既に割合を掛けた内部散乱、アルファは大気が下地から奪う割合。
    // リム光は下地(宇宙空間)から奪うものが無いので、アルファには入らず加算だけになる。
    this.scattered = color.mul(rim).add(hazeColor.mul(haze));
    this.material.colorNode = this.scattered;
    this.material.opacityNode = haze;
    this.quad = new QuadMesh(this.material);
  }

  // 下地と合成する前の、大気が重ねる内部散乱だけ。「大気」デバッグ表示の合成パスがこのノードを
  // 組み直して映す — このパスは共有ターゲットへ直接重ねるので、単独で見せるための絵はどこにも
  // 残っておらず、**それを残すためだけの描画は足さない**(lens-pass.ts の redistributedLight と同じ)。
  scatteredLight(): Vec3Node { return this.scattered; }

  // 大気を持つ天体の中心(描画座標)と地表半径。radius に 0 を渡すと大気を描かない。
  setBody(center: THREE.Vector3, surfaceRadius: number): void {
    this.bodyCenter.value.copy(center);
    this.surfaceRadius.value = surfaceRadius;
  }

  // 不透明の絵が入った共有ターゲットへ大気を重ねる。
  render(camera: THREE.Camera, sharedTarget: THREE.RenderTarget): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);

    this.renderer.setRenderTarget(sharedTarget);
    this.renderer.autoClear = false;
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.atmosphere);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.material.dispose();
  }
}
