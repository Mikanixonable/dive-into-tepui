// 遮蔽と照り返しのパス。G バッファの深度と法線から、画素ごとに近くの構造が遠方の拡散光(天体照と一様な
// 環境光)を塞いだ照度と、照り返しを描く方式では塞いでいる面が返す照度を求め、その差を符号付きの拡散照度
// 補正へ書く。描画設定の方式と精細さを受け、方式がオフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, float, floor, fract, getViewPosition, ivec2, mrt, screenSize, screenUV, select, texture, textureLoad, uint, uniform,
  vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuPassId, type GpuTimings } from '../../gpu-timings';
import { BlueNoise } from '../../blue-noise';
import { ShadingSample } from '../lighting/shading-sample';
import { MAX_PLANET_LIGHT_SLOTS, type PlanetLightSource } from '../lighting/planet-light-source';
import { compileInto } from '../compile-into';
import {
  gbufferUVOf, projectedRadius, resolvesNearby, scanHemisphere, type PlanetIllumination,
} from './hemisphere-scan';
import { BandPyramid, packedBands } from './band-pyramid';
import { CorrectionReconstruction } from './correction-reconstruction';
import { QReconstruction } from './q-reconstruction';
import { ScreenSpaceInputPyramid, levelExtent } from './screen-space-input-pyramid';
import { multiOutputMaterial, stageMaterial, type ScreenSpaceStage } from './screen-space-stage';
import { SurfaceWeight } from './surface-weight';
import { whiteNoiseAt } from './white-noise';
import type { DiffuseCorrection } from './diffuse-correction';
import type { GBufferPass } from '../gbuffer';
import type { AmbientSource } from '../lighting/ambient-source';
import type { SunSource } from '../lighting/sun-source';
import type {
  BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node,
} from '../../tsl-types';

// 描画設定「遮蔽と照り返し」の値。値は保存された設定を読む鍵なので、段を足しても既存の値は動かさない。
export const SCREEN_SPACE_DIFFUSE = { off: 0, occlusion: 1, indirect: 2 } as const;
type ScreenSpaceDiffuse = (typeof SCREEN_SPACE_DIFFUSE)[keyof typeof SCREEN_SPACE_DIFFUSE];

// 描画設定「遮蔽と照り返しの精細さ」の値。
export const SCREEN_SPACE_QUALITY = { low: 0, medium: 1, high: 2 } as const;
type ScreenSpaceQuality = (typeof SCREEN_SPACE_QUALITY)[keyof typeof SCREEN_SPACE_QUALITY];

// 走査の段。scale は走査の解像度の描画バッファに対する比、sliceCount はスライスの数、stepCount は片側の歩数、
// bandCount と bandScale は補正を遮りの画面距離で分ける帯の数と、遮蔽の尺度 κ_o(BandSplit の count と occlusionScale)。
// bandFactors は帯の座標に向きの因子を入れる撮影用の欄で、省くと強さ 0・照り返しの κ_b = bandScale(距離だけ)。
export interface ScanTier {
  readonly scale: number;
  readonly sliceCount: number;
  readonly stepCount: number;
  readonly bandCount: number;
  readonly bandScale: number;
  readonly bandFactors?: BandFactors;
}

// 照り返しの尺度 κ_b と、因子の強さ s(0..1。省くと 0)。bounce は照り返しの a〜c、occlusion は遮蔽の b・c
// (FacingStrengths の欄)。
export interface BandFactors {
  readonly bounceScale?: number;
  readonly bounce?: {
    readonly senderFacing?: number;
    readonly receiverFacing?: number;
    readonly receiverView?: number;
  };
  readonly occlusion?: {
    readonly receiverFacing?: number;
    readonly receiverView?: number;
  };
}
// 精細さの段ごとの走査。値は、解像度・スライス数・歩数の候補の組の費用と画質の指標を実測して選んだ。
// TODO: 中のスライス数と歩数、帯の数と尺度は仮置き。費用と画質の指標の実測から選び直す。
const SCAN_TIERS: Readonly<Record<ScreenSpaceQuality, ScanTier>> = {
  [SCREEN_SPACE_QUALITY.low]: { scale: 0.25, sliceCount: 2, stepCount: 3, bandCount: 4, bandScale: 0.52 },
  [SCREEN_SPACE_QUALITY.medium]: { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale: 0.52 },
  [SCREEN_SPACE_QUALITY.high]: { scale: 0.25, sliceCount: 4, stepCount: 6, bandCount: 4, bandScale: 0.52 },
};

