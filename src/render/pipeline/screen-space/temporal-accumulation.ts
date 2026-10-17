// フレーム番号の進み方と履歴長の上限を決め、近傍拡散補正を時間方向に蓄積する。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, exp2, floatBitsToUint, floor, float, int, ivec2, max, min, mrt, screenSize, screenUV, select, texture,
  textureLoad, uint, uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { compileInto } from '../compile-into';
import { multiOutputMaterial, stageMaterial, type ScreenSpaceStage } from './screen-space-stage';
import { octDecodeNormal } from '../gbuffer';
import { SurfaceWeight } from './surface-weight';
import type { DiffuseCorrection } from './diffuse-correction';
import type { GBufferPass } from '../gbuffer';
import type {
  BoolNode, FloatNode, FloatUniform, IVec2Node, Mat3Uniform, Mat4Uniform, UintNode, Vec2Node, Vec3Node, Vec4Node,
} from '../../tsl-types';

// 履歴の再投影の面の重みの、法線の重みが半分になる角 [rad](20°)。
const HISTORY_HALF_WEIGHT_ANGLE = Math.PI / 9;

// 単精度浮動小数の指数部のビット。±∞ と NaN だけが、このビットをすべて立てる。
const FLOAT_EXPONENT_BITS = 0x7f800000;

// components がすべて有限か。
function allFinite(...components: FloatNode[]): BoolNode {
  return components.map((component) => {
    // floatBitsToUint の @types/three 上の戻り値型は値の型を持たないため、UintNode へ読み替える。
    const bits = floatBitsToUint(component) as unknown as UintNode;
    // WGSL の実装は非有限の値が現れないと仮定して浮動小数の比較を畳んでよいので、ビット列で判定する。
    return bits.bitAnd(uint(FLOAT_EXPONENT_BITS)).notEqual(uint(FLOAT_EXPONENT_BITS));
  }).reduce((finite, next) => finite.and(next));
}

