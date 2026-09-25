// 遮蔽と照り返しのパス。G バッファの深度と法線から、画素ごとに近くの構造が遠方の拡散光(天体照と一様な
// 環境光)を塞いだ照度と、照り返しを描く方式では塞いでいる面が返す照度を求め、その差を符号付きの拡散照度
// 補正へ書く。描画設定の方式と精細さを受け、方式がオフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, float, floor, getViewPosition, ivec2, mrt, screenSize, screenUV, texture, textureLoad, uniform, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuPassId, type GpuTimings } from '../../gpu-timings';
import { BlueNoise } from '../../blue-noise';
import { ShadingSample } from '../lighting/shading-sample';
import { MAX_PLANET_LIGHT_SLOTS, type PlanetLightSource } from '../lighting/planet-light-source';
import { compileInto } from '../compile-into';
import {
  gbufferUVOf, projectedRadius, resolvesNearby, scanHemisphere, type PlanetIllumination,
} from './hemisphere-scan';
import { CorrectionReconstruction } from './correction-reconstruction';
import type { DiffuseCorrection } from './diffuse-correction';
import type { GBufferPass } from '../gbuffer';
import type { AmbientSource } from '../lighting/ambient-source';
import type { SunSource } from '../lighting/sun-source';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../../tsl-types';

// 描画設定「遮蔽と照り返し」の値。値は保存された設定を読む鍵なので、段を足しても既存の値は動かさない。
export const SCREEN_SPACE_DIFFUSE = { off: 0, occlusion: 1, indirect: 2 } as const;
type ScreenSpaceDiffuse = (typeof SCREEN_SPACE_DIFFUSE)[keyof typeof SCREEN_SPACE_DIFFUSE];

// 描画設定「遮蔽と照り返しの精細さ」の値。
export const SCREEN_SPACE_QUALITY = { low: 0, medium: 1, high: 2 } as const;
type ScreenSpaceQuality = (typeof SCREEN_SPACE_QUALITY)[keyof typeof SCREEN_SPACE_QUALITY];

// 精細さの段ごとの走査。scale は走査の解像度の描画バッファに対する比、sliceCount はスライスの数、
// stepCount は片側の歩数。
interface ScanTier {
  readonly scale: number;
  readonly sliceCount: number;
  readonly stepCount: number;
}
const SCAN_TIERS: Readonly<Record<ScreenSpaceQuality, ScanTier>> = {
  [SCREEN_SPACE_QUALITY.low]: { scale: 0.5, sliceCount: 2, stepCount: 3 },
  [SCREEN_SPACE_QUALITY.medium]: { scale: 0.5, sliceCount: 2, stepCount: 6 },
  [SCREEN_SPACE_QUALITY.high]: { scale: 1, sliceCount: 3, stepCount: 8 },
};

// 描画命令 1 本: material を全画面に描いて target へ書く。
interface Stage {
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly target: THREE.RenderTarget;
  readonly gpuPass: GpuPassId;
}

// 走査の解像度の描画先(rgba16float)。名前 name は MRT の出力と結び付く。
function createScanTarget(name: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  target.texture.name = name;
  return target;
}

// 全画面で書くマテリアル。出力は呼び出し側が mrtNode へ置く。**合成を切る** — 負の補正をそのまま書く。
function stageMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
}

