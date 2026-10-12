// 映り込みを粗さに応じて均す。受け手の画素ごとに、像のぼけの短い軸の幅に合う縮小列の段を選び、受け手の面に載る分は
// その段の値で、載らない分は 1 つ細かい段の値で埋めて読み、均した値を書く(Stachowiak 2015「Stochastic Screen-Space
// Reflections」の空間方向の均し)。w × I・w・w × d を同じ重みで均すので、均した後も 3 つの量のあいだの比は保たれる。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, abs, ceil, clamp, dot, float, length, log2, max, screenUV, struct, tan, uniform, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { specularLobeHalfWidth } from '../lighting/ggx';
import { ShadingSample } from '../lighting/shading-sample';
import { compileInto } from '../compile-into';
import { NO_REFLECTION_ROUGHNESS } from './reflection-trace';
import { ReflectionReduction, type FilledReflection } from './reflection-reduction';
import { encodedDenoisedReflection, type ScreenSpaceReflection } from './screen-space-reflection';
import type { GBufferPass } from '../gbuffer';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 高さ LEVEL_REFERENCE_HEIGHT の描画バッファで均すのに使う、縮小列の段数。段 0 は均す前の映り込みと G バッファそのもので、
// 段 k は描画画素 2^k 個四方を画素 1 つにまとめる。描画バッファの高さが倍になるごとに 1 段増やす — 焦点距離 [px] が倍に
// なると、同じ粗さの面を均す段は 1 つ上がる。tools/render-lab-reflection-levels.mjs がこの行を文字列で読む。
export const REFLECTION_LEVEL_COUNT = 7;
// REFLECTION_LEVEL_COUNT の段数で均す、描画バッファの高さ [px]。
const LEVEL_REFERENCE_HEIGHT = 540;
// 縮小列に組む段数。描画バッファの高さ 4320 px(LEVEL_REFERENCE_HEIGHT の 8 倍)まで、均すのに使う段を増やせる。
const BUILT_LEVEL_COUNT = REFLECTION_LEVEL_COUNT + 3;
// 当たり距離を読み始める段(描画画素 16 個四方)。
const DISTANCE_LEVEL = 4;
// 受け手を均す段の上限に足す余裕。上限と均す段を求める式の丸めの違いで、均す段が上限をわずかに超えないようにする。
const LEVEL_CEILING_MARGIN = 1e-3;
// 均しの広さ: 均すのに読む段の画素の一辺の、像のぼけの短い軸の幅に対する比。短い軸の幅は、鏡像の奥行きへ写した鏡面
// ローブの円の直径に N·V を掛けたもの — 斜めから見た面の映り込みは、入射面の中へはローブの半幅どおりにぼけ、入射面に
// 垂直な向きへはその約 N·V 倍しかぼけない。像のぼけは追跡の向きのジッターが縦横とも作るので、均しはまだらを消す幅でよい。
const DENOISE_WIDTH_PER_SHORT_AXIS = 1;

// 受け手の画素 1 つぶんの均した映り込み。weightedImage / weight / weightedDistance は (w × I)‾・w̄・(w × d)‾、level は
// 均すのに読んだ段(小数)。
const DenoisedReflection = struct(
  { weightedImage: 'vec3', weight: 'float', weightedDistance: 'float', level: 'float' }, 'DenoisedReflection',
);

export class ReflectionDenoise {
  private readonly reduction: ReflectionReduction;
  // 均した映り込みを書くマテリアル。縮小列の全段を読む。
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 受け手の画素のシェーディング入力。
  private readonly sample: ShadingSample;
  // 描画バッファの縦の焦点距離 [px](view 空間の長さ × 焦点距離 / 奥行き が画面の長さ)。
  private readonly focalLength = uniform(1);
  // 均すのに使ういちばん粗い段(小数)。描画バッファの高さで決まる(coarsestLevelOf)。
  private readonly coarsestLevel = uniform(REFLECTION_LEVEL_COUNT - 1);

