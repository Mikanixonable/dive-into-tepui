// フレーム番号の進み方と履歴長の上限を決め、近傍拡散補正を時間方向に蓄積する。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  exp2, floatBitsToUint, floor, float, fract, int, ivec2, min, screenSize, screenUV, select,
  textureLoad, uint, uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS } from '../../gpu-timings';
import { compileInto } from '../compile-into';
import { multiOutputMaterial, type ScreenSpaceStage } from './screen-space-stage';
import { octDecodeNormal } from '../gbuffer';
import { SurfaceWeight } from './surface-weight';
import { historyReadJitterAt } from './frame-jitter';
import type { BlueNoise } from '../../blue-noise';
import type { DiffuseCorrection } from './diffuse-correction';
import type { GBufferPass } from '../gbuffer';
import type {
  BoolNode, FloatNode, FloatUniform, IVec2Node, Mat3Uniform, Mat4Uniform, UintNode, Vec2Node,
  Vec2Uniform, Vec3Node, Vec4Node,
} from '../../tsl-types';

// 履歴の再投影の面の重みの、法線の重みが半分になる角 [rad](20°)。
const HISTORY_HALF_WEIGHT_ANGLE = Math.PI / 9;
// 画素中心からジッターして最寄り画素を選ぶ範囲 [px]。静止画素中心では一軸の隣接画素選択率が約 9%。
const HISTORY_JITTER_RADIUS = 0.55;

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

// 蓄積前の補正を前組の履歴と混ぜ、補正・深度・法線を現在組へ同時に書く。フレームごとに書き込み先を交互にする。
// G バッファを描く前に beginFrame を、蓄積の段を描く前に prepare を呼ぶ。
export class TemporalAccumulation {
  private readonly quad = new QuadMesh();
  // 静止時の履歴の上限 s [フレーム]。
  private readonly historyCap: FloatUniform = uniform(1);
  // このフレームの変化量から決めた履歴長の上限 [フレーム]。
  private readonly lengthCap: FloatUniform = uniform(1);
  // 画素ごとのブルーノイズへ加える番号由来の位相 [-0.5, +0.5)。
  private readonly historyReadOffset: Vec2Uniform = uniform(new THREE.Vector2());
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
  private readonly previousWeights: readonly [SurfaceWeight, SurfaceWeight];
  private readonly accumulationStages: readonly [ScreenSpaceStage, ScreenSpaceStage];
  private width = 0;
  private height = 0;
  // 現在のフレームが書き込む組。
  private writeIndex: 0 | 1 = 0;
  // 最後に beginFrame が受けた番号。null はまだ受けていない。
  private previousFrame: number | null = null;
  // previousFrame の番号で蓄積の段を描いたか。
  private previousFrameRendered = false;