// 添付 0〜2 に履歴(rgb = 補正、α = 履歴の長さ n)・前フレームの素の深度・前フレームの符号化法線を持つ描画先。
function createHistoryTarget(): THREE.RenderTarget {
  // 1 回の描画で同じ画素へまとめて写せるよう、形式の違う 3 つを 1 つの描画先に束ねる。
  const target = new THREE.RenderTarget(1, 1, {
    count: 3, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const [history, depth, normal] = target.textures;
  history!.name = 'diffuseCorrectionHistory';
  history!.format = THREE.RGBAFormat;
  history!.type = THREE.HalfFloatType;
  depth!.name = 'previousDepth';
  depth!.format = THREE.RedFormat;
  depth!.type = THREE.FloatType;
  normal!.name = 'previousNormal';
  normal!.format = THREE.RGFormat;
  normal!.type = THREE.HalfFloatType;
  return target;
}

// 蓄積前の補正 correction.upsampledTarget を、前フレームから再投影した履歴と混ぜて correction.target へ書く。毎フレーム、
// G バッファを描く前に beginFrame を、蓄積の段を描く前に prepare を呼ぶ。
export class TemporalAccumulation {
  // 履歴と前フレームの面。履歴を写す段の描画先。
  private readonly target = createHistoryTarget();
  // 履歴を写す段を描く板。
  private readonly quad = new QuadMesh();
  // 静止時の履歴の上限 s [フレーム]。
  private readonly historyCap: FloatUniform = uniform(1);
  // このフレームの変化量から決めた履歴長の上限 [フレーム]。
  private readonly lengthCap: FloatUniform = uniform(1);
  // 前フレームの射影行列とその逆。前フレームの面の位置を戻す。
  private readonly previousProjection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly previousProjectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // 前フレームの view 行列(world → 前フレームの視点座標)。
  private readonly previousView = new THREE.Matrix4();
  // 今の法線を前フレームの視点座標へ移す回転行列。
  private readonly normalToPreviousView: Mat3Uniform = uniform(new THREE.Matrix3());
  // このフレームの射影行列とその逆と view 行列。次の番号へ進むとき、前フレームの行列になる。
  private readonly currentProjection = new THREE.Matrix4();
  private readonly currentProjectionInverse = new THREE.Matrix4();
  private readonly currentView = new THREE.Matrix4();
  // prepare で前 view と今の world 行列を合成する作業行列。
  private readonly normalMatrix = new THREE.Matrix4();
  // 履歴ターゲットの深度・法線を前フレームの面として読み、再投影タップの重みを求める。
  private readonly previousWeight: SurfaceWeight;
  // 補正と G バッファを履歴ターゲットへ写す段。
  private readonly copyStage: ScreenSpaceStage;
  // 再投影した履歴と今の補正を correction.target へ混ぜて書く段。
  private readonly accumulationStage: ScreenSpaceStage;
  // 最後に beginFrame が受けた番号。null はまだ受けていない。
  private previousFrame: number | null = null;
  // previousFrame の番号で蓄積の段を描いたか。
  private previousFrameRendered = false;

  // gbuffer は今のフレームの面と動き、correction は蓄積の入力(upsampledTarget)と出力(target)、gpu は履歴を写す段の
  // 計測先。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly correction: DiffuseCorrection, private readonly gpu: GpuTimings,
  ) {
    const previousSurfaces = { depthTexture: this.target.textures[1]!, normalTexture: this.target.textures[2]! };
    this.previousWeight = new SurfaceWeight(
      previousSurfaces, this.previousProjection, this.previousProjectionInverse, vec2(screenSize),
    );
    this.copyStage = this.createCopyStage();
    this.accumulationStage = this.createAccumulationStage();
  }

  public get historyTexture(): THREE.Texture { return this.target.textures[0]!; }
  public get previousDepthTexture(): THREE.Texture { return this.target.textures[1]!; }
  public get previousNormalTexture(): THREE.Texture { return this.target.textures[2]!; }
  public get accumulation(): ScreenSpaceStage { return this.accumulationStage; }
  // 静止時の履歴の上限 s [フレーム]。
  public get historyCapFrames(): number { return this.historyCap.value; }

  // 静止時の履歴の上限 s を frames [フレーム](1 以上の整数)にする。履歴長の上限には次の beginFrame から効く。
  public setHistoryCap(frames: number): void {
    this.historyCap.value = frames;
  }

  // 履歴の寸法を width × height へ合わせ、camera の行列をこのフレームのものとして記録する。beginFrame の後、蓄積の段を
  // 描く前に呼ぶ。
  public prepare(camera: THREE.Camera, width: number, height: number): void {
    this.setSize(width, height);
    this.currentProjection.copy(camera.projectionMatrix);
    this.currentProjectionInverse.copy(camera.projectionMatrixInverse);
    this.currentView.copy(camera.matrixWorldInverse);
    this.normalMatrix.multiplyMatrices(this.previousView, camera.matrixWorld);
    this.normalToPreviousView.value.setFromMatrix4(this.normalMatrix);
  }

  // correction.target の履歴長を履歴の上限で割り、0〜1 に制限した値を返す。
  public normalizedHistoryAt(uv: Vec2Node): FloatNode {
    return texture(this.correction.target.texture, uv).a.div(this.historyCap).clamp(0, 1);
  }

  // 番号 frame のフレームを始める。G バッファを上書きする前に呼ぶ。前の番号を描き終えていれば前フレームとして履歴へ写し、
  // 変化量 change(0 以上。∞ は履歴を切る)から履歴長の上限を決める。番号が続かなければ履歴を切る。
  public beginFrame(frame: number, change: number): void {
    // 同じ番号の描き直しは、前回に写した履歴をそのまま使う。
    const step = frameStepOf(this.previousFrame, frame, change);
    if (step === 'repeat') {
      this.previousFrameRendered = false;
      return;
    }
    // 前の番号のカメラと面と補正を、前フレームとして写す。
    if (step === 'advance' && this.previousFrameRendered) {
      this.previousProjection.value.copy(this.currentProjection);
      this.previousProjectionInverse.value.copy(this.currentProjectionInverse);
      this.previousView.copy(this.currentView);
      this.copyPreviousFrame();
      this.lengthCap.value = lengthCapOf(this.historyCap.value, change);
    } else {
      // 使える前フレームが無いので、今の値から蓄積をやり直す。
      this.lengthCap.value = 1;
    }
    this.previousFrame = frame;
    this.previousFrameRendered = false;
  }

  // このフレームで蓄積の段を描いたことを記録する。記録の無いフレームの次の番号では履歴を切る。
  public markFrameRendered(): void {
    this.previousFrameRendered = true;
  }

  // 履歴を写す段のマテリアルを、履歴ターゲットへ事前コンパイルする。
  public async compile(): Promise<void> {
    this.quad.material = this.copyStage.material;
    await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
  }

  // 所有する描画先と段の材質を解放する。以後このインスタンスは使えない。
  public dispose(): void {
    this.target.dispose();
    this.copyStage.material.dispose();
    this.accumulationStage.material.dispose();
  }

  // 履歴と前フレームの面の寸法を width × height へ合わせる。寸法が変われば、このフレームの履歴を切る。
  private setSize(width: number, height: number): void {
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
    this.lengthCap.value = 1;
  }

  // 補正の結果 correction.target と G バッファの深度・法線を、同じ画素の履歴の添付 0〜2 へ写す段。
  private createCopyStage(): ScreenSpaceStage {
    const target = this.target;
    const pixel = ivec2(floor(screenUV.mul(screenSize)));
    const material = multiOutputMaterial(target, () => [
      textureLoad(this.correction.target.texture, pixel),
      vec4(textureLoad(this.gbuffer.depthTexture, pixel).r, 0, 0, 0),
      vec4(textureLoad(this.gbuffer.normalTexture, pixel).rg, 0, 0),
    ]);
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseHistoryCopy };
  }

  // 再投影した履歴と蓄積前の補正を混ぜた値(accumulatedValue)を correction.target へ書く段。
  private createAccumulationStage(): ScreenSpaceStage {
    const target = this.correction.target;
    const material = stageMaterial();
    material.mrtNode = mrt({
      [target.texture.name]: Fn(() => {
        return this.accumulatedValue();
      })(),
    });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseAccumulation };
  }

  // 前フレームの 2×2 近傍から再投影した履歴と今の補正を、履歴の長さで混ぜた値(rgb = 補正、α = 履歴の長さ n)。非有限な
  // 履歴の画素は再投影から外し、非有限な今の値は、履歴があればその標本を捨てて履歴を保つ。
  private accumulatedValue(): Vec4Node {
    // 今の補正・面・動きから、前フレームの対応位置を求める。
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const current = textureLoad(this.correction.upsampledTarget.texture, pixel).rgb.toVar();
    const depth = textureLoad(this.gbuffer.depthTexture, pixel).r.toVar();
    const encodedNormal = textureLoad(this.gbuffer.normalTexture, pixel).rg;
    const normal = this.normalToPreviousView.mul(octDecodeNormal(encodedNormal)).toVar();
    const motion = textureLoad(this.gbuffer.motionTexture, pixel).toVar();
    const previousUv = screenUV.sub(motion.xy).toVar();
    const previousDepth = depth.add(motion.z).toVar();
    const clip = vec4(
      previousUv.x.mul(2).sub(1), previousUv.y.oneMinus().mul(2).sub(1), previousDepth, 1,
    ).toVar();
    const previousCoordinate = previousUv.mul(screenSize).sub(0.5).toVar();
    const base = ivec2(floor(previousCoordinate)).toVar();
    const fraction = previousCoordinate.sub(vec2(float(base.x), float(base.y))).toVar();
    // 2×2 の履歴タップを、前フレームの面との整合性と双線形係数で重み付けする。
    const tap00 = this.addHistoryTap(clip, normal, base, fraction, 0, 0);
    const tap10 = this.addHistoryTap(clip, normal, base, fraction, 1, 0);
    const tap01 = this.addHistoryTap(clip, normal, base, fraction, 0, 1);
    const tap11 = this.addHistoryTap(clip, normal, base, fraction, 1, 1);
    const totalWeight = tap00.weight.add(tap10.weight).add(tap01.weight).add(tap11.weight).toVar();
    const history = tap00.value.add(tap10.value).add(tap01.value).add(tap11.value)
      .div(max(totalWeight, 1e-20)).toVar();
    // 面のある画素は履歴の長さを 1 つ延ばし、変化量から決めた上限で切る。
    const historyLength = tap00.length.add(tap10.length).add(tap01.length).add(tap11.length).toVar();
    const validSurface = depth.greaterThan(0);
    const accumulatedLength = select(validSurface, historyLength, 0).add(1).toVar();
    const length = min(accumulatedLength, this.lengthCap).toVar();
    // 履歴長で今の値へ寄せる。長さ 1 以下は、蓄積前の補正とビット一致させるため今の値をそのまま選ぶ。
    const sample = select(allFinite(current.x, current.y, current.z), current, history);
    const blended = history.add(sample.sub(history).div(length));
    return vec4(select(length.lessThanEqual(1), current, blended), length);
  }

  // 前フレームの画素 base + (dx, dy) の履歴のタップ — 重み(その画素の面を受け手にした、再投影した点 clip・法線 normal の面の
  // 重みと、端数 fraction による双線形係数の積)と、重みを掛けた履歴の rgb と長さ。画面外・面の無い・非有限なタップの重みは 0。
  private addHistoryTap(
    clip: Vec4Node, normal: Vec3Node,
    base: IVec2Node, fraction: Vec2Node, dx: number, dy: number,
  ): { readonly weight: FloatNode; readonly value: Vec3Node; readonly length: FloatNode } {
    // 画面外のタップは、読む座標を画面の端へ寄せたうえで重みを 0 にする。
    const texel = base.add(ivec2(dx, dy)).toVar();
    const size = ivec2(screenSize).toVar();
    const inside = texel.x.greaterThanEqual(0).and(texel.x.lessThan(size.x))
      .and(texel.y.greaterThanEqual(0)).and(texel.y.lessThan(size.y));
    const safeX = select(texel.x.lessThan(0), int(0), select(texel.x.greaterThanEqual(size.x), size.x.sub(1), texel.x));
    const safeY = select(texel.y.lessThan(0), int(0), select(texel.y.greaterThanEqual(size.y), size.y.sub(1), texel.y));
    const safeTexel = ivec2(safeX, safeY).toVar();
    const surface = this.previousWeight.surfaceAt(safeTexel);
    const receiver = this.previousWeight.receiverAt(surface);
    const exponent = this.previousWeight.exponentAt(
      receiver, clip, normal, float(1), float(HISTORY_HALF_WEIGHT_ANGLE),
    );
    const bilinear = (dx === 0 ? fraction.x.oneMinus() : fraction.x)
      .mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
    // 非有限の履歴は重み 0 を掛けても NaN のまま混ざり、近傍へ毎フレーム広がるので、掛ける前に値ごと落とす。
    const stored = textureLoad(this.target.textures[0]!, safeTexel).toVar();
    const usable = inside.and(surface.depth.greaterThan(0)).and(allFinite(stored.x, stored.y, stored.z, stored.w));
    const weight = select(usable, exp2(exponent.negate()).mul(bilinear), 0).toVar();
    const history = select(usable, stored, vec4(0));
    return {
      weight,
      value: history.rgb.mul(weight),
      length: history.a.mul(weight),
    };
  }

  // 補正の結果と G バッファの深度・法線を履歴へ写す。G バッファを上書きする前に呼ぶ。
  private copyPreviousFrame(): void {
    this.renderer.setRenderTarget(this.target);
    this.quad.material = this.copyStage.material;
    this.gpu.beginPass(this.copyStage.gpuPass);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }
}