  // reflection は均す前の映り込みを読み、均した映り込みを書く先。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly reflection: ScreenSpaceReflection, private readonly gpu: GpuTimings,
  ) {
    this.sample = new ShadingSample(gbuffer);
    this.reduction = new ReflectionReduction(renderer, gbuffer, reflection, gpu, BUILT_LEVEL_COUNT);
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
    // 縮小列を、均すのに使ういちばん粗い段の端数を混ぜる段まで書き、均した映り込みを書く。
    this.reduction.render(camera, width, height, Math.ceil(coarsestLevelOf(height)));
    this.renderer.setRenderTarget(this.reflection.denoisedTarget);
    this.quad.material = this.material;
    this.gpu.beginPass(GPU_PASS.reflectionDenoise);
    this.quad.render(this.renderer);
  }

  // 縮小列の全段と均した映り込みのマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    this.prepare(camera, height);
    await this.reduction.compile(camera, width, height);
    this.quad.material = this.material;
    await compileInto(this.renderer, this.reflection.denoisedTarget, this.quad, this.quad.camera);
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.reduction.dispose();
    this.material.dispose();
  }

  // 受け手の画素の均した映り込み(DenoisedReflection)。段 0 から順に、受け手の面に載らない分を 1 つ細かい段の値で埋めた
  // 値を求め、段 DISTANCE_LEVEL から粗い段へ、最初に w̄ が正になった段の (w × d)‾ / w̄ を当たり距離にして均す段を選び、
  // 選んだ段の両隣を段の端数で混ぜる。受け手を均す段の上限までに w̄ が正にならない画素、面の写っていない画素、映り込みの
  // 出ない粗さの画素は 0。
  private denoised(): THREE.Node {
    return Fn(() => {
      const weighted = vec4(0).toVar();
      const weightedDistance = float(0).toVar();
      // 均す段。当たり距離が決まるまでは −1。
      const selected = float(-1).toVar();
      If(this.gbuffer.covered().and(this.sample.roughness.lessThan(NO_REFLECTION_ROUGHNESS)), () => {
        const receiverWidth = specularLobeHalfWidth(this.sample).toVar();
        // 当たり距離を探す段の上限。それより粗い段で当たり距離を見つけても、選ぶのは上限より細かい段で、そこまでの段は
        // どれも w̄ が 0。
        const searchCeiling = max(float(DISTANCE_LEVEL), ceil(this.levelCeiling())).toVar();
        // このフレームに書いた段のうち、いちばん粗い段。
        const lastLevel = ceil(this.coarsestLevel).toVar();
        // 段ごとの埋めた値。段 0 は受け手の画素そのもの。混ぜる 2 段は必ず求めてある。
        const filled: FilledReflection[] = [{
          weighted: vec4(this.reflection.rawWeightedImageAt(screenUV), this.reflection.rawWeightAt(screenUV)).toVar(),
          weightedDistance: this.reflection.rawWeightedDistanceAt(screenUV).toVar(),
        }];
        for (let index = 1; index < BUILT_LEVEL_COUNT; index++) {
          const value: FilledReflection = { weighted: vec4(0).toVar(), weightedDistance: float(0).toVar() };
          const finer = filled[index - 1]!;
          filled.push(value);
          // 当たり距離を探すあいだと、選んだ段の 1 つ上までの段を求める。
          const fill = (): void => {
            const next = this.reduction.filledAt(index, finer, this.sample, receiverWidth);
            value.weighted.assign(next.weighted);
            value.weightedDistance.assign(next.weightedDistance);
          };
          if (index <= DISTANCE_LEVEL) fill();
          else {
            const searching = selected.lessThan(0).and(searchCeiling.greaterThanEqual(index));
            If(searching.or(selected.greaterThanEqual(index - 1)).and(lastLevel.greaterThanEqual(index)), fill);
          }
          // 当たり距離が決まったら、均す段を選ぶ。
          if (index < DISTANCE_LEVEL) continue;
          If(selected.lessThan(0).and(value.weighted.a.greaterThan(0)), () => {
            selected.assign(this.levelOf(value.weightedDistance.div(value.weighted.a)));
          });
        }
        // 選んだ段の両隣を、段の端数の tent の重みで混ぜる。
        for (const [index, value] of filled.entries()) {
          const share = max(float(1).sub(abs(selected.sub(index))), 0).toVar();
          If(share.greaterThan(0), () => {
            weighted.addAssign(value.weighted.mul(share));
            weightedDistance.addAssign(value.weightedDistance.mul(share));
          });
        }
      });
      return DenoisedReflection(weighted.rgb, weighted.a, weightedDistance, max(selected, 0));
    })();
  }

  // 受け手の画素を均す段(小数)。当たり距離 distance [m] で鏡面ローブが張る円を、受け手から見た鏡像の奥行きへ置いて
  // 画面へ写した直径で、levelOfDiameter の段を選ぶ。
  private levelOf(distance: FloatNode): FloatNode {
    const position = this.sample.position;
    const range = length(position).toVar();
    // 鏡像は視線の延長上、視点から |P| + d の所にある。
    const mirrorDepth = position.z.negate().mul(range.add(distance)).div(range);
    return this.levelOfDiameter(
      distance.mul(tan(specularLobeHalfWidth(this.sample))).mul(this.focalLength).div(mirrorDepth).mul(2),
    );
  }

  // 受け手の画素について、levelOf がどの当たり距離でも超えない段(小数)。levelOf の直径の d / 鏡像の奥行き は、d → ∞ で
  // |P| / −P.z へ近づく。
  private levelCeiling(): FloatNode {
    const position = this.sample.position;
    const diameter = length(position).mul(tan(specularLobeHalfWidth(this.sample))).mul(this.focalLength)
      .div(position.z.negate()).mul(2);
    return this.levelOfDiameter(diameter).add(LEVEL_CEILING_MARGIN);
  }

  // 受け手の画素を、画面へ写した鏡面ローブの円の直径 diameter [px] で均す段(小数)。直径に N·V を掛けた像のぼけの短い軸の
  // 幅の DENOISE_WIDTH_PER_SHORT_AXIS 倍が、段の画素 1 つの一辺になる段で、均すのに使ういちばん粗い段で止まる。
  private levelOfDiameter(diameter: FloatNode): FloatNode {
    // 視線が面に寝て N·V が 0 以下へ落ちる画素は、段 0 で止まる。
    const shortAxis = diameter.mul(dot(this.sample.normal, this.sample.viewDir));
    return clamp(log2(max(shortAxis.mul(DENOISE_WIDTH_PER_SHORT_AXIS), 1)), 0, this.coarsestLevel);
  }

  // 高さ height [px] の描画バッファと実カメラの値を書き込む。
  private prepare(camera: THREE.Camera, height: number): void {
    // 縦の焦点距離は、射影行列の縦の倍率に画面の高さの半分を掛けたもの。
    this.focalLength.value = camera.projectionMatrix.elements[5]! * height / 2;
    this.coarsestLevel.value = coarsestLevelOf(height);
    this.sample.sync(camera);
  }
}

// 高さ height [px] の描画バッファで均すのに使う、いちばん粗い段(小数)。高さ LEVEL_REFERENCE_HEIGHT で
// REFLECTION_LEVEL_COUNT − 1 になり、高さが倍になるごとに 1 上がる。
function coarsestLevelOf(height: number): number {
  const level = REFLECTION_LEVEL_COUNT - 1 + Math.log2(height / LEVEL_REFERENCE_HEIGHT);
  return THREE.MathUtils.clamp(level, DISTANCE_LEVEL, BUILT_LEVEL_COUNT - 1);
}
