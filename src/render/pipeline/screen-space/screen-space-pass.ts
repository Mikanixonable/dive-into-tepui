// 遮蔽と照り返しのパス。G バッファの深度と法線から、画素ごとに近くの構造が遠方の拡散光(天体照と一様な
// 環境光)を塞いだ照度と、照り返しを描く方式では塞いでいる面が返す照度を求め、その差を符号付きの拡散照度
// 補正へ書く。方式と走査のスライス数・歩数を受け、方式がオフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, float, floor, fract, getViewPosition, ivec2, mrt, screenSize, screenUV, select, texture, textureLoad, uint,
  uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuPassId, type GpuTimings } from '../../gpu-timings';
import { BlueNoise } from '../../blue-noise';
import { ShadingSample } from '../lighting/shading-sample';
import { compileInto } from '../compile-into';
import { lambertianRadianceAt } from '../material-pass';
import {
  REPRESENTATIVE_STEPS, gbufferUVOf, projectedRadius, resolvesNearby, scanHemisphere, type PlanetIllumination,
} from './hemisphere-scan';
import { BandPyramid, bandLayoutOf, packedBands, type BandFormat, type BandLayout } from './band-pyramid';
import { CorrectionReconstruction } from './correction-reconstruction';
import { QReconstruction } from './q-reconstruction';
import { ScreenSpaceInputPyramid, levelExtent } from './screen-space-input-pyramid';
import { multiOutputMaterial, stageMaterial, type ScreenSpaceStage } from './screen-space-stage';
import { SurfaceWeight } from './surface-weight';
import { frameJitterForHistoryCap, type JitterSource, type ScanJitter } from './frame-jitter';
import { TemporalAccumulation } from './temporal-accumulation';
import { whiteNoiseAt } from './white-noise';
import type { DiffuseCorrection } from './diffuse-correction';
import type { PlanetLightSource } from '../lighting/planet-light-source';
import type { GBufferPass } from '../gbuffer';
import type { LightPrepass } from '../light-prepass';
import type { GraphicsSettingsData } from '../../graphics-settings';
import type {
  BoolNode, FloatNode, FloatUniform, IntNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node,
} from '../../tsl-types';

// 描くものの方式。オフ / 遮蔽だけ / 遮蔽と照り返し。
export const SCREEN_SPACE_DIFFUSE = { off: 0, occlusion: 1, indirect: 2 } as const;
type ScreenSpaceDiffuse = (typeof SCREEN_SPACE_DIFFUSE)[keyof typeof SCREEN_SPACE_DIFFUSE];

// 描画設定 graphics が選ぶ方式。遮蔽と照り返しの分野がオフならオフ、照り返しがオンなら遮蔽と照り返し、
// さもなくば遮蔽だけ。
export function screenSpaceDiffuseOf(graphics: GraphicsSettingsData): ScreenSpaceDiffuse {
  if (!graphics.screenSpaceOcclusion) return SCREEN_SPACE_DIFFUSE.off;
  return graphics.screenSpaceIndirect ? SCREEN_SPACE_DIFFUSE.indirect : SCREEN_SPACE_DIFFUSE.occlusion;
}

// 走査の段。scale は走査の解像度の描画バッファに対する比、sliceCount はスライスの数、stepCount は片側の歩数、
// bandCount と bandScale は補正を遮りの画面距離で分ける帯の数と、帯の座標の尺度 κ(BandSplit の count と scale)。
export interface ScanTier {
  readonly scale: number;
  readonly sliceCount: number;
  readonly stepCount: number;
  readonly bandCount: number;
  readonly bandScale: number;
}

// 帯の座標の尺度 κ。走査の解像度・スライス数・歩数・帯の数と組んで段にする。
// TODO: 帯の尺度は仮置き。費用と画質の指標の実測から選び直す。
const BAND_SCALE = 0.25;
// デバイス上限を読めない場合(renderer をスタブにしたテストなど)に使う WebGPU の既定値 [byte/sample]。
const DEFAULT_ATTACHMENT_BYTE_LIMIT = 32;

// renderer.backend から必要な WebGPU の描画先上限を読むための構造型。
interface WebGpuAttachmentLimitsBackend {
  readonly device?: { readonly limits?: { readonly maxColorAttachmentBytesPerSample?: number } };
}

// 解像度 scale・スライス sliceCount 本・片側 stepCount 歩・帯 bandCount 個の走査の段。
function scanTierOf(scale: number, sliceCount: number, stepCount: number, bandCount: number): ScanTier {
  return { scale, sliceCount, stepCount, bandCount, bandScale: BAND_SCALE };
}

// 疎な拡大の回転が読むブルーノイズのずれ [タイルの幅]。走査の 0・½・27/64 との差がタイルの自己相関の小さい所に
// 来るものを実測で選んだ。
const UPSAMPLE_ROTATION_SHIFT = 23 / 64;

// 走査の画素 pixel の代表の、受け持つブロックの中の位置 [1/REPRESENTATIVE_STEPS ブロック] — draw が負なら全ての画素で
// steps、0 以上なら番号 draw のホワイトノイズ(走査のずれが引く成分 0〜2 とは別の成分)から引いた位置。
function representativeOf(pixel: Vec2Node, steps: THREE.Node<'ivec2'>, draw: IntNode): THREE.Node<'ivec2'> {
  const random = ivec2(floor(
    vec2(whiteNoiseAt(pixel, uint(draw), 3), whiteNoiseAt(pixel, uint(draw), 4)).mul(REPRESENTATIVE_STEPS)));
  return select(draw.lessThan(0), steps, random);
}