// 前回から同じ番号を描き直すか、次の番号へ進むか、履歴を切るか。
export type FrameStep = 'repeat' | 'advance' | 'cut';

// 変化量 change が NaN か負なら投げる。
function assertChange(change: number): void {
  if (Number.isNaN(change) || change < 0) {
    throw new RangeError(`screen-space: invalid change ${change}`);
  }
}

// 前回の番号 previous(null は初回)から今回の番号 frame への進み方。変化量 change が ∞ なら、番号が続いていても履歴を切る。
// 番号が負か整数でないとき、変化量が NaN か負のときは投げる。
export function frameStepOf(previous: number | null, frame: number, change: number): FrameStep {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`screen-space: invalid frame ${frame}`);
  }
  if (previous !== null && (!Number.isInteger(previous) || previous < 0)) {
    throw new RangeError(`screen-space: invalid previous frame ${previous}`);
  }
  // 同じ番号の描き直しは、最初に受けた変化量を使い続けるので change を読まない。
  if (previous !== null && frame === previous) return 'repeat';

  assertChange(change);
  if (previous === null || frame !== previous + 1 || change === Infinity) return 'cut';
  return 'advance';
}

// 履歴の上限 historyCap = s [フレーム] と変化量 change = d から決める、履歴長の上限 1 / (1 − (1 − 1/s)·e^(−d)) [フレーム]。
// 古い値が 1 フレームで残る割合を、静止時の残り (1 − 1/s) と変わらなかった割合 e^(−d) の積とする。
export function lengthCapOf(historyCap: number, change: number): number {
  if (!Number.isInteger(historyCap) || historyCap < 1) {
    throw new RangeError(`screen-space: invalid history cap ${historyCap}`);
  }
  assertChange(change);
  // d = 0 で s、d = ∞ で 1 が丸めなしで出る形に変形した式。
  return historyCap / (1 + (historyCap - 1) * -Math.expm1(-change));
}