export class ScreenSpacePass {
  // 照り返しの源と、復元の途中で均した補正の描画先。
  private readonly sourceTarget = createScanTarget('surfaceRadiance');
  private readonly denoisedTarget = createScanTarget('denoisedDiffuseCorrection');
  // 方式ごとの描画命令の列。オフは空。
  private readonly stages: Readonly<Record<ScreenSpaceDiffuse, readonly Stage[]>>;
  private readonly quad = new QuadMesh();
  // QuadMesh は固定直交カメラで描かれるため、実カメラの射影行列とその逆は毎フレーム自前で書き込む。
  private readonly projection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly sliceCount = uniform(1, 'int');
  private readonly stepCount = uniform(1, 'int');
  // 描画バッファと走査の解像度 [px]。解像度の違う段どうしで、対応する画素を引くのに使う。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly scanSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  // 走査の解像度で描いている画素の整数座標と、その画素が表す G バッファの画素の中心の uv。
  private readonly scanPixel: Vec2Node = floor(screenUV.mul(screenSize));
  private readonly gbufferUV: Vec2Node = gbufferUVOf(this.scanPixel, this.fullSize);
  // 走査の解像度の画素の、光の向きと面の向きを引くシェーディング入力。
  private readonly sample: ShadingSample;
  private readonly reconstruction: CorrectionReconstruction;
  private readonly blueNoise = new BlueNoise();
  // 直前に render した方式。null はまだ render していないこと。
  private renderedMode: ScreenSpaceDiffuse | null = null;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // sun / ambient は照り返しの源になる面を照らす太陽と環境光、planetLight は塞がれ方を数える天体照の
  // 球冠の出どころであり、その面を照らす天体照でもある。ambient と planetLight は受け手へ届く遠方の拡散光でも
  // ある。output は結果の描画先。mode / quality は構築時点の描画設定 screenSpaceDiffuse / screenSpaceQuality の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, sun: SunSource, planetLight: PlanetLightSource,
    ambient: AmbientSource, private readonly output: DiffuseCorrection, private readonly gpu: GpuTimings,
    private mode: ScreenSpaceDiffuse, private quality: ScreenSpaceQuality,
  ) {
    this.sample = new ShadingSample(gbuffer, this.gbufferUV);
    this.reconstruction = new CorrectionReconstruction(
      gbuffer, this.projection, this.projectionInverse, this.fullSize, this.scanSize);
    // 復元の段は方式によらないので、両方の方式で同じ描画命令を使う。
    const reconstruct = this.createReconstructStages(gbuffer);
    this.stages = {
      [SCREEN_SPACE_DIFFUSE.off]: [],
      [SCREEN_SPACE_DIFFUSE.occlusion]: [...this.createScanStages(gbuffer, planetLight, ambient, null), ...reconstruct],
      [SCREEN_SPACE_DIFFUSE.indirect]: [...this.createScanStages(gbuffer, planetLight, ambient, sun), ...reconstruct],
    };
  }

  // 走査の解像度。rgb = 照り返しの源として面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。方式が遮蔽では 0。
  public get surfaceRadianceTexture(): THREE.Texture { return this.sourceTarget.texture; }

  // 走査の解像度の、均した補正。rgb = ΔE_screen。
  public get denoisedCorrectionTexture(): THREE.Texture { return this.denoisedTarget.texture; }

  // 次の render から方式 mode で描く。
  public setMode(mode: ScreenSpaceDiffuse): void {
    this.mode = mode;
  }

  // 次の render から精細さ quality の解像度と標本数で走査する。
  public setQuality(quality: ScreenSpaceQuality): void {
    this.quality = quality;
  }

  // 1 フレームぶんを描く。G バッファと同じ寸法 width × height で、影パスの後・ライティングパスの前に呼ぶ。
  // camera は深度から位置を復元する行列を引き直すためだけに使う。
  public render(camera: THREE.Camera, width: number, height: number): void {
    if (this.mode !== this.renderedMode) this.clearUnwritten();
    this.renderedMode = this.mode;
    if (this.mode === SCREEN_SPACE_DIFFUSE.off) return;
    this.prepare(camera, width, height);
    // 照り返しの源 → 走査 → 均し → 拡大の順に、段ごとの描画先へ書く。
    for (const { material, target, gpuPass } of this.stages[this.mode]) {
      this.renderer.setRenderTarget(target);
      this.quad.material = material;
      this.gpu.beginPass(gpuPass);
      this.quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(null);
  }

  // いまの方式の全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    this.prepare(camera, width, height);
    for (const { material, target } of this.stages[this.mode]) {
      this.quad.material = material;
      await compileInto(this.renderer, target, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する単一の板
  // なので、ここでは解放しない。
  public dispose(): void {
    this.sourceTarget.dispose();
    this.denoisedTarget.dispose();
    const materials = new Set(Object.values(this.stages).flatMap((stages) => stages.map(({ material }) => material)));
    for (const material of materials) material.dispose();
    this.blueNoise.dispose();
  }

  // 照り返しの源 → 走査の描画命令を組む。sun があれば照り返しを集める方式として、照り返しの源の段を先頭に置く。
  private createScanStages(
    gbuffer: GBufferPass, planetLight: PlanetLightSource, ambient: AmbientSource, sun: SunSource | null,
  ): readonly Stage[] {
    const stages: Stage[] = [];
    if (sun !== null) {
      const source = stageMaterial();
      source.mrtNode = mrt({ surfaceRadiance: this.whereResolved(gbuffer, this.gbufferUV,
        () => this.emittedRadiance(gbuffer, sun, planetLight, ambient)) });
      stages.push({ material: source, target: this.sourceTarget, gpuPass: GPU_PASS.bounceSource });
    }
    // 走査: 受け手へ届く遠方の拡散光のうち塞がれた照度と照り返しの差。
    const scan = stageMaterial();
    const noise = vec3(
      this.blueNoise.atScreenPixel(), this.blueNoise.atScreenPixel(0.5), this.blueNoise.atScreenPixel(0.25));
    const planets: readonly PlanetIllumination[] = Array.from({ length: MAX_PLANET_LIGHT_SLOTS }, (_, slot) => ({
      cap: planetLight.capAt(this.sample, slot), irradiance: planetLight.diffuseIrradianceAtSlot(this.sample, slot),
    }));
    scan.mrtNode = mrt({ rawDiffuseCorrection: Fn(() => vec4(scanHemisphere(
      gbuffer.depthTexture, gbuffer.normalTexture, this.fullSize, this.projection, this.projectionInverse,
      this.sliceCount, this.stepCount, noise, ambient.irradiance(this.sample), planets,
      sun === null ? null : this.sourceTarget.texture,
    ), 1))() });
    stages.push({ material: scan, target: this.output.rawTarget, gpuPass: GPU_PASS.nearbyDiffuseScan });
    return stages;
  }

  // 走査の結果を描画バッファの解像度へ復元する、均し → 拡大の描画命令を組む。均しは走査の解像度、拡大は描画
  // バッファの解像度の受け手で、補正を受けるかを測り直す。
  private createReconstructStages(gbuffer: GBufferPass): readonly Stage[] {
    const denoise = stageMaterial();
    denoise.mrtNode = mrt({ denoisedDiffuseCorrection: this.whereResolved(gbuffer, this.gbufferUV,
      () => this.reconstruction.denoised(this.output.rawTexture)) });
    const upsample = stageMaterial();
    upsample.mrtNode = mrt({ diffuseCorrection: this.whereResolved(gbuffer, screenUV,
      () => this.reconstruction.upsampled(this.denoisedTarget.texture)) });
    return [
      { material: denoise, target: this.denoisedTarget, gpuPass: GPU_PASS.nearbyDiffuseReconstruct },
      { material: upsample, target: this.output.target, gpuPass: GPU_PASS.nearbyDiffuseReconstruct },
    ];
  }

  // 描いている画素を、uv(描いている画素に当たる G バッファの uv)の面が補正を受ける(resolvesNearbyAt)ときだけ
  // value で塗り、ほかは 0 で塗る出力。value は一様でない分岐の中で組むので、テクスチャは段を明示して読むこと。
  private whereResolved(gbuffer: GBufferPass, uv: Vec2Node, value: () => Vec3Node): Vec4Node {
    return Fn(() => {
      const result = vec3(0).toVar();
      const depth = textureLoad(gbuffer.depthTexture, ivec2(floor(uv.mul(this.fullSize)))).r.toVar();
      If(this.resolvesNearbyAt(depth, uv), () => {
        result.assign(value());
      });
      return vec4(result, 1);
    })();
  }

  // 走査の画素が表す面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)— 太陽の直射・天体照・環境光を拡散で
  // 返す光と、自己発光。天体照と環境光は、その面の空が遮られないとしたときの照度で引く(その面自身の
  // 遮られ方はこのパスの出力そのものなので、1 パスの中では求まらない)。一様でない分岐の中から呼んでよい。
  private emittedRadiance(
    gbuffer: GBufferPass, sun: SunSource, planetLight: PlanetLightSource, ambient: AmbientSource,
  ): Vec3Node {
    // G バッファは段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない分岐の中では組めない。
    // G バッファの段は 1 つだけ。
    const material = texture(gbuffer.basecolorTexture, this.sample.uv).level(float(0));
    const albedo = material.rgb.mul(material.a.oneMinus());
    const irradiance = sun.pointIrradiance(this.sample)
      .add(planetLight.diffuseIrradiance(this.sample))
      .add(ambient.irradiance(this.sample));
    return albedo.div(Math.PI).mul(irradiance)
      .add(texture(gbuffer.emissiveTexture, this.sample.uv).level(float(0)).rgb);
  }

  // uv の画素の素の深度 depth の受け手が補正を受けるか(resolvesNearby)。半径は、描いている解像度によらず走査の
  // 画素で測る。
  private resolvesNearbyAt(depth: FloatNode, uv: Vec2Node): BoolNode {
    const position = getViewPosition(uv, depth, this.projectionInverse);
    return resolvesNearby(depth, projectedRadius(position, this.projection, this.scanSize));
  }

  // 描画先と標本数を精細さの段へ合わせ、深度から位置を復元する行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    const tier = SCAN_TIERS[this.quality];
    this.sliceCount.value = tier.sliceCount;
    this.stepCount.value = tier.stepCount;
    const scanWidth = Math.max(1, Math.ceil(width * tier.scale));
    const scanHeight = Math.max(1, Math.ceil(height * tier.scale));
    // 描画先の寸法は、変わったときだけ確保し直す。
    for (const target of [this.sourceTarget, this.output.rawTarget, this.denoisedTarget]) {
      if (target.width !== scanWidth || target.height !== scanHeight) target.setSize(scanWidth, scanHeight);
    }
    if (this.output.target.width !== width || this.output.target.height !== height) {
      this.output.target.setSize(width, height);
    }
    this.fullSize.value.set(width, height);
    this.scanSize.value.set(scanWidth, scanHeight);
    // 実カメラの行列。
    this.projection.value.copy(camera.projectionMatrix);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.sample.sync(camera);
  }

  // いまの方式で前の像が残る描画先 — 遮蔽では照り返しの源、オフでは全部 — を空へ戻す。残すと、デバッグ表示に
  // 切る直前の像が凍ったまま出る。
  private clearUnwritten(): void {
    const unwritten = this.mode === SCREEN_SPACE_DIFFUSE.off
      ? [this.sourceTarget, this.output.rawTarget, this.denoisedTarget, this.output.target]
      : this.mode === SCREEN_SPACE_DIFFUSE.occlusion ? [this.sourceTarget] : [];
    if (unwritten.length === 0) return;
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
}