// ブロックの中の位置 fraction(ブロックの幅に対する割合。0 以上 1 未満)を、代表の位置の刻みへ丸めた整数。
function representativeStepOf(fraction: number): number {
  return Math.min(REPRESENTATIVE_STEPS - 1, Math.round(fraction * REPRESENTATIVE_STEPS));
}

// 走査画素の下位 bit から回転の上位の 2 bit ずつへ写し、全画素共通の offset を足す。整列した 2^level 四方には 4^level 個の
// 等間隔な回転が 1 個ずつ入る。11 桁なら 2048 四方まで繰り返さない。
function stratifiedRotation(pixel: Vec2Node, offset: FloatNode): FloatNode {
  const x = uint(pixel.x);
  const y = uint(pixel.y);
  let rotation: FloatNode = offset;
  for (let level = 0; level < 11; level++) {
    const digit = x.shiftRight(uint(level)).bitAnd(uint(1))
      .add(y.shiftRight(uint(level)).bitAnd(uint(1)).shiftLeft(uint(1)));
    rotation = rotation.add(float(digit).mul(1 / 4 ** (level + 1)));
  }
  return fract(rotation);
}

// 描画命令を出す方式ごとの、描画命令の列。
type ModeStages = Readonly<
  Record<Exclude<ScreenSpaceDiffuse, typeof SCREEN_SPACE_DIFFUSE.off>, readonly ScreenSpaceStage[]>
>;

// render が描く段の範囲。all は全段、scan は面の写しと源と走査まで、chain は走査より後だけ(走査の描画先に残った帯の
// 値から描く)。scan と chain は、道具が走査と鎖を分けて描くためのもの。
export type ScreenSpaceStageRange = 'all' | 'scan' | 'chain';

// render-lab の比較だけで使う再構成方式。本番描画設定には公開しない。
export type ScreenSpaceExperimentVariant = 'band' | 'q' | 'raw-quarter' | 'raw-full';

// 帯の数 1 つぶんの描画命令 — 描く段の範囲と方式ごとの列 ranges と、そのうちこのパスが帯の数ごとに組んだもの own
// (面の写しと源、および代表の縮小列を除く)。
interface BandCountStages {
  readonly ranges: Readonly<Record<ScreenSpaceStageRange, ModeStages>>;
  readonly own: readonly ScreenSpaceStage[];
}

export class ScreenSpacePass {
  // フレーム番号に応じて履歴を写し、蓄積の段を持つ。
  private readonly temporal: TemporalAccumulation;
  // beginFrame がフレームごとに動かす走査の入力。null なら走査の入力は set* で置いた値を保つ。
  private jitterSources: readonly JitterSource[] | null = ['seed', 'scanRepresentative'];
  // 方式ごとの、段 0 の面の写しと源を書く描画命令。
  private readonly occlusionSurfaceStage: ScreenSpaceStage;
  private readonly indirectSurfaceStage: ScreenSpaceStage;
  // 帯の数・mergesIntoCorrection・天体照のスロット数の組ごとの描画命令。初めてその組で描くときに組む。
  private readonly stagesByKey = new Map<string, BandCountStages>();
  // 最後の拡大の描画命令。走査と鎖を再利用し、layout と K ごとにだけ組む。
  private readonly upsampleStagesByKey = new Map<string, ScreenSpaceStage>();
  private readonly experimentStagesByKey = new Map<string, readonly ScreenSpaceStage[]>();
  private readonly quad = new QuadMesh();
  // QuadMesh は固定直交カメラで描かれるため、実カメラの射影行列とその逆は毎フレーム自前で書き込む。
  private readonly projection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // render-lab の参照撮影で、最後の拡大の不確かさ入力だけを A = 1 に固定する。
  private readonly upsampleAlphaOne: FloatUniform = uniform(0);
  // 走査と帯の段。
  private tier: ScanTier;
  private readonly sliceCount = uniform(1, 'int');
  private readonly stepCount = uniform(1, 'int');
  private readonly bandScale: FloatUniform = uniform(1);
  // 走査のずれをホワイトノイズから引くパスの番号(setWhiteNoisePass)。負ならブルーノイズから引く。
  private readonly whiteNoisePass = uniform(-1, 'int');
  // 歩み・丸めのブルーノイズと拡大のブルーノイズを変える seed [タイルの幅] と、走査の全体の回転 [スライスの間隔]。
  // どちらも 0 以外の値は、同じ推定を独立な標本で繰り返すためのもの。
  private readonly seed: Vec2Uniform = uniform(new THREE.Vector2(0, 0));
  private readonly scanRotation: FloatUniform = uniform(0);
  // 描画バッファと走査の解像度 [px]。解像度の違う段どうしで、対応する画素を引くのに使う。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly scanSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  // 走査の代表の選び方(setScanJitter)。representativeDraw が負なら全ての走査の画素の代表が、受け持つブロックの中の
  // 位置 representativeSteps [1/REPRESENTATIVE_STEPS ブロック] にあり、0 以上なら走査の画素ごとにその番号のホワイトノイズで
  // 位置を引く。
  private readonly representativeSteps = uniform(
    new THREE.Vector2(REPRESENTATIVE_STEPS / 2, REPRESENTATIVE_STEPS / 2), 'ivec2');
  private readonly representativeDraw = uniform(-1, 'int');
  // 走査の解像度で描いている画素の整数座標、その画素の代表のブロックの中の位置、その代表の G バッファの画素の中心の uv。
  private readonly scanPixel: Vec2Node = floor(screenUV.mul(screenSize));
  private readonly representative: THREE.Node<'ivec2'> = representativeOf(
    this.scanPixel, this.representativeSteps, this.representativeDraw);
  private readonly gbufferUV: Vec2Node = gbufferUVOf(this.scanPixel, this.representative, this.fullSize);
  // 走査の解像度の画素の、光の向きと面の向きを引くシェーディング入力。
  private readonly sample: ShadingSample;
  // 段ごとの代表の面と、それで比べる帯の縮小・拡大と合流、描画バッファの解像度への拡大。
  private readonly surfaces: ScreenSpaceInputPyramid;
  private readonly bandPyramid: BandPyramid;
  private readonly reconstruction: CorrectionReconstruction;
  private readonly qReconstruction: QReconstruction;
  private qTargets: readonly [THREE.RenderTarget, THREE.RenderTarget, THREE.RenderTarget] | null = null;
  private readonly blueNoise = new BlueNoise();
  // 直前に render した方式。null はまだ render していないこと。
  private renderedMode: ScreenSpaceDiffuse | null = null;
  // render が描く段の範囲(setStageRange)。
  private stageRange: ScreenSpaceStageRange = 'all';
  private experiment: { readonly variant: ScreenSpaceExperimentVariant; readonly sparseTapCount: number } | null = null;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();
  // device.limits.maxColorAttachmentBytesPerSample。取得できなければ WebGPU の既定値。
  private readonly deviceAttachmentByteLimit: number;