// 疎な拡大の回転が読むブルーノイズのずれ [タイルの幅]。走査の 0・½・27/64 との差がタイルの自己相関の小さい所に
// 来るものを実測で選んだ。
const UPSAMPLE_ROTATION_SHIFT = 23 / 64;

// 走査画素の下位 bit から回転の上位の 2 bit ずつへ写す。整列した 2^level 四方には 4^level 個の
// 等間隔な回転が 1 個ずつ入る。11 桁なら 2048 四方まで繰り返さない。
function stratifiedRotation(pixel: Vec2Node, seed: FloatNode): FloatNode {
  const x = uint(pixel.x);
  const y = uint(pixel.y);
  let rotation: FloatNode = seed;
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
  // 方式ごとの、段 0 の面の写しと源を書く描画命令。
  private readonly occlusionSurfaceStage: ScreenSpaceStage;
  private readonly indirectSurfaceStage: ScreenSpaceStage;
  // 帯の数ごとの描画命令。初めてその帯の数で描くときに組む。
  private readonly stagesByBandCount = new Map<number, BandCountStages>();
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
  private readonly bounceBandScale: FloatUniform = uniform(1);
  private readonly bounceStrengths = {
    senderFacing: uniform(0), receiverFacing: uniform(0), receiverView: uniform(0),
  };
  private readonly occlusionStrengths = { receiverFacing: uniform(0), receiverView: uniform(0) };
  // 走査のずれをホワイトノイズから引くパスの番号(setWhiteNoisePass)。負ならブルーノイズから引く。
  private readonly whiteNoisePass = uniform(-1, 'int');
  // 走査の全体の回転と、歩み・丸めのブルーノイズ、拡大のブルーノイズを変える seed [タイルの幅]。
  // (0, 0) 以外の値は、同じ推定を独立な標本で繰り返すためのもの。
  private readonly seed: Vec2Uniform = uniform(new THREE.Vector2(0, 0));
  // 描画バッファと走査の解像度 [px]。解像度の違う段どうしで、対応する画素を引くのに使う。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly scanSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  // 走査の解像度で描いている画素の整数座標と、その画素が表す G バッファの画素の中心の uv。
  private readonly scanPixel: Vec2Node = floor(screenUV.mul(screenSize));
  private readonly gbufferUV: Vec2Node = gbufferUVOf(this.scanPixel, this.fullSize);
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

  // sun / ambient は照り返しの源になる面を照らす太陽と環境光、planetLight は塞がれ方を数える天体照の
  // 球冠の出どころであり、その面を照らす天体照でもある。ambient と planetLight は受け手へ届く遠方の拡散光でも
  // ある。output は結果の描画先。mode / quality は構築時点の描画設定 screenSpaceDiffuse / screenSpaceQuality の値。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass, sun: SunSource,
    private readonly planetLight: PlanetLightSource, private readonly ambient: AmbientSource,
    private readonly output: DiffuseCorrection, private readonly gpu: GpuTimings,
    private mode: ScreenSpaceDiffuse, quality: ScreenSpaceQuality,
  ) {
    this.tier = SCAN_TIERS[quality];
    this.sample = new ShadingSample(gbuffer, this.gbufferUV);
    const weight = new SurfaceWeight(gbuffer, this.projection, this.projectionInverse, this.fullSize);
    this.surfaces = new ScreenSpaceInputPyramid(gbuffer, this.projectionInverse, this.fullSize, this.scanSize);
    this.bandPyramid = new BandPyramid(this.surfaces, weight, this.fullSize, this.scanSize);
    this.reconstruction = new CorrectionReconstruction(
      weight, this.surfaces, this.fullSize, this.scanSize, this.projection, this.upsampleAlphaOne,
    );
    this.qReconstruction = new QReconstruction(weight, this.surfaces, this.fullSize, this.scanSize);
    this.occlusionSurfaceStage = this.surfaces.scanStageOf(null);
    this.indirectSurfaceStage = this.surfaces.scanStageOf(
      this.whereResolved(this.gbufferUV, () => vec4(this.emittedRadiance(sun), 1)));
  }

  // 走査の解像度。rgb = 照り返しの源として面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。方式が遮蔽では 0。
  public get surfaceRadianceTexture(): THREE.Texture { return this.surfaces.radianceTexture; }

  // いまの段で補正を分ける帯の数。
  public get bandCount(): number { return this.tier.bandCount; }

  public get experimentOutputTarget(): THREE.RenderTarget {
    if (this.experiment === null) throw new Error('screen-space: no experiment is active');
    return this.output.target;
  }

  // 段ごとの代表の面。
  public get inputPyramid(): ScreenSpaceInputPyramid { return this.surfaces; }

  // 次の render から方式 mode で描く。
  public setMode(mode: ScreenSpaceDiffuse): void {
    this.mode = mode;
  }

  // 次の render から精細さ quality の段で走査する。
  public setQuality(quality: ScreenSpaceQuality): void {
    this.tier = SCAN_TIERS[quality];
  }

  // 次の render から段 tier で走査する。次に setQuality を呼ぶまで保つ。
  public setTier(tier: ScanTier): void {
    this.tier = tier;
  }

  // 次の render から、走査の全体の回転とブルーノイズのずれを (x, y) [タイルの幅] にする。
  public setSeed(x: number, y: number): void {
    this.seed.value.set(x, y);
  }

  // 次の render から、走査の 3 つのずれを、pass が null ならブルーノイズ(本番)から、整数ならパスの番号 pass のホワイト
  // ノイズ(画素・パス・成分ごとに独立)から引く。多くのパスを平均する道具のためのもの。
  public setWhiteNoisePass(pass: number | null): void {
    this.whiteNoisePass.value = pass ?? -1;
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
    for (const stage of this.experimentStages(this.experiment.variant, this.experiment.sparseTapCount)) {
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
  }

  // いまの方式と段の全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    const stages = this.currentStages();
    this.prepare(camera, width, height);
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
      ...[...this.stagesByBandCount.values()].flatMap((stages) => stages.own),
    ];
    for (const material of new Set(own.map(({ material }) => material))) material.dispose();
    for (const stages of this.experimentStagesByKey.values()) {
      for (const material of new Set(stages.map(({ material }) => material))) material.dispose();
    }
    for (const target of this.qTargets ?? []) target.dispose();
    this.surfaces.dispose();
    this.blueNoise.dispose();
  }

  // いまの方式と段の帯の数と段の範囲の描画命令の列。オフは空。
  private currentStages(): readonly ScreenSpaceStage[] {
    if (this.mode === SCREEN_SPACE_DIFFUSE.off) return [];
    if (this.experiment !== null) return this.experimentStages(this.experiment.variant, this.experiment.sparseTapCount);
    return this.stagesOf(this.tier.bandCount).ranges[this.stageRange][this.mode];
  }

  private experimentStages(variant: ScreenSpaceExperimentVariant, sparseTapCount: number): readonly ScreenSpaceStage[] {
    const cacheKey = `${variant}:${this.tier.bandCount}:${sparseTapCount}`;
    const cached = this.experimentStagesByKey.get(cacheKey);
    if (cached !== undefined) return cached;
    const count = this.tier.bandCount;
    if (variant === 'raw-full') {
      const stages = [this.indirectSurfaceStage,
        this.createScanStage(1, this.surfaces.radianceTexture, this.output.target, true)];
      this.experimentStagesByKey.set(cacheKey, stages);
      return stages;
    }
    const scan = this.stagesOf(count).ranges.scan[SCREEN_SPACE_DIFFUSE.indirect];
    if (variant === 'band') return this.stagesOf(count).ranges.all[SCREEN_SPACE_DIFFUSE.indirect];
    if (variant === 'raw-quarter') {
      const stages = [...scan, this.createStochasticUpsampleStage(this.output.bandTarget(count, 0).textures[0]!)];
      this.experimentStagesByKey.set(cacheKey, stages);
      return stages;
    }
    const [first, second, denoised] = this.qTargetsOf();
    const firstRotation = this.blueNoise.atScreenPixel(this.seed.add(36 / 64));
    const secondRotation = this.blueNoise.atScreenPixel(this.seed.add(61 / 64));
    const stages = [
      ...scan,
      this.createDenoiseStage(first!,
        () => this.qReconstruction.sparseDenoised(this.output.bandTarget(count, 0).textures[0]!, firstRotation, sparseTapCount)),
      this.createDenoiseStage(second!,
        () => this.qReconstruction.sparseDenoised(first!.texture, secondRotation, sparseTapCount)),
      this.createDenoiseStage(denoised!, () => this.qReconstruction.denseDenoised(second!.texture)),
      this.createStochasticUpsampleStage(denoised!.texture),
    ];
    this.experimentStagesByKey.set(cacheKey, stages);
    return stages;
  }

  // 帯の数 count の描画命令。初めて引いたときに組み、以後は同じものを返す。
  private stagesOf(count: number): BandCountStages {
    const built = this.stagesByBandCount.get(count);
    if (built !== undefined) return built;
    const occlusionScan = this.createScanStage(count, null);
    const indirectScan = this.createScanStage(count, this.surfaces.radianceTexture);
    // 走査より後の段は方式によらないので、両方の方式で同じ描画命令を使う。
    const chain = this.createChainStages(count);
    const upsample = this.createUpsampleStage(count);
    const scans: ModeStages = {
      [SCREEN_SPACE_DIFFUSE.occlusion]: [this.occlusionSurfaceStage, occlusionScan],
      [SCREEN_SPACE_DIFFUSE.indirect]: [this.indirectSurfaceStage, indirectScan],
    };
    const afterScan = [...this.surfaces.stagesUpTo(count), ...chain, upsample];
    const stages: BandCountStages = {
      ranges: {
        all: {
          [SCREEN_SPACE_DIFFUSE.occlusion]: [...scans[SCREEN_SPACE_DIFFUSE.occlusion], ...afterScan],
          [SCREEN_SPACE_DIFFUSE.indirect]: [...scans[SCREEN_SPACE_DIFFUSE.indirect], ...afterScan],
        },
        scan: scans,
        chain: { [SCREEN_SPACE_DIFFUSE.occlusion]: afterScan, [SCREEN_SPACE_DIFFUSE.indirect]: afterScan },
      },
      own: [occlusionScan, indirectScan, ...chain, upsample],
    };
    this.stagesByBandCount.set(count, stages);
    return stages;
  }

  // 受け手へ届く遠方の拡散光のうち塞がれた照度と照り返しの差を、帯の数 count の帯ごとに求めて詰めて書く、走査の
  // 描画命令を組む。radiance は照り返しの源の放射輝度で、null なら照り返しを集めない。
  private createScanStage(
    count: number, radiance: THREE.Texture | null, target = this.output.bandTarget(count, 0), directCorrection = false,
  ): ScreenSpaceStage {
    // 丸めのずれのタイルのずれ 27/64 は、歩みのずれ(½)と画素ごとに相関しないものを実測で選んだ。
    const whiteAt = (component: number): FloatNode => whiteNoiseAt(this.scanPixel, uint(this.whiteNoisePass), component);
    const useBlue = this.whiteNoisePass.lessThan(0);
    const noise = vec3(
      select(useBlue, stratifiedRotation(this.scanPixel, this.seed.x), whiteAt(0)),
      select(useBlue, this.blueNoise.atScreenPixel(this.seed.add(0.5)), whiteAt(1)),
      select(useBlue, this.blueNoise.atScreenPixel(this.seed.add(27 / 64)), whiteAt(2)),
    );
    const planets: readonly PlanetIllumination[] = Array.from({ length: MAX_PLANET_LIGHT_SLOTS }, (_, slot) => ({
      cap: this.planetLight.capAt(this.sample, slot),
      irradiance: this.planetLight.diffuseIrradianceAtSlot(this.sample, slot),
    }));
    const material = multiOutputMaterial(target, () => {
      const corrections = scanHemisphere(
        this.surfaces, this.fullSize, this.projection, this.projectionInverse, this.sliceCount, this.stepCount, noise,
        this.ambient.irradiance(this.sample), planets, radiance,
        {
          count, bounceScale: this.bounceBandScale, bounce: this.bounceStrengths,
          occlusionScale: this.bandScale, occlusion: this.occlusionStrengths,
        },
      );
      return directCorrection ? [vec4(corrections[0]!, float(1))] : packedBands(corrections);
    });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseScan };
  }

  // 帯の数 count の、帯の縮小(段 1..count − 1)→ 拡大と合流(段 count − 2..0)の描画命令の列。
  private createChainStages(count: number): ScreenSpaceStage[] {
    const reduce = Array.from({ length: count - 1 }, (_, index): ScreenSpaceStage => {
      const level = index + 1;
      const target = this.output.bandTarget(count, level);
      const finer = this.output.bandTarget(count, level - 1).textures;
      const material = multiOutputMaterial(target, () => this.bandPyramid.reduced(finer, count, level));
      return { material, target, gpuPass: GPU_PASS.nearbyDiffuseBandReduce };
    });
    const merge = Array.from({ length: count - 1 }, (_, index): ScreenSpaceStage => {
      const level = count - 2 - index;
      const target = this.output.mergedTarget(count, level);
      const coarse = this.output.mergedTexture(count, level + 1);
      const coarseBands = this.output.bandTarget(count, level + 1).textures;
      const own = this.output.bandTarget(count, level).textures;
      const value = (): Vec4Node => this.bandPyramid.merged(coarse, coarseBands, own, count, level);
      // 段 0 の受け手は走査の受け手なので、走査と同じく補正を受けない受け手を 0 で塗る。
      const material = stageMaterial();
      material.mrtNode = mrt({
        [target.texture.name]: level === 0 ? this.whereResolved(this.gbufferUV, value) : Fn(value)(),
      });
      return { material, target, gpuPass: GPU_PASS.nearbyDiffuseMerge };
    });
    return [...reduce, ...merge];
  }

  // 帯の数 count の、走査の解像度の最後の拡大の前の補正を、描画バッファの解像度へ疎なタップで拡大する描画命令を組む。
  // 拡大は描画バッファの解像度の受け手で、補正を受けるかを測り直す。
  private createUpsampleStage(count: number): ScreenSpaceStage {
    const source = this.output.mergedTexture(count, 0);
    const rotation = this.blueNoise.atScreenPixel(this.seed.add(UPSAMPLE_ROTATION_SHIFT));
    const upsample = stageMaterial();
    upsample.mrtNode = mrt({ diffuseCorrection: this.whereResolved(screenUV,
      () => vec4(this.reconstruction.sparseUpsampled(source, rotation), 1)) });
    return { material: upsample, target: this.output.target, gpuPass: GPU_PASS.nearbyDiffuseUpsample };
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
    material.mrtNode = mrt({ diffuseCorrection: this.whereResolved(screenUV,
      () => vec4(this.qReconstruction.stochasticUpsampled(source, choice), 1)) });
    return { material, target: this.output.target, gpuPass: GPU_PASS.nearbyDiffuseUpsample };
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

  // 走査の画素が表す面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)— 太陽 sun の直射・天体照・環境光を拡散で
  // 返す光と、自己発光。天体照と環境光は、その面の空が遮られないとしたときの照度で引く(その面自身の
  // 遮られ方はこのパスの出力そのものなので、1 パスの中では求まらない)。一様でない分岐の中から呼んでよい。
  private emittedRadiance(sun: SunSource): Vec3Node {
    // G バッファは段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない分岐の中では組めない。
    // G バッファの段は 1 つだけ。
    const material = texture(this.gbuffer.basecolorTexture, this.sample.uv).level(float(0));
    const albedo = material.rgb.mul(material.a.oneMinus());
    const irradiance = sun.pointIrradiance(this.sample)
      .add(this.planetLight.diffuseIrradiance(this.sample))
      .add(this.ambient.irradiance(this.sample));
    return albedo.div(Math.PI).mul(irradiance)
      .add(texture(this.gbuffer.emissiveTexture, this.sample.uv).level(float(0)).rgb);
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
    const factors = tier.bandFactors;
    this.bounceBandScale.value = factors?.bounceScale ?? tier.bandScale;
    this.bounceStrengths.senderFacing.value = factors?.bounce?.senderFacing ?? 0;
    this.bounceStrengths.receiverFacing.value = factors?.bounce?.receiverFacing ?? 0;
    this.bounceStrengths.receiverView.value = factors?.bounce?.receiverView ?? 0;
    this.occlusionStrengths.receiverFacing.value = factors?.occlusion?.receiverFacing ?? 0;
    this.occlusionStrengths.receiverView.value = factors?.occlusion?.receiverView ?? 0;
    const scanWidth = Math.max(1, Math.ceil(width * tier.scale));
    const scanHeight = Math.max(1, Math.ceil(height * tier.scale));
    this.surfaces.setSize(scanWidth, scanHeight);
    const levelSizes = Array.from({ length: tier.bandCount }, (_, level) =>
      [levelExtent(scanWidth, level), levelExtent(scanHeight, level)] as const);
    this.output.setSize(tier.bandCount, levelSizes, width, height);
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
