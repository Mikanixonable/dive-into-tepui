// フレーム番号の進み方と履歴の上限を求め、近傍拡散補正を時間方向に蓄積する。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, exp2, floatBitsToUint, floor, float, int, ivec2, max, min, mrt, screenSize, screenUV, select, texture,
  textureLoad, uint, uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { compileInto } from '../compile-into';
import { multiOutputMaterial, stageMaterial, type ScreenSpaceStage } from './screen-space-stage';
import type { DiffuseCorrection } from './diffuse-correction';
import { octDecodeNormal } from '../gbuffer';
import type { GBufferPass } from '../gbuffer';
import { SurfaceWeight, type SurfaceTextures } from './surface-weight';
import type {
  BoolNode, FloatNode, FloatUniform, IVec2Node, Mat3Uniform, Mat4Uniform, UintNode, Vec2Node, Vec3Node, Vec4Node,
} from '../../tsl-types';

const HALF_WEIGHT_ANGLE = Math.PI / 9;

// 単精度浮動小数の指数部のビット。±∞ と NaN だけが、このビットをすべて立てる。
const FLOAT_EXPONENT_BITS = 0x7f800000;

// components がすべて有限か。WGSL の実装は非有限の値が現れないと仮定して浮動小数の比較を畳んでよいので、ビット列で判定する。
function allFinite(...components: FloatNode[]): BoolNode {
  return components.map((component) => {
    // floatBitsToUint の @types/three 上の戻り値型は値の型を持たないため、UintNode へ読み替える。
    const bits = floatBitsToUint(component) as unknown as UintNode;
    return bits.bitAnd(uint(FLOAT_EXPONENT_BITS)).notEqual(uint(FLOAT_EXPONENT_BITS));
  }).reduce((finite, next) => finite.and(next));
}