  // lightPrepass は照り返しの源になる面と受け手へ届く遠方の拡散照度、planetLight は塞がれ方を数える天体照の球冠の
  // 出どころ。output は結果の描画先。mode は構築時点の方式、
  // sliceCount / stepCount は構築時点の走査のスライス数と片側の歩数。directionalPlanetCount は構築時点の、走査が
  // 遮りの向きを見る天体照の数(描画設定 screenSpaceDirectionalPlanetCount の値)。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly lightPrepass: LightPrepass,
    private readonly planetLight: PlanetLightSource,
    private readonly output: DiffuseCorrection, private readonly gpu: GpuTimings,
    private mode: ScreenSpaceDiffuse, scale: number, sliceCount: number, stepCount: number, bandCount: number,
    private directionalPlanetCount: number, private upsampleTapCount: number,
    private readonly exposureFactor: FloatNode,
  ) {
    this.deviceAttachmentByteLimit = (renderer.backend as WebGpuAttachmentLimitsBackend).device?.limits
      ?.maxColorAttachmentBytesPerSample ?? DEFAULT_ATTACHMENT_BYTE_LIMIT;
    this.tier = scanTierOf(scale, sliceCount, stepCount, bandCount);
    // 走査の解像度の面の読み手と、段ごとの代表の面・帯・再構成を組む。
    this.sample = new ShadingSample(gbuffer, this.gbufferUV);
    const weight = new SurfaceWeight(gbuffer, this.projection, this.projectionInverse, this.fullSize);
    this.surfaces = new ScreenSpaceInputPyramid(
      gbuffer, this.projectionInverse, this.fullSize, this.scanSize, this.representative);
    this.bandPyramid = new BandPyramid(this.surfaces, weight, this.fullSize, this.scanSize, this.exposureFactor);
    this.reconstruction = new CorrectionReconstruction(
      weight, this.surfaces, this.fullSize, this.scanSize, this.projection,
      vec2(this.representativeSteps).div(REPRESENTATIVE_STEPS), this.upsampleAlphaOne,
    );
    this.qReconstruction = new QReconstruction(weight, this.surfaces, this.fullSize, this.scanSize);
    this.temporal = new TemporalAccumulation(renderer, gbuffer, output);
    this.occlusionSurfaceStage = this.surfaces.scanStageOf(null);
    // 源は補正を受ける近い面にだけ書く — 遠い面(天体の面など)は画面の大半を占めうるが、その源が効くのは打ち切りの縁の
    // 受け手だけで、全面に書くと源の段が倍ほど重くなる。
    this.indirectSurfaceStage = this.surfaces.scanStageOf(
      this.whereResolved(this.gbufferUV, () => vec4(this.bounceSourceRadiance(), 1)));
  }

  // 走査の解像度。rgb = 照り返しの源として面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。方式が遮蔽では 0。
  public get surfaceRadianceTexture(): THREE.Texture { return this.surfaces.radianceTexture; }

  // 前フレームの補正履歴 (rgb = ΔE_screen、α = 履歴の長さ n)。
  public get temporalHistoryTexture(): THREE.Texture { return this.temporal.historyTexture; }

  // 前フレームの素の深度。
  public get previousDepthTexture(): THREE.Texture { return this.temporal.previousDepthTexture; }

  // correction.target の履歴長 n / 履歴の上限 s (0〜1)。
  public normalizedHistoryAt(uv: Vec2Node): FloatNode { return this.temporal.normalizedHistoryAt(uv); }

  // いまの段で補正を分ける帯の数。
  public get bandCount(): number { return this.tier.bandCount; }
  // いまの段の描画先に合わせた、走査・縮小段の描画命令。
  public get bandLayout(): BandLayout { return bandLayoutOf(this.tier.bandCount, this.deviceAttachmentByteLimit); }

  // いまの段が走査を描画バッファの解像度で行い、段 0 の合流が最後の拡大を介さず補正の描画先へ直接書くか。このとき段 0 の
  // 合流の描画先(DiffuseCorrection.mergedTarget(layout, 0))は書かれない。帯が 1 つなら合流が無いので常に偽。
  public get mergesIntoCorrection(): boolean { return this.tier.scale === 1 && this.tier.bandCount > 1; }

  // いまの段の走査の画素の幅 [描画バッファの画素]。走査の代表が巡れるブロックの中の位置は、この 2 乗の数だけある。
  public get scanCellSize(): number { return Math.round(1 / this.tier.scale); }

  public get experimentOutputTarget(): THREE.RenderTarget {
    if (this.experiment === null) throw new Error('screen-space: no experiment is active');
    return this.output.upsampledTarget;
  }

  // 段ごとの代表の面。
  public get inputPyramid(): ScreenSpaceInputPyramid { return this.surfaces; }

  // 次の render から方式 mode で描く。
  public setMode(mode: ScreenSpaceDiffuse): void {
    this.mode = mode;
  }

  // 次の render から解像度 scale・スライス sliceCount 本・片側 stepCount 歩・帯 bandCount 個で走査する。
  public setScan(scale: number, sliceCount: number, stepCount: number, bandCount: number): void {
    this.tier = scanTierOf(scale, sliceCount, stepCount, bandCount);
  }

  // 次のフレームから、静止時の履歴の上限を frames [フレーム](1 以上の整数)にする。1 なら蓄積前の補正をそのまま出し、
  // beginFrame が置く走査の入力は本番の静止画の値になる。
  public setHistoryCap(frames: number): void {
    this.temporal.setHistoryCap(frames);
  }

  // 次の render から、最後の拡大で読む疎なタップの数を count にする。
  public setUpsampleTapCount(count: number): void {
    this.upsampleTapCount = count;
  }

  // 番号 frame のフレームを始める。G バッファを描く前に毎フレーム呼ぶ。番号の続き方と変化量 change(0 以上。∞ は履歴を切る)
  // で履歴の残し方を決め、動かす源があれば走査の入力をその番号の位相へ置く。
  public beginFrame(frame: number, change: number): void {
    this.temporal.beginFrame(frame, change);
    const jitter = frameJitterForHistoryCap(
      frame, this.jitterSources, this.temporal.historyCapFrames, this.scanCellSize,
    );
    if (jitter === null) return;
    this.setSeed(jitter.seed[0], jitter.seed[1]);
    this.setScanRotation(jitter.scanRotation);
    this.setScanJitter(jitter.scanJitter);
  }

  // 次の beginFrame から、フレームごとに動かす走査の入力を sources にする。null なら走査の入力は set* で置いた値を保つ。
  public setJitterSources(sources: readonly JitterSource[] | null): void {
    this.jitterSources = sources === null ? null : [...sources];
  }

  // 次の render から段 tier で走査する。次に setScan を呼ぶまで保つ。
  public setTier(tier: ScanTier): void {
    this.tier = tier;
  }

  // 次の render から、走査が遮りの向きを見る天体照を、届ける明るさの強い先頭の count 個までにする(描画設定
  // screenSpaceDirectionalPlanetCount の値)。
  public setDirectionalPlanetCount(count: number): void {
    this.directionalPlanetCount = count;
  }

  // 次の render から、ブルーノイズのずれを (x, y) [タイルの幅] にする。
  public setSeed(x: number, y: number): void {
    this.seed.value.set(x, y);
  }

  // 次の render から、走査の全体の回転を rotation [スライスの間隔] にする。
  public setScanRotation(rotation: number): void {
    this.scanRotation.value = rotation;
  }

  // 次の render から、走査の 3 つのずれを、pass が null ならブルーノイズ(本番)から、整数ならパスの番号 pass のホワイト
  // ノイズ(画素・パス・成分ごとに独立)から引く。多くのパスを平均する道具のためのもの。
  public setWhiteNoisePass(pass: number | null): void {
    this.whiteNoisePass.value = pass ?? -1;
  }

  // 次の render から、走査の代表を jitter(ScanJitter)で選ぶ。null はブロックの中心。格子のずらしの位置が 0 以上 1 未満の
  // 範囲を外れたら投げる。
  public setScanJitter(jitter: ScanJitter | null): void {
    // 画素ごとに引くとき、拡大が読む全画素共通の代表の位置はブロックの中心にする。
    if (jitter?.kind === 'perPixel') {
      this.representativeDraw.value = jitter.draw;
      this.representativeSteps.value.set(REPRESENTATIVE_STEPS / 2, REPRESENTATIVE_STEPS / 2);
      return;
    }
    // 格子のずらしは、全ての走査の画素に同じ位置を代表の位置の刻みへ丸めて置く。
    const [x, y] = jitter?.fraction ?? [0.5, 0.5];
    if (!(x >= 0 && x < 1 && y >= 0 && y < 1)) {
      throw new RangeError(`screen-space: the scan representative (${x}, ${y}) is outside its block`);
    }
    this.representativeDraw.value = -1;
    this.representativeSteps.value.set(representativeStepOf(x), representativeStepOf(y));
  }

  // 次の render から、段の範囲 range(ScreenSpaceStageRange)だけを描く。chain は走査の描画先
  // (DiffuseCorrection.bandTarget の段 0)に置かれた帯の値を読む。
  public setStageRange(range: ScreenSpaceStageRange): void {
    this.stageRange = range;
  }

  // render-lab 専用。通常描画では false に戻して使う。
  public setUpsampleAlphaOne(enabled: boolean): void {
    this.upsampleAlphaOne.value = enabled ? 1 : 0;
  }

  // 比較用の再構成を選ぶ。null は通常の本番経路へ戻す。
  public setExperiment(variant: ScreenSpaceExperimentVariant | null, sparseTapCount = 8): void {
    this.experiment = variant === null ? null : { variant, sparseTapCount };
  }

  // 比較用の独立サンプルを完成補正まで描く。面と源は最初のパスだけ作り、後続パスでは再利用する。
  public renderExperimentPath(camera: THREE.Camera, width: number, height: number, includeSurface: boolean): void {
    if (this.experiment === null || this.mode === SCREEN_SPACE_DIFFUSE.off) {
      throw new Error('screen-space: an active experiment is required to render a complete path');
    }
    this.prepare(camera, width, height);
    const reusableSurfaceStages = includeSurface ? null : new Set([
      this.indirectSurfaceStage,
      ...this.surfaces.stagesUpTo(this.tier.bandCount),
    ]);
    for (const stage of this.resolveAccumulationStage(this.experimentStages(this.experiment.variant, this.experiment.sparseTapCount))) {
      if (reusableSurfaceStages?.has(stage)) continue;
      this.renderer.setRenderTarget(stage.target);
      this.quad.material = stage.material;
      this.gpu.beginPass(stage.gpuPass);
      this.quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(null);
  }

  // 1 フレームぶんを描く。G バッファと同じ寸法 width × height で、影パスの後・ライティングパスの前に呼ぶ。
  // camera は深度から位置を復元する行列を引き直すためだけに使う。
  public render(camera: THREE.Camera, width: number, height: number): void {
    if (this.mode !== this.renderedMode) this.clearUnwritten();
    this.renderedMode = this.mode;
    if (this.mode === SCREEN_SPACE_DIFFUSE.off) return;
    // **描画先の寸法を合わせる前に列を組む** — 代表の段の描画先は、列を組むときに作られる。
    const stages = this.currentStages();
    this.prepare(camera, width, height);
    // 面の写しと源 → 走査 → 代表の縮小列 → 帯の縮小 → 拡大と合流 → 拡大の順に、段ごとの描画先へ書く。
    for (const { material, target, gpuPass } of stages) {
      this.renderer.setRenderTarget(target);
      this.quad.material = material;
      this.gpu.beginPass(gpuPass);
      this.quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(null);
    if (stages.includes(this.temporal.accumulation)) this.temporal.markFrameRendered();
  }

  // いまの方式と段の全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    const stages = this.currentStages();
    this.prepare(camera, width, height);
    await this.temporal.compile();
    for (const { material, target } of stages) {
      this.quad.material = material;
      await compileInto(this.renderer, target, this.quad, this.quad.camera);
    }
  }

  // いまの方式と段の全段の、実行順の GPU の行とフラグメントシェーダの WGSL。それぞれの描画先へ当てて組む。
  public async stageShaders(
    camera: THREE.Camera, width: number, height: number,
  ): Promise<readonly { readonly gpuPass: GpuPassId; readonly wgsl: string }[]> {
    const stages = this.currentStages();
    this.prepare(camera, width, height);
    // 組むときの根は、板を描くときと同じく光源の無い空の Scene にする。
    const root = new THREE.Scene();
    const shaders: { readonly gpuPass: GpuPassId; readonly wgsl: string }[] = [];
    for (const { material, target, gpuPass } of stages) {
      this.quad.material = material;
      this.renderer.setRenderTarget(target);
      const { fragmentShader } = await this.renderer.debug.getShaderAsync(root, this.quad.camera, this.quad);
      if (fragmentShader === null) throw new Error(`screen-space: stage ${gpuPass} has no fragment shader`);
      shaders.push({ gpuPass, wgsl: fragmentShader });
    }
    this.renderer.setRenderTarget(null);
    return shaders;
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する単一の板
  // なので、ここでは解放しない。
  public dispose(): void {
    const own = [
      this.occlusionSurfaceStage, this.indirectSurfaceStage,
      ...[...this.stagesByKey.values()].flatMap((stages) => stages.own),
      ...this.upsampleStagesByKey.values(),
    ];
    for (const material of new Set(own.map(({ material }) => material))) material.dispose();
    for (const stages of this.experimentStagesByKey.values()) {
      for (const material of new Set(stages.map(({ material }) => material))) material.dispose();
    }
    for (const target of this.qTargets ?? []) target.dispose();
    this.temporal.dispose();
    this.surfaces.dispose();
    this.blueNoise.dispose();
  }

  // いまの方式と段の帯の数と段の範囲の描画命令の列。オフは空。
  private currentStages(): readonly ScreenSpaceStage[] {
    if (this.mode === SCREEN_SPACE_DIFFUSE.off) return [];
    const stages = this.experiment !== null
      ? this.experimentStages(this.experiment.variant, this.experiment.sparseTapCount)
      : this.stagesOf(this.tier, this.bandLayout).ranges[this.stageRange][this.mode];
    const resolved = this.resolveAccumulationStage(stages);
    const regularUpsample = this.experiment === null || this.experiment.variant === 'band';
    if (!regularUpsample || this.mergesIntoCorrection
      || !resolved.some((stage) => stage.gpuPass === GPU_PASS.nearbyDiffuseAccumulation)
      || resolved.some((stage) => stage.gpuPass === GPU_PASS.nearbyDiffuseUpsample)) return resolved;
    const upsample = this.upsampleStageOf(this.bandLayout);
    return resolved.flatMap((stage) => stage.gpuPass === GPU_PASS.nearbyDiffuseAccumulation
      ? [upsample, stage] : [stage]);
  }

  // 蓄積段を現在の ping-pong 出力先に結び直す。
  private resolveAccumulationStage(stages: readonly ScreenSpaceStage[]): readonly ScreenSpaceStage[] {
    return stages.map((stage) => stage.gpuPass === GPU_PASS.nearbyDiffuseAccumulation
      ? this.temporal.accumulation : stage);
  }

  private experimentStages(variant: ScreenSpaceExperimentVariant, sparseTapCount: number): readonly ScreenSpaceStage[] {
    const layout = this.bandLayout;
    const cacheKey = `${variant}:${JSON.stringify(layout)}:${sparseTapCount}:${this.directionalSlotCount}`;
    const cached = this.experimentStagesByKey.get(cacheKey);
    if (cached !== undefined) return cached;
    if (variant === 'raw-full') {
      const stages = [this.indirectSurfaceStage,
        this.createScanStage(1, this.surfaces.radianceTexture, this.output.upsampledTarget, layout[0]!, true),
        this.temporal.accumulation];
      this.experimentStagesByKey.set(cacheKey, stages);
      return stages;
    }
    const scan = this.stagesOf(this.tier, layout).ranges.scan[SCREEN_SPACE_DIFFUSE.indirect];
    if (variant === 'band') return this.stagesOf(this.tier, layout).ranges.all[SCREEN_SPACE_DIFFUSE.indirect];
    if (variant === 'raw-quarter') {
      if (layout[0] === 'packed-word') throw new Error('screen-space: raw-quarter cannot sample packed scan words');
      const stages = [...scan, this.createStochasticUpsampleStage(this.output.bandTarget(layout, 0).textures[0]!),
        this.temporal.accumulation];
      this.experimentStagesByKey.set(cacheKey, stages);
      return stages;
    }
    if (layout[0] === 'packed-word') throw new Error('screen-space: q cannot sample packed scan words');
    const [first, second, denoised] = this.qTargetsOf();
    const firstRotation = this.blueNoise.atScreenPixel(this.seed.add(36 / 64));
    const secondRotation = this.blueNoise.atScreenPixel(this.seed.add(61 / 64));
    const stages = [
      ...scan,
      this.createDenoiseStage(first!,
        () => this.qReconstruction.sparseDenoised(this.output.bandTarget(layout, 0).textures[0]!, firstRotation, sparseTapCount)),
      this.createDenoiseStage(second!,
        () => this.qReconstruction.sparseDenoised(first!.texture, secondRotation, sparseTapCount)),
      this.createDenoiseStage(denoised!, () => this.qReconstruction.denseDenoised(second!.texture)),
      this.createStochasticUpsampleStage(denoised!.texture),
      this.temporal.accumulation,
    ];
    this.experimentStagesByKey.set(cacheKey, stages);
    return stages;
  }

  // 走査が円盤の向きで遮りを数える天体照のスロットの数。使うスロット(PlanetLightSource.count)の先頭のこれだけで、
  // 残りの使うスロットは環境光と同じく向きによらず塞ぐ。
  private get directionalSlotCount(): number {
    return Math.min(this.directionalPlanetCount, this.planetLight.count);
  }

  // ライトプリパスが遠方の拡散照度を向きを見るスロットごとと和とに分ける枚数。走査をしない方式なら null で、分けない。
  public get farDiffuseSplit(): number | null {
    return this.mode === SCREEN_SPACE_DIFFUSE.off ? null : this.directionalSlotCount;
  }

  // 帯の数 count・mergesIntoCorrection・向きを見る天体照のスロット数で決まる描画命令。初めて引いたときに組み、以後は同じものを返す。
  private stagesOf(tier: ScanTier, layout: BandLayout): BandCountStages {
    const { bandCount: count } = tier;
    const format = layout[0]!;
    const intoCorrection = this.mergesIntoCorrection;
    const key = `${JSON.stringify(layout)}:${intoCorrection}:${this.directionalSlotCount}`;
    const built = this.stagesByKey.get(key);
    if (built !== undefined) return built;
    const scanTarget = this.output.bandTarget(layout, 0);
    const occlusionScan = this.createScanStage(count, null, scanTarget, format);
    const indirectScan = this.createScanStage(count, this.surfaces.radianceTexture, scanTarget, format);
    // 走査より後の段は方式によらないので、両方の方式で同じ描画命令を使う。
    const chain = this.createChainStages(count, intoCorrection, layout);
    const scans: ModeStages = {
      [SCREEN_SPACE_DIFFUSE.occlusion]: [this.occlusionSurfaceStage, occlusionScan],
      [SCREEN_SPACE_DIFFUSE.indirect]: [this.indirectSurfaceStage, indirectScan],
    };
    const afterScan = [...this.surfaces.stagesUpTo(count), ...chain, this.temporal.accumulation];
    const stages: BandCountStages = {
      ranges: {
        all: {
          [SCREEN_SPACE_DIFFUSE.occlusion]: [...scans[SCREEN_SPACE_DIFFUSE.occlusion], ...afterScan],
          [SCREEN_SPACE_DIFFUSE.indirect]: [...scans[SCREEN_SPACE_DIFFUSE.indirect], ...afterScan],
        },
        scan: scans,
        chain: { [SCREEN_SPACE_DIFFUSE.occlusion]: afterScan, [SCREEN_SPACE_DIFFUSE.indirect]: afterScan },
      },
      own: [occlusionScan, indirectScan, ...chain],
    };
    this.stagesByKey.set(key, stages);
    return stages;
  }

  // 受け手へ届く遠方の拡散光のうち塞がれた照度と照り返しの差を、帯の数 count の帯ごとに求めて詰めて書く、走査の
  // 描画命令を組む。radiance は照り返しの源の放射輝度で、null なら照り返しを集めない。
  private createScanStage(
    count: number, radiance: THREE.Texture | null, target: THREE.RenderTarget, format: BandFormat, directCorrection = false,
  ): ScreenSpaceStage {
    // 丸めのずれのタイルのずれ 27/64 は、歩みのずれ(½)と画素ごとに相関しないものを実測で選んだ。
    const whiteAt = (component: number): FloatNode => whiteNoiseAt(this.scanPixel, uint(this.whiteNoisePass), component);
    const useBlue = this.whiteNoisePass.lessThan(0);
    const noise = vec3(
      select(useBlue, stratifiedRotation(this.scanPixel, this.scanRotation), whiteAt(0)),
      select(useBlue, this.blueNoise.atScreenPixel(this.seed.add(0.5)), whiteAt(1)),
      select(useBlue, this.blueNoise.atScreenPixel(this.seed.add(27 / 64)), whiteAt(2)),
    );
    const directional = this.directionalSlotCount;
    const planets: readonly PlanetIllumination[] = Array.from({ length: directional }, (_, slot) => ({
      cap: this.planetLight.capAt(this.sample, slot),
      irradiance: this.irradianceFrom(this.lightPrepass.directionalPlanetDiffuseTexture(slot)),
    }));
    const material = multiOutputMaterial(target, () => {
      // 向きを見ない天体照は漏らさず、環境光と同じく向きによらず塞ぐ。
      const undirected = this.irradianceFrom(this.lightPrepass.undirectedFarDiffuseTexture);
      const corrections = scanHemisphere(
        this.surfaces, this.fullSize, this.projection, this.projectionInverse, this.sliceCount, this.stepCount, noise,
        undirected, planets, radiance,
        { count, scale: this.bandScale },
      );
      return directCorrection ? [vec4(corrections[0]!, float(1))] : packedBands(corrections, format, this.exposureFactor);
    });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseScan };
  }

  // 帯の数 count の、帯の縮小(段 1..count − 1)→ 拡大と合流(段 count − 2..0)の描画命令の列。intoCorrection なら段 0 の
  // 合流は補正の描画先へ直接書く(走査が描画バッファの解像度で、最後の拡大を組まないとき)。
  private createChainStages(count: number, intoCorrection: boolean, layout: BandLayout): ScreenSpaceStage[] {
    const reduce: ScreenSpaceStage[] = [];
    for (let level = 1; level < count; level++) {
      const finer = this.output.bandTextures(layout, level - 1);
      const target = this.output.bandTarget(layout, level);
      const material = multiOutputMaterial(target, () => this.bandPyramid.reduced(finer, layout, level));
      reduce.push({ material, target, gpuPass: GPU_PASS.nearbyDiffuseBandReduce });
    }
    const merge = Array.from({ length: count - 1 }, (_, index): ScreenSpaceStage => {
      const level = count - 2 - index;
      const direct = intoCorrection && level === 0;
      const target = direct ? this.output.upsampledTarget : this.output.mergedTarget(layout, level);
      const coarse = this.output.mergedTexture(layout, level + 1);
      const coarseBands = this.output.bandTextures(layout, level + 1);
      const own = this.output.bandTextures(layout, level);
      const value = (): Vec4Node => this.bandPyramid.merged(coarse, coarseBands, own, layout, level);
      // 段 0 の受け手は走査の受け手なので、走査と同じく補正を受けない受け手を 0 で塗る。補正の描画先の α は 1。
      const material = stageMaterial();
      const output = direct ? this.whereResolved(this.gbufferUV, () => vec4(value().rgb, 1))
        : level === 0 ? this.whereResolved(this.gbufferUV, value) : Fn(value)();
      material.mrtNode = mrt({ [target.texture.name]: output });
      return { material, target, gpuPass: GPU_PASS.nearbyDiffuseMerge };
    });
    return [...reduce, ...merge];
  }

  // 帯の数 count の、走査の解像度の最後の拡大の前の補正を、描画バッファの解像度へ疎なタップで拡大する描画命令を組む。
  // 拡大は描画バッファの解像度の受け手で、補正を受けるかを測り直す。
  private createUpsampleStage(layout: BandLayout): ScreenSpaceStage {
    const source = this.output.mergedTexture(layout, 0);
    const rotation = this.blueNoise.atScreenPixel(this.seed.add(UPSAMPLE_ROTATION_SHIFT));
    const tapCount = this.upsampleTapCount;
    const upsample = stageMaterial();
    upsample.mrtNode = mrt({ [this.output.upsampledTarget.texture.name]: this.whereResolved(screenUV,
      () => vec4(this.reconstruction.sparseUpsampled(source, rotation, tapCount), 1)) });
    return { material: upsample, target: this.output.upsampledTarget, gpuPass: GPU_PASS.nearbyDiffuseUpsample };
  }

  private upsampleStageOf(layout: BandLayout): ScreenSpaceStage {
    const key = `${JSON.stringify(layout)}:${this.upsampleTapCount}`;
    const built = this.upsampleStagesByKey.get(key);
    if (built !== undefined) return built;
    const stage = this.createUpsampleStage(layout);
    this.upsampleStagesByKey.set(key, stage);
    return stage;
  }

  private createDenoiseStage(
    target: THREE.RenderTarget, value: () => Vec3Node,
  ): ScreenSpaceStage {
    const material = stageMaterial();
    material.mrtNode = mrt({ [target.texture.name]: this.whereResolved(this.gbufferUV, () => vec4(value(), 1)) });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseDenoise };
  }

  private createStochasticUpsampleStage(source: THREE.Texture): ScreenSpaceStage {
    const choice = this.blueNoise.atScreenPixel(this.seed.add(23 / 64));
    const material = stageMaterial();
    material.mrtNode = mrt({ [this.output.upsampledTarget.texture.name]: this.whereResolved(screenUV,
      () => vec4(this.qReconstruction.stochasticUpsampled(source, choice), 1)) });
    return { material, target: this.output.upsampledTarget, gpuPass: GPU_PASS.nearbyDiffuseUpsample };
  }

  // 描いている画素を、uv(描いている画素に当たる G バッファの uv)の面が補正を受ける(resolvesNearbyAt)ときだけ
  // value で塗り、ほかは (0, 0, 0, 1) で塗る出力。value は一様でない分岐の中で組むので、テクスチャは段を明示して読むこと。
  private whereResolved(uv: Vec2Node, value: () => Vec4Node): Vec4Node {
    return Fn(() => {
      const result = vec4(0, 0, 0, 1).toVar();
      const depth = textureLoad(this.gbuffer.depthTexture, ivec2(floor(uv.mul(this.fullSize)))).r.toVar();
      If(this.resolvesNearbyAt(depth, uv), () => {
        result.assign(value());
      });
      return result;
    })();
  }

  // 走査の画素が表す面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。照度はライトプリパスの遠方の拡散照度で、
  // その面自身の遮られ方を含まない — それはこのパスの出力そのものなので、1 パスの中では求まらない。一様でない分岐の中から
  // 呼んでよい。
  private bounceSourceRadiance(): Vec3Node {
    return lambertianRadianceAt(this.gbuffer, this.gbufferUV, this.irradianceFrom(this.lightPrepass.diffuseTexture));
  }

  // ライトプリパスの照度バッファ source を、走査の画素が表す面で読んだ照度。一様でない分岐の中から呼んでよい。
  private irradianceFrom(source: THREE.Texture): Vec3Node {
    return texture(source, this.gbufferUV).level(float(0)).rgb;
  }

  // uv の画素の素の深度 depth の受け手が補正を受けるか(resolvesNearby)。半径は、描いている解像度によらず走査の
  // 画素で測る。
  private resolvesNearbyAt(depth: FloatNode, uv: Vec2Node): BoolNode {
    const position = getViewPosition(uv, depth, this.projectionInverse);
    return resolvesNearby(depth, projectedRadius(position, this.projection, this.scanSize));
  }

  // 描画先と標本数・帯の尺度を段へ合わせ、深度から位置を復元する行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    const tier = this.tier;
    this.sliceCount.value = tier.sliceCount;
    this.stepCount.value = tier.stepCount;
    this.bandScale.value = tier.bandScale;
    const scanWidth = Math.max(1, Math.ceil(width * tier.scale));
    const scanHeight = Math.max(1, Math.ceil(height * tier.scale));
    this.surfaces.setSize(scanWidth, scanHeight);
    const levelSizes = Array.from({ length: tier.bandCount }, (_, level) =>
      [levelExtent(scanWidth, level), levelExtent(scanHeight, level)] as const);
    this.output.setSize(this.bandLayout, levelSizes, width, height);
    this.temporal.prepare(camera, width, height);
    if (this.experiment?.variant === 'q') {
      for (const target of this.qTargetsOf()) target.setSize(scanWidth, scanHeight);
    }
    this.fullSize.value.set(width, height);
    this.scanSize.value.set(scanWidth, scanHeight);
    // 実カメラの行列。
    this.projection.value.copy(camera.projectionMatrix);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.sample.sync(camera);
  }

  // 方式がオフで前の像が残る描画先 — 全部 — を空へ戻す。残すと、デバッグ表示に切る直前の像が凍ったまま出る。
  private clearUnwritten(): void {
    if (this.mode !== SCREEN_SPACE_DIFFUSE.off) return;
    const unwritten = [...this.surfaces.targets, ...this.output.targets];
    // 消去色はレンダラーを共有する他のパスのものなので、退避して黒の透明で消し、戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    for (const target of unwritten) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  private qTargetsOf(): readonly [THREE.RenderTarget, THREE.RenderTarget, THREE.RenderTarget] {
    if (this.qTargets !== null) return this.qTargets;
    this.qTargets = [0, 1, 2].map((index) => {
      const target = new THREE.RenderTarget(1, 1, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      target.texture.name = `qDiffuseCorrection${index}`;
      return target;
    }) as [THREE.RenderTarget, THREE.RenderTarget, THREE.RenderTarget];
    return this.qTargets;
  }
}