  // gbuffer は今のフレームの面と動き、correction は蓄積の入力と交互に書く出力。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly correction: DiffuseCorrection, private readonly blueNoise: BlueNoise,
  ) {
    this.previousWeights = [0, 1].map((writeIndex) => {
      const historyTarget = this.correction.targetAt((1 - writeIndex) as 0 | 1);
      return new SurfaceWeight(
        { depthTexture: historyTarget.textures[1]!, normalTexture: historyTarget.textures[2]! },
        this.previousProjection, this.previousProjectionInverse, vec2(screenSize),
      );
    }) as unknown as readonly [SurfaceWeight, SurfaceWeight];
    this.accumulationStages = [this.createAccumulationStage(0), this.createAccumulationStage(1)];
  }

  public get historyTexture(): THREE.Texture { return this.correction.targetAt((1 - this.writeIndex) as 0 | 1).textures[0]!; }
  public get previousDepthTexture(): THREE.Texture { return this.correction.targetAt((1 - this.writeIndex) as 0 | 1).textures[1]!; }
  public get previousNormalTexture(): THREE.Texture { return this.correction.targetAt((1 - this.writeIndex) as 0 | 1).textures[2]!; }
  public get accumulation(): ScreenSpaceStage { return this.accumulationStages[this.writeIndex]; }
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
    return this.correction.valueAtUv(uv).a.div(this.historyCap).clamp(0, 1);
  }

  // 番号 frame のフレームを始める。G バッファを上書きする前に呼ぶ。前の番号を描き終えていれば読み書きする組を交代し、
  // 変化量 change(0 以上。∞ は履歴を切る)から履歴長の上限を決める。番号が続かなければ履歴を切る。
  public beginFrame(frame: number, change: number): void {
    // 同じ番号の描き直しは、組を交代せず同じ前組の履歴を使う。
    const step = frameStepOf(this.previousFrame, frame, change);
    this.historyReadOffset.value.set(...historyReadJitterAt(frame));
    if (step === 'repeat') {
      this.previousFrameRendered = false;
      return;
    }
    // 前の番号のカメラ行列を、再投影に使う前フレームの値として記録する。
    if (step === 'advance' && this.previousFrameRendered) {
      this.previousProjection.value.copy(this.currentProjection);
      this.previousProjectionInverse.value.copy(this.currentProjectionInverse);
      this.previousView.copy(this.currentView);
      this.writeIndex = (1 - this.writeIndex) as 0 | 1;
      this.lengthCap.value = lengthCapOf(this.historyCap.value, change);
    } else {
      // 使える前フレームが無いので、今の値から蓄積をやり直す。
      this.writeIndex = 0;
      this.lengthCap.value = 1;
    }
    this.correction.setTargetIndex(this.writeIndex);
    this.previousFrame = frame;
    this.previousFrameRendered = false;
  }

  // このフレームで蓄積の段を描いたことを記録する。記録の無いフレームの次の番号では履歴を切る。
  public markFrameRendered(): void {
    this.previousFrameRendered = true;
  }

  // 2組それぞれへ蓄積するマテリアルを事前コンパイルする。
  public async compile(): Promise<void> {
    for (const stage of this.accumulationStages) {
      this.quad.material = stage.material;
      await compileInto(this.renderer, stage.target, this.quad, this.quad.camera);
    }
  }

  // 所有する描画先と段の材質を解放する。以後このインスタンスは使えない。
  public dispose(): void {
    for (const stage of this.accumulationStages) stage.material.dispose();
  }

  // 2組の履歴と前フレームの面の寸法を width × height へ合わせる。寸法が変われば、このフレームの履歴を切る。
  private setSize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.correction.setTargetIndex(this.writeIndex);
    this.previousFrameRendered = false;
    this.lengthCap.value = 1;
  }

  // 前組の履歴と今の補正を混ぜ、補正・現在の深度・法線を今の組へ同時に書く段。
  private createAccumulationStage(writeIndex: 0 | 1): ScreenSpaceStage {
    const target = this.correction.targetAt(writeIndex);
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const depth = textureLoad(this.gbuffer.depthTexture, pixel).r.toVar();
    const normal = textureLoad(this.gbuffer.normalTexture, pixel).rg.toVar();
    const historyTarget = this.correction.targetAt((1 - writeIndex) as 0 | 1);
    const material = multiOutputMaterial(target, () => [
      this.accumulatedValue(historyTarget, this.previousWeights[writeIndex], pixel, depth, normal),
      vec4(depth, 0, 0, 0),
      vec4(normal, 0, 0),
    ]);
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseAccumulation };
  }

  // 前フレームの面と履歴色は同じ最近傍画素から読む。番号ごとの位相と画素ごとのブルーノイズで位置をずらす。
  // 再投影の位置はずらさず面と比較し、今の補正と履歴の長さ n (α) を混ぜた値 (rgb = 補正) を返す。非有限な
  // 履歴の画素は再投影から外し、非有限な今の値は、履歴があればその標本を捨てて履歴を保つ。
  private accumulatedValue(
    historyTarget: THREE.RenderTarget, previousWeight: SurfaceWeight, pixel: IVec2Node,
    depth: FloatNode, encodedNormal: Vec2Node,
  ): Vec4Node {
    // 今の補正・面・動きから、前フレームの対応位置を求める。
    const current = textureLoad(this.correction.upsampledTarget.texture, pixel).rgb.toVar();
    const normal = this.normalToPreviousView.mul(octDecodeNormal(encodedNormal)).toVar();
    const motion = textureLoad(this.gbuffer.motionTexture, pixel).toVar();
    const previousUv = screenUV.sub(motion.xy).toVar();
    const previousDepth = depth.add(motion.z).toVar();
    const clip = vec4(
      previousUv.x.mul(2).sub(1), previousUv.y.oneMinus().mul(2).sub(1), previousDepth, 1,
    ).toVar();
    const previousCoordinate = previousUv.mul(screenSize).sub(0.5).toVar();
    const tap = this.addHistoryTap(clip, normal, previousCoordinate, historyTarget, previousWeight);
    const history = tap.value.toVar();
    // 面のある画素は履歴の長さを 1 つ延ばし、変化量から決めた上限で切る。
    const historyLength = tap.length.toVar();
    const validSurface = depth.greaterThan(0);
    const accumulatedLength = select(validSurface, historyLength, 0).add(1).toVar();
    const length = min(accumulatedLength, this.lengthCap).toVar();
    // 履歴長で今の値へ寄せる。長さ 1 以下は、蓄積前の補正とビット一致させるため今の値をそのまま選ぶ。
    const sample = select(allFinite(current.x, current.y, current.z), current, history);
    const blended = history.add(sample.sub(history).div(length));
    return vec4(select(length.lessThanEqual(1), current, blended), length);
  }

  // 番号ごとの位相と画素ごとのブルーノイズでずらした再投影位置から最近傍画素を選び、その面と履歴色から面重み付きの履歴長を返す。
  private addHistoryTap(
    clip: Vec4Node, normal: Vec3Node, previousCoordinate: Vec2Node,
    historyTarget: THREE.RenderTarget, previousWeight: SurfaceWeight,
  ): { readonly value: Vec3Node; readonly length: FloatNode } {
    // 画面外のタップは、読む座標を画面の端へ寄せたうえで重みを 0 にする。
    const calculatedJitter = vec2(
      fract(this.blueNoise.centeredAtScreenPixel().add(this.historyReadOffset.x)).mul(2).sub(1)
        .mul(HISTORY_JITTER_RADIUS),
      fract(this.blueNoise.centeredAtScreenPixel(vec2(0.5, 0.5)).add(this.historyReadOffset.y)).mul(2).sub(1)
        .mul(HISTORY_JITTER_RADIUS),
    );
    const texel = ivec2(floor(previousCoordinate.add(calculatedJitter).add(0.5))).toVar();
    const size = ivec2(screenSize).toVar();
    const inside = texel.x.greaterThanEqual(0).and(texel.x.lessThan(size.x))
      .and(texel.y.greaterThanEqual(0)).and(texel.y.lessThan(size.y));
    const safeX = select(texel.x.lessThan(0), int(0), select(texel.x.greaterThanEqual(size.x), size.x.sub(1), texel.x));
    const safeY = select(texel.y.lessThan(0), int(0), select(texel.y.greaterThanEqual(size.y), size.y.sub(1), texel.y));
    const safeTexel = ivec2(safeX, safeY).toVar();
    const surface = previousWeight.surfaceAt(safeTexel);
    const receiver = previousWeight.receiverAt(surface);
    const exponent = previousWeight.exponentAt(
      receiver, clip, normal, float(1), float(HISTORY_HALF_WEIGHT_ANGLE),
    );
    // 非有限の履歴は重み 0 を掛けても NaN のまま混ざり、近傍へ毎フレーム広がるので、掛ける前に値ごと落とす。
    const stored = textureLoad(historyTarget.textures[0]!, safeTexel).toVar();
    const surfaceWeight = exp2(exponent.negate());
    const usable = inside.and(surface.depth.greaterThan(0)).and(allFinite(
      clip.z, normal.x, normal.y, normal.z, exponent, surfaceWeight,
      stored.x, stored.y, stored.z, stored.w,
    ));
    const history = select(usable.and(surfaceWeight.greaterThan(0)), stored, vec4(0));
    return {
      value: history.rgb,
      length: select(usable, stored.a.mul(surfaceWeight), 0),
    };
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
