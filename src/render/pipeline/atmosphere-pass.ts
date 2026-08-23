// 大気を、幾何形状ではなく画面空間のフィルタとして不透明の絵の上へ重ねる。G バッファの深度から
// 復元した位置と視線で大気シェルとの交差を解き、内部散乱と透過率を求めて前乗算アルファで合成する
// (色は乗算済み、アルファは 1 − 透過率)。天体本体による遮蔽も同じ視線のレイ・スフィア交差で
// 解くので、深度テストの精度には依存しない。
//
// 大気を持つ天体は 1 体ぶんだけ受ける。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  and, clamp, dot, exp, float, getViewPosition, greaterThan, length, lessThan, max, mix, normalize,
  screenUV, select, smoothstep, sqrt, sub, texture, uniform, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import type { GBufferPass } from './gbuffer';
import type { SunLight } from './sun-light';

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
const RIM_OPACITY = 0.6;

export class AtmospherePass {
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
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
    private readonly gpu: GpuTimings,
  ) {
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    });
    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    this.bodyCenter = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);

    const rawDepth = texture(gbuffer.depthTexture, screenUV).r;
    const viewPos = getViewPosition(screenUV, rawDepth, this.projMatrixInverse);
    const opaquePos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    // カメラは描画座標の原点にいるので、不透明面の位置がそのまま視線になる。
    const opaqueDist = length(opaquePos);
    const rayDir = normalize(opaquePos);

    const surface = this.surfaceRadius;
    const shell = surface.add(RIM_MAX_H);
    const toCamera = this.bodyCenter.negate();
    const b = dot(toCamera, rayDir);
    const centerDistSq = dot(toCamera, toCamera);

    // 視線と大気シェルの交差のうち奥側。ここが、加算シェルを裏面で描いていたときの面にあたる。
    const shellDisc = b.mul(b).sub(centerDistSq.sub(shell.mul(shell)));
    const shellFar = b.negate().add(sqrt(max(shellDisc, 0)));
    const shellPoint: Vec3Node = rayDir.mul(shellFar);

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
    const sunFactor: FloatNode = clamp(sunDot, 0, 1);
    const color: Vec3Node = mix(SUNSET_COLOR, ATMO_COLOR, smoothstep(0, 0.2, sunDot));

    // シェルに当たらない・カメラの後ろ・不透明面の方が手前・大気を持つ天体が無いフレーム。
    const present = and(greaterThan(shellDisc, 0), and(greaterThan(shellFar, 0), lessThan(shellFar, opaqueDist)));
    const rim = select(and(present, greaterThan(surface, 0)), falloff.mul(sunFactor).mul(bodyVisible).mul(RIM_OPACITY), float(0));

    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    // 前乗算アルファ: 色は透過率を掛けたあとの内部散乱、アルファは大気が奪う割合。
    // リム光は奪わない(アルファ 0)ので、そのまま加算になる。
    this.material.colorNode = color.mul(rim);
    this.material.opacityNode = float(0);
    this.quad = new QuadMesh(this.material);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  // 大気を持つ天体の中心(描画座標)と地表半径。radius に 0 を渡すと大気を描かない。
  setBody(center: THREE.Vector3, surfaceRadius: number): void {
    this.bodyCenter.value.copy(center);
    this.surfaceRadius.value = surfaceRadius;
  }

  // 不透明の絵が入った共有ターゲットへ大気を重ねる。showDebugTarget が立っているときだけ、
  // 同じフィルタを専用のターゲットへも単独で描く。
  render(
    camera: THREE.Camera,
    sharedTarget: THREE.RenderTarget,
    width: number,
    height: number,
    showDebugTarget: boolean,
  ): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);

    if (showDebugTarget) {
      if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
      this.renderer.setRenderTarget(this.target);
      this.renderer.autoClear = true;
      this.gpu.beginPass(GPU_PASS.atmosphere);
      this.quad.render(this.renderer);
    }

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
    this.target.dispose();
    this.material.dispose();
  }
}
