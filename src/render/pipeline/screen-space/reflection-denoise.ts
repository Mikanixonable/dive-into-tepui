// 映り込みを粗さに応じて均す。縮小列の段を粗い側から 1 段ずつ合流し、全解像度の最後のパスで段 1 の合流値を受け手の面で読み、
// 受け手の段に応じて均す前の値と混ぜる。w × I・w・w × d を同じ重みで均すので、均した後も 3 つの量のあいだの比は保たれる。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, clamp, floor, float, screenCoordinate, select, struct, uniform, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { specularLobeHalfWidth } from '../lighting/ggx';
import { ShadingSample } from '../lighting/shading-sample';
import { compileInto } from '../compile-into';
import { NO_REFLECTION_ROUGHNESS } from './reflection-trace';
import { ReflectionReduction } from './reflection-reduction';
import { ReflectionMerge } from './reflection-merge';
import { reflectionDenoiseLevelOf } from './reflection-denoise-level';
import { encodedDenoisedReflection, type ScreenSpaceReflection } from './screen-space-reflection';
import type { GBufferPass } from '../gbuffer';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 描画設定の「均しの段数」の上端。均しの段数は、高さ LEVEL_REFERENCE_HEIGHT の描画バッファで均すのに使う縮小列の段数で
// 数える。段 0 は均す前の映り込みと G バッファそのもので、段 k は描画画素 2^k 個四方を画素 1 つにまとめる。描画バッファの
// 高さが倍になるごとに 1 段増やす — 焦点距離 [px] が倍になると、同じ粗さの面を均す段は 1 つ上がる。
// tools/render-lab-reflection-levels.mjs がこの行を文字列で読む。
export const MAX_REFLECTION_LEVEL_COUNT = 8;
// 均しの段数を数える描画バッファの高さ [px]。
const LEVEL_REFERENCE_HEIGHT = 540;
// 縮小列に組む段数。描画バッファの高さ 4320 px(LEVEL_REFERENCE_HEIGHT の 8 倍)まで、均すのに使う段を増やせる。
const BUILT_LEVEL_COUNT = MAX_REFLECTION_LEVEL_COUNT + 3;
// 当たり距離を読み始める段(描画画素 16 個四方)。均すのに使ういちばん粗い段がこれより細かいときは、その段から読む。
const DISTANCE_LEVEL = 4;
// 受け手の画素 1 つぶんの均した映り込み。weightedImage / weight / weightedDistance は (w × I)‾・w̄・(w × d)‾、level は
// 均すのに読んだ段(小数)。
const DenoisedReflection = struct(
  { weightedImage: 'vec3', weight: 'float', weightedDistance: 'float', level: 'float' }, 'DenoisedReflection',
);

export class ReflectionDenoise {
  private readonly reduction: ReflectionReduction;
  private readonly merge: ReflectionMerge;
  // 均した映り込みを書くマテリアル。
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 受け手の画素のシェーディング入力。
  private readonly sample: ShadingSample;
  // 描画バッファの縦の焦点距離 [px](view 空間の長さ × 焦点距離 / 奥行き が画面の長さ)。
  private readonly focalLength = uniform(1);
  // 均すのに使ういちばん粗い段(小数)。描画バッファの高さで決まる(coarsestLevelOf)。
  private readonly coarsestLevel = uniform(MAX_REFLECTION_LEVEL_COUNT - 1);
  // 当たり距離を読み始める段。DISTANCE_LEVEL を、このフレームに書くいちばん粗い段で止めた値。
  private readonly distanceLevel = uniform(DISTANCE_LEVEL);
  // 診断の道具が固定した読む段。負なら見積もる。
  private readonly fixedLevel = uniform(-1);