// 履歴と前フレームの深度・法線を、それぞれの形式の添付先へまとめる。
function targetOf(): THREE.RenderTarget {
  // 履歴値と前フレームの面を同じ画素へ写せるよう、形式ごとに添付を分ける。
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

// 履歴と前フレームの面を保持し、蓄積の段を correction.target へ書く。beginFrame は G バッファを描く前に毎フレーム呼ぶ。
export class TemporalAccumulation {
  // 履歴と前フレームの面を保持し、蓄積段の出力先にも使う。
  private readonly target = targetOf();
  // 履歴コピーと蓄積の全画面描画に使う。
  private readonly quad = new QuadMesh();
  // 描画設定から受け取る静止時の履歴上限。
  private readonly historyCap: FloatUniform = uniform(1);
  // 現在の変化量から決めた履歴長の上限。
  private readonly lengthCap: FloatUniform = uniform(1);
  // 前フレームの面を復元するときに使う射影とその逆。
  private readonly previousProjection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly previousProjectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // 前フレームの視点座標を保持し、今の view と合わせて法線を移す。
  private readonly previousView = new THREE.Matrix4();
  // 今の法線を前フレームの視点座標へ移す回転行列。
  private readonly normalToPreviousView: Mat3Uniform = uniform(new THREE.Matrix3());
  // prepare が記録する今の射影と逆射影。
  private readonly currentProjection = new THREE.Matrix4();
  private readonly currentProjectionInverse = new THREE.Matrix4();
  // prepare が記録する今の view。
  private readonly currentView = new THREE.Matrix4();
  // prepare で前 view と今の world 行列を合成する作業行列。
  private readonly normalMatrix = new THREE.Matrix4();
  // 履歴ターゲット内の深度・法線を前フレームの面として読む。
  private readonly previousSurfaces: SurfaceTextures;
  // 前フレームの面との整合性から再投影タップの重みを求める。
  private readonly previousWeight: SurfaceWeight;
  // 補正と G バッファを履歴ターゲットへ写す段。
  private readonly copyStage: ScreenSpaceStage;
  // 再投影した履歴と今の補正を correction.target へ混ぜて書く段。
  private readonly accumulationStage: ScreenSpaceStage;
  // 最後に beginFrame が受けた論理番号。
  private previousFrame: number | null = null;
  // 最後の番号の補正段が実際に描かれたかを記録する。
  private previousFrameRendered = false;

  // 同じ描画系の renderer、G バッファ、補正先、GPU 計測を渡して構築する。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly correction: DiffuseCorrection, private readonly gpu: GpuTimings,
  ) {
    this.previousSurfaces = { depthTexture: this.target.textures[1]!, normalTexture: this.target.textures[2]! };
    this.previousWeight = new SurfaceWeight(
      this.previousSurfaces, this.previousProjection, this.previousProjectionInverse, vec2(screenSize),
    );
    this.copyStage = this.copyStageOf();
    this.accumulationStage = this.accumulationStageOf();
  }

  public get historyTexture(): THREE.Texture { return this.target.textures[0]!; }
  public get previousDepthTexture(): THREE.Texture { return this.target.textures[1]!; }
  public get previousNormalTexture(): THREE.Texture { return this.target.textures[2]!; }
  public get accumulation(): ScreenSpaceStage { return this.accumulationStage; }
  // 現在の履歴の上限 [フレーム]。
  public get historyCapFrames(): number { return this.historyCap.value; }

  // 履歴と前フレームの面を width × height へ合わせ、寸法が変われば true を返す。
  public setSize(width: number, height: number): boolean {
    if (this.target.width === width && this.target.height === height) return false;
    this.target.setSize(width, height);
    this.lengthCap.value = 1;
    return true;
  }

  // 履歴の上限 frames [フレーム] を履歴長の上限の計算とデバッグ表示へ渡す。
  public setHistoryCap(frames: number): void {
    this.historyCap.value = frames;
  }

  // 履歴の寸法と今のカメラ行列を記録し、前視点へ法線を回す行列を組む。
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

  // G バッファを上書きする前に、連続して描いた前フレームがあれば履歴へ写す。
  public beginFrame(frame: number, change: number): void {
    // 同じ番号の再描画では履歴を写さず、次の advance 判定用の描画済み印を外す。
    const step = frameStepOf(this.previousFrame, frame, change);
    if (step === 'repeat') {
      this.previousFrameRendered = false;
      return;
    }
    // 連続番号かつ前番号が描画済みなら、カメラ記録と履歴面を前フレームへ移す。
    if (step === 'advance' && this.previousFrameRendered) {
      this.previousProjection.value.copy(this.currentProjection);
      this.previousProjectionInverse.value.copy(this.currentProjectionInverse);
      this.previousView.copy(this.currentView);
      this.copyPreviousFrame();
      this.lengthCap.value = lengthCapOf(this.historyCap.value, change);
    } else {
      // cut または前番号未描画では、履歴を今の値だけに制限する。
      this.lengthCap.value = 1;
    }
    this.previousFrame = frame;
    this.previousFrameRendered = false;
  }

  // 近傍拡散補正の段を描いたことを、次の番号へ進むときの判断に使う。
  public markFrameRendered(): void {
    this.previousFrameRendered = true;
  }

  // beginFrame の履歴写しで使うマテリアルを、履歴ターゲットへ事前コンパイルする。
  public async compile(): Promise<void> {
    this.quad.material = this.copyStage.material;
    await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
  }

  // 描画系の破棄時に呼び、以後このインスタンスを使わない。
  public dispose(): void {
    // インスタンスを使い終えたとき、所有する描画先と段の材質を解放する。
    this.target.dispose();
    this.copyStage.material.dispose();
    this.accumulationStage.material.dispose();
  }

  // コンストラクタから一度呼び、返した段を compile・描画・破棄で共有する。
  private copyStageOf(): ScreenSpaceStage {
    // 3 添付を同じ画素から読み、履歴値・深度・法線を一度に写す段を作る。
    const target = this.target;
    const pixel = ivec2(floor(screenUV.mul(screenSize)));
    const material = multiOutputMaterial(target, () => [
      textureLoad(this.correction.target.texture, pixel),
      vec4(textureLoad(this.gbuffer.depthTexture, pixel).r, 0, 0, 0),
      vec4(textureLoad(this.gbuffer.normalTexture, pixel).rg, 0, 0),
    ]);
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseHistoryCopy };
  }

  // 蓄積前の補正の rgb と履歴長 1 を correction.target へ書く段を作る。
  private accumulationStageOf(): ScreenSpaceStage {
    const target = this.correction.target;
    const material = stageMaterial();
    material.mrtNode = mrt({
      [target.texture.name]: Fn(() => {
        return this.accumulatedValue();
      })(),
    });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseAccumulation };
  }

  // 前フレームの四近傍から履歴を再投影し、今の補正と履歴長で混ぜる。非有限な履歴の画素は再投影に使わず、
  // 非有限な今の値は、履歴があればその標本を捨てて履歴を保つ。
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
    const total = this.addHistoryTap(clip, normal, base, fraction, 0, 0);
    const right = this.addHistoryTap(clip, normal, base, fraction, 1, 0);
    const bottom = this.addHistoryTap(clip, normal, base, fraction, 0, 1);
    const diagonal = this.addHistoryTap(clip, normal, base, fraction, 1, 1);
    const totalWeight = total.weight.add(right.weight).add(bottom.weight).add(diagonal.weight).toVar();
    const history = total.value.add(right.value).add(bottom.value).add(diagonal.value)
      .div(max(totalWeight, 1e-20)).toVar();
    const historyLength = total.length.add(right.length).add(bottom.length).add(diagonal.length).toVar();
    const validSurface = depth.greaterThan(0);
    const accumulatedLength = select(validSurface, historyLength, 0).add(1).toVar();
    const length = min(accumulatedLength, this.lengthCap).toVar();
    // 履歴長で今の値へ寄せる。長さ 1 以下は今の値をそのまま選び、s=1 の出力を一致させる。
    const sample = select(allFinite(current.x, current.y, current.z), current, history);
    const blended = history.add(sample.sub(history).div(length));
    return vec4(select(length.lessThanEqual(1), current, blended), length);
  }

  // 前フレームの画素を受け手にし、再投影した点との面重みを履歴値へ掛ける。
  private addHistoryTap(
    clip: Vec4Node, normal: Vec3Node,
    base: IVec2Node, fraction: Vec2Node, dx: number, dy: number,
  ): { readonly weight: FloatNode; readonly value: Vec3Node; readonly length: FloatNode } {
    // 画面内かつ面のあるタップだけを履歴候補にする。
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
      receiver, clip, normal, float(1), float(HALF_WEIGHT_ANGLE),
    );
    const bilinear = (dx === 0 ? fraction.x.oneMinus() : fraction.x)
      .mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
    // 面があり値が有限なタップの、面の重みと双線形係数を合わせた重みと、重みを掛けた履歴 RGB と長さを返す。
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

  // beginFrame が advance と判定したとき、補正と G バッファを履歴へ写す。
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

// 変化量 change が履歴の計算で使える値かを検査する。
function assertChange(change: number): void {
  if (Number.isNaN(change) || change < 0) {
    throw new RangeError(`screen-space: invalid change ${change}`);
  }
}

// 前回番号 previous と今回の番号 frame から、履歴を再利用できる進み方を返す。
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

// 履歴の上限 historyCap [フレーム] と変化量 change から、履歴長の上限を返す。古い値が 1 フレームで残る割合を、静止時の
// 残り (1 − 1/s) と変わらなかった割合 e^(−d) の積にした 1 / (1 − (1 − 1/s)·e^(−d)) を、d = 0 で s・d = ∞ で 1 が丸めなしで
// 出る形に変形して求める。
export function lengthCapOf(historyCap: number, change: number): number {
  if (!Number.isInteger(historyCap) || historyCap < 1) {
    throw new RangeError(`screen-space: invalid history cap ${historyCap}`);
  }
  assertChange(change);
  return historyCap / (1 + (historyCap - 1) * -Math.expm1(-change));
}