  // reflection は均す前の映り込みを読み、均した映り込みを書く先。levelCount は均しの段数(MAX_REFLECTION_LEVEL_COUNT の
  // 冒頭の数え方)。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly reflection: ScreenSpaceReflection, private readonly gpu: GpuTimings, private levelCount: number,
  ) {
    this.sample = new ShadingSample(gbuffer);
    this.reduction = new ReflectionReduction(renderer, gbuffer, reflection, gpu, BUILT_LEVEL_COUNT);
    this.merge = new ReflectionMerge(
      renderer, this.reduction, gpu, this.focalLength, this.coarsestLevel, this.distanceLevel, this.fixedLevel,
      BUILT_LEVEL_COUNT,
    );
    // 均した値を、均した側の描画先の出力へ符号化して書く。
    const denoised = this.denoised();
    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
    });
    this.material.mrtNode = encodedDenoisedReflection(
      denoised.get('weightedImage') as Vec3Node, denoised.get('weight') as FloatNode,
      denoised.get('weightedDistance') as FloatNode, denoised.get('level') as FloatNode,
    );
  }

  // 1 フレームぶんを描く。均す前の映り込みを書いた後に、G バッファと同じ寸法 width × height で呼ぶ。camera からは
  // 深度から位置を復元する行列と焦点距離を引き直す。
  public render(camera: THREE.Camera, width: number, height: number): void {
    this.prepare(camera, height);
    const lastLevel = Math.ceil(coarsestLevelOf(height, this.levelCount));
    this.reduction.render(camera, width, height, lastLevel);
    this.merge.render(width, height, lastLevel);
    this.renderer.setRenderTarget(this.reflection.denoisedTarget);
    this.quad.material = this.material;
    this.gpu.beginPass(GPU_PASS.reflectionDenoise);
    this.quad.render(this.renderer);
  }

  // 縮小列・合流列・均した映り込みの各マテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    this.prepare(camera, height);
    await this.reduction.compile(camera, width, height);
    await this.merge.compile(width, height, Math.ceil(coarsestLevelOf(height, this.levelCount)));
    this.quad.material = this.material;
    await compileInto(this.renderer, this.reflection.denoisedTarget, this.quad, this.quad.camera);
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.reduction.dispose();
    this.merge.dispose();
    this.material.dispose();
  }

  // 次の render から、均しの段数を count にする。組む段は変わらないので、シェーダは組み直さない。
  public setLevelCount(count: number): void {
    this.levelCount = count;
  }

  // 診断の道具だけが呼ぶ。固定すると全画素がこの段を読む。
  public setFixedLevel(level: number | null): void {
    this.fixedLevel.value = level ?? -1;
  }

  // 受け手の画素の均した映り込み(DenoisedReflection)。段 1 の合流値を受け手の面で読み、受け手を均す段に応じて均す前の値と
  // 混ぜる。面の写っていない画素と映り込みの出ない粗さの画素は 0。
  private denoised(): THREE.Node {
    return Fn(() => {
      // 当たり距離から均す段を選び、面の確からしさを掛けて均す前の値と混ぜる。
      const raw = vec4(this.reflection.rawWeightedImageAt(this.sample.uv), this.reflection.rawWeightAt(this.sample.uv));
      const rawDistance = this.reflection.rawWeightedDistanceAt(this.sample.uv);
      const weighted = vec4(0).toVar();
      const weightedDistance = float(0).toVar();
      const selected = float(0).toVar();
      If(this.gbuffer.covered().and(this.sample.roughness.lessThan(NO_REFLECTION_ROUGHNESS)), () => {
        const parent = this.merge.readAt(
          1, this.sample.position, this.sample.normal, specularLobeHalfWidth(this.sample),
        );
        const level = select(parent.hitDistance.greaterThan(0), this.levelOf(parent.hitDistance), float(0));
        const mix = clamp(level, 0, 1).mul(parent.confidence);
        weighted.assign(raw.mul(float(1).sub(mix)).add(parent.weighted.mul(mix)));
        weightedDistance.assign(rawDistance.mul(float(1).sub(mix)).add(parent.distance.mul(mix)));
        selected.assign(level);
      });
      return DenoisedReflection(weighted.rgb, weighted.a, weightedDistance, selected);
    })();
  }

  // 当たり距離 distance [m] から受け手の画素を均す段(小数)を求める。
  private levelOf(distance: FloatNode): FloatNode {
    return reflectionDenoiseLevelOf(
      this.sample.position, this.sample.normal, specularLobeHalfWidth(this.sample), this.sample.viewDir,
      distance, this.focalLength, this.reduction.drawnNormalRateAt(floor(screenCoordinate)),
      this.coarsestLevel, this.fixedLevel,
    );
  }

  // 高さ height [px] の描画バッファと実カメラの値を設定する。
  private prepare(camera: THREE.Camera, height: number): void {
    // 縦の焦点距離は、射影行列の縦の倍率に画面の高さの半分を掛けたもの。
    this.focalLength.value = camera.projectionMatrix.elements[5]! * height / 2;
    this.coarsestLevel.value = coarsestLevelOf(height, this.levelCount);
    this.distanceLevel.value = Math.min(DISTANCE_LEVEL, Math.ceil(this.coarsestLevel.value));
    this.sample.sync(camera);
  }
}

// 高さ height [px] の描画バッファで均すのに使う、いちばん粗い段(小数)。高さ LEVEL_REFERENCE_HEIGHT で
// levelCount − 1 になり、高さが倍になるごとに 1 上がる。
function coarsestLevelOf(height: number, levelCount: number): number {
  const level = levelCount - 1 + Math.log2(height / LEVEL_REFERENCE_HEIGHT);
  return THREE.MathUtils.clamp(level, 0, BUILT_LEVEL_COUNT - 1);
}
