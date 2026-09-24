// 遮蔽と照り返しのパス。G バッファの深度と法線から、画素ごとに近くの構造が環境光ごとの向きの範囲を
// どれだけ塞いでいるかと、照り返しを描く方式では塞いでいる面が返す光を求め、符号付き拡散照度補正へ
// 書く。描画設定の方式と精細さを受け、方式がオフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, abs, clamp, float, floor, getViewPosition, ivec2, log, max, mrt, screenSize, screenUV, select, struct,
  texture, textureLoad, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuPassId, type GpuTimings } from '../../gpu-timings';
import { BlueNoise } from '../../blue-noise';
import { ShadingSample } from '../lighting/shading-sample';
import { compileInto } from '../compile-into';
import { gbufferUVOf, scanHemisphere, type Cap } from './hemisphere-scan';
import { signedDiffuseCorrection, type DiffuseCorrection } from './diffuse-correction';
import type { GBufferPass } from '../gbuffer';
import type { AmbientSource } from '../lighting/ambient-source';
import type { PlanetLightSource } from '../lighting/planet-light-source';
import type { SunSource } from '../lighting/sun-source';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node } from '../../tsl-types';

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

// 均しで隣の重みが 0 に落ちる、中心との奥行きの鍵の差(view 深度の相対差にほぼ等しい)。
const EDGE_DEPTH_TOLERANCE = 0.05;
const MIN_EXTENT = 1e-3;
// 面の写っていない画素の奥行きの鍵。どの面の鍵とも離れた、rgba16float に収まる値。
const VOID_DEPTH_KEY = 60000;
// 均しの 1 軸の、隣の画素のずれ [px] と二項係数の組。
const DENOISE_TAPS = [[-1, 1], [0, 2], [1, 1]] as const;

// 走査と均しが書く 1 画素 — 塞がれた測度・数える範囲の測度と奥行きの鍵(w)・照り返しの放射照度。
// 描画先の同名の 3 枚へ stageOutput で書く。
const STAGE_TEXEL = struct({ occluded: 'vec4', extent: 'vec4', indirect: 'vec4' }, 'ScreenSpaceTexel');

// 描画命令 1 本: material を全画面に描いて target へ書く。
interface Stage {
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly target: THREE.RenderTarget;
  readonly gpuPass: GpuPassId;
}

// 走査の解像度の面。走査の画素が表す G バッファの画素の値を持ち、textures は素の深度(r32float)、法線(oct
// 符号化、rg16float)、面が放つ放射輝度(rgba16float)の順。走査は標本ごとにこれを読む — G バッファの深度を
// 直に読むより速い。
function createSurfaceTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 3, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 名前は前処理の MRT の出力と結び付く。深度は 16 bit に落とすと、遠くの平らな面が自分を遮る。
  const [depth, normal, radiance] = target.textures;
  depth!.name = 'surfaceDepth';
  depth!.format = THREE.RedFormat;
  depth!.type = THREE.FloatType;
  normal!.name = 'surfaceNormal';
  normal!.format = THREE.RGFormat;
  normal!.type = THREE.HalfFloatType;
  radiance!.name = 'surfaceRadiance';
  radiance!.format = THREE.RGBAFormat;
  radiance!.type = THREE.HalfFloatType;
  return target;
}

// 走査と均しの描画先。textures は STAGE_TEXEL の成員の順(どれも rgba16float)。
function createScanTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 3, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const [occluded, extent, indirect] = target.textures;
  occluded!.name = 'occluded';
  extent!.name = 'extent';
  indirect!.name = 'indirect';
  return target;
}

// 全画面で書くマテリアル。出力は呼び出し側が mrtNode へ置く。**合成を切る** — α に載せた値をそのまま書く。
function stageMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
}

// Fn が返した STAGE_TEXEL の 3 つの値を、走査と均しの描画先の 3 枚へ書く出力。**値は 1 つの Fn から構造体で
// 返す** — 別々の Fn で組むと、走査や均しを値ごとに回すことになる。
function stageOutput(texel: THREE.Node): ReturnType<typeof mrt> {
  return mrt({
    occluded: texel.get('occluded'), extent: texel.get('extent'), indirect: texel.get('indirect'),
  });
}

// view 深度 viewDepth [m] を、均しと拡大が奥行きの比を差で比べられる鍵にする。covered が偽(面の写っていない
// 画素)なら VOID_DEPTH_KEY。
function depthKey(covered: BoolNode, viewDepth: FloatNode): FloatNode {
  return select(covered, log(viewDepth), float(VOID_DEPTH_KEY));
}

// 走査の解像度の塞がれた測度 occluded・範囲の測度 extent・照り返し indirect を 3×3 で均し、STAGE_TEXEL で
// 返す。indirect が null なら照り返しは 0。重みは 1-2-1 の二項係数に、中心との奥行きの鍵の差で 0 へ落ちる
// 係数を掛ける — 深度の段差を跨いで、手前の遮りを奥へ滲ませない。**分子(塞がれた測度)と分母(範囲の測度)は
// 同じ重みで別々に足す** — 画素ごとに割ってから均すと、細い範囲の塞がれ方が「遮られない」側へ偏る。
function denoised(occluded: THREE.Texture, extent: THREE.Texture, indirect: THREE.Texture | null): THREE.Node {
  return Fn(() => {
    const pixel = floor(screenUV.mul(screenSize)).toVar();
    const center = textureLoad(extent, ivec2(pixel)).toVar();
    const occludedSum = vec3(0).toVar();
    const extentSum = vec2(0).toVar();
    const indirectSum = vec3(0).toVar();
    const weightSum = float(0).toVar();
    // 中心は鍵の差が 0 なので、重みの和は 0 にならない。画面の外の隣は縁の画素で代える。
    for (const [dy, binomialY] of DENOISE_TAPS) {
      for (const [dx, binomialX] of DENOISE_TAPS) {
        const neighborPixel = ivec2(clamp(pixel.add(vec2(dx, dy)), vec2(0), screenSize.sub(1)));
        const neighborExtent = dx === 0 && dy === 0 ? center : textureLoad(extent, neighborPixel);
        const weight = clamp(float(1).sub(abs(neighborExtent.w.sub(center.w)).div(EDGE_DEPTH_TOLERANCE)), 0, 1)
          .mul(binomialX * binomialY);
        occludedSum.addAssign(textureLoad(occluded, neighborPixel).xyz.mul(weight));
        extentSum.addAssign(neighborExtent.xy.mul(weight));
        if (indirect !== null) indirectSum.addAssign(textureLoad(indirect, neighborPixel).rgb.mul(weight));
        weightSum.addAssign(weight);
      }
    }
    return STAGE_TEXEL(
      vec4(occludedSum.div(weightSum), 0), vec4(extentSum.div(weightSum), 0, center.w),
      vec4(indirectSum.div(weightSum), 1),
    );
  })();
}

export class ScreenSpacePass {
  // 走査の解像度の面と、走査と均しを往復する 2 組。
  private readonly surfaceTarget = createSurfaceTarget();
  private readonly scanTarget = createScanTarget();
  private readonly blurTarget = createScanTarget();
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
  // 走査の解像度で描いている画素の整数座標と、その画素が表す G バッファの画素の中心の uv・整数座標。
  private readonly scanPixel: Vec2Node = floor(screenUV.mul(screenSize));
  private readonly gbufferUV: Vec2Node = gbufferUVOf(this.scanPixel, this.fullSize);
  private readonly gbufferPixel = ivec2(floor(this.gbufferUV.mul(this.fullSize)));
  // 走査の解像度の画素の、光の向きと面の向きを引くシェーディング入力。
  private readonly sample: ShadingSample;
  private readonly fullSample: ShadingSample;
  private readonly blueNoise = new BlueNoise();
  // オフのあいだ一度だけ中立値へ消したか。初回のオフでも未初期化の GPU メモリを読ませない。
  private outputCleared = false;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // sun / ambient は照り返しの光源になる面を照らす太陽と環境光、planetLight は塞がれ方を数える天体照の
  // 球冠の出どころであり、その面を照らす天体照でもある。output は結果の描画先。mode / quality は構築時点の
  // 描画設定 screenSpaceDiffuse / screenSpaceQuality の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, sun: SunSource, planetLight: PlanetLightSource,
    ambient: AmbientSource, private readonly output: DiffuseCorrection, private readonly gpu: GpuTimings,
    private mode: ScreenSpaceDiffuse, private quality: ScreenSpaceQuality,
  ) {
    this.sample = new ShadingSample(gbuffer, this.gbufferUV);
    this.fullSample = new ShadingSample(gbuffer, screenUV);
    this.stages = {
      [SCREEN_SPACE_DIFFUSE.off]: [],
      [SCREEN_SPACE_DIFFUSE.occlusion]: this.createStages(gbuffer, planetLight, ambient, null),
      [SCREEN_SPACE_DIFFUSE.indirect]: this.createStages(gbuffer, planetLight, ambient, sun),
    };
  }

  // 走査の解像度。rgb = 照り返しの源として面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)。照り返しを集めない
  // フレームは 0。
  public get surfaceRadianceTexture(): THREE.Texture { return this.surfaceTarget.textures[2]!; }

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
    if (this.mode === SCREEN_SPACE_DIFFUSE.off) {
      this.clearOutput();
      return;
    }
    this.prepare(camera, width, height);
    // 前処理 → 走査 → 均し 2 回 → 拡大の順に、段ごとの描画先へ書く。
    for (const { material, target, gpuPass } of this.stages[this.mode]) {
      this.renderer.setRenderTarget(target);
      this.quad.material = material;
      this.gpu.beginPass(gpuPass);
      this.quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(null);
    this.outputCleared = false;
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
    for (const target of [this.surfaceTarget, this.scanTarget, this.blurTarget]) {
      target.dispose();
    }
    for (const stages of Object.values(this.stages)) {
      for (const { material } of stages) material.dispose();
    }
    this.blueNoise.dispose();
  }

  // 前処理 → 走査 → 均し 2 回 → 拡大の描画命令を組む。sun が null なら照り返しを集めず、照り返しの出力は 0。
  private createStages(
    gbuffer: GBufferPass, planetLight: PlanetLightSource, ambient: AmbientSource, sun: SunSource | null,
  ): readonly Stage[] {
    const [surfaceDepth, surfaceNormal, surfaceRadiance] = this.surfaceTarget.textures;
    const [scanOccluded, scanExtent, scanIndirect] = this.scanTarget.textures;
    const [blurOccluded, blurExtent, blurIndirect] = this.blurTarget.textures;
    // 前処理: 走査の画素ごとに、その画素が表す G バッファの画素の深度と法線と、面が放つ放射輝度を写す。
    const prepass = stageMaterial();
    prepass.mrtNode = mrt({
      surfaceDepth: textureLoad(gbuffer.depthTexture, this.gbufferPixel).r,
      surfaceNormal: textureLoad(gbuffer.normalTexture, this.gbufferPixel).rg,
      surfaceRadiance: vec4(
        sun === null ? vec3(0) : this.emittedRadiance(gbuffer, sun, planetLight, ambient), 1),
    });
    // 走査: 塞がれた測度と、それを数えた範囲の測度と、照り返しの放射照度。
    const scan = stageMaterial();
    const noise = vec2(this.blueNoise.atScreenPixel(), this.blueNoise.atScreenPixel(0.5));
    const caps: readonly [Cap, Cap] = [planetLight.capAt(this.sample, 0), planetLight.capAt(this.sample, 1)];
    scan.mrtNode = stageOutput(Fn(() => {
      const result = scanHemisphere(
        surfaceDepth!, surfaceNormal!, this.fullSize, this.projection, this.projectionInverse,
        this.sliceCount, this.stepCount, noise, caps, sun === null ? null : surfaceRadiance!,
      );
      const depth = textureLoad(surfaceDepth!, ivec2(this.scanPixel)).r;
      const viewDepth = getViewPosition(this.gbufferUV, depth, this.projectionInverse).z.negate();
      const key = depthKey(depth.greaterThan(0), viewDepth);
      return STAGE_TEXEL(vec4(result.occluded, 0), vec4(result.extent, 0, key), vec4(result.indirect, 1));
    })());
    // 均しは走査と均しの 2 組を往復し、走査の組へ戻す。
    const blurred = stageMaterial();
    blurred.mrtNode = stageOutput(denoised(scanOccluded!, scanExtent!, sun === null ? null : scanIndirect!));
    const reblurred = stageMaterial();
    reblurred.mrtNode = stageOutput(denoised(blurOccluded!, blurExtent!, sun === null ? null : blurIndirect!));
    const upsampled = stageMaterial();
    upsampled.mrtNode = mrt({ diffuseCorrection: this.upsampled(
      gbuffer, planetLight, ambient, scanOccluded!, scanExtent!, sun === null ? null : scanIndirect!,
    ) });
    return [
      { material: prepass, target: this.surfaceTarget, gpuPass: GPU_PASS.bounceSource },
      { material: scan, target: this.scanTarget, gpuPass: GPU_PASS.nearbyDiffuseScan },
      { material: blurred, target: this.blurTarget, gpuPass: GPU_PASS.nearbyDiffuseReconstruct },
      { material: reblurred, target: this.scanTarget, gpuPass: GPU_PASS.nearbyDiffuseReconstruct },
      { material: upsampled, target: this.output.target, gpuPass: GPU_PASS.nearbyDiffuseReconstruct },
    ];
  }

  // 前処理の画素が表す面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)— 太陽の直射・天体照・環境光を
  // 拡散で返す光と、自己発光。天体照と環境光は、その面の空が遮られないとしたときの放射照度で引く
  // (その面自身の遮られ方はこのパスの出力そのものなので、1 パスの中では求まらない)。
  private emittedRadiance(
    gbuffer: GBufferPass, sun: SunSource, planetLight: PlanetLightSource, ambient: AmbientSource,
  ): Vec3Node {
    const material = texture(gbuffer.basecolorTexture, this.sample.uv);
    const albedo = material.rgb.mul(material.a.oneMinus());
    const irradiance = sun.pointIrradiance(this.sample)
      .add(planetLight.bounceSourceIrradiance(this.sample))
      .add(ambient.irradiance(this.sample));
    return albedo.div(Math.PI).mul(irradiance)
      .add(texture(gbuffer.emissiveTexture, this.sample.uv).rgb);
  }

  // 全解像度の画素ごとに、近い 2×2 の走査の画素の結果を、奥行きの鍵が近いものだけで双線形に混ぜ(どれも離れて
  // いれば最も近いものを採り)、遮られた拡散照度と照り返しの差を返す。面の写っていない画素は遮られず、
  // 照り返しを受けないとする。occluded / extent / indirect は走査の解像度の結果で、indirect が null なら
  // 照り返しは 0。
  private upsampled(
    gbuffer: GBufferPass, planetLight: PlanetLightSource, ambient: AmbientSource,
    occluded: THREE.Texture, extent: THREE.Texture, indirect: THREE.Texture | null,
  ): THREE.Node {
    return Fn(() => {
      const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
      const depth = textureLoad(gbuffer.depthTexture, pixel).r.toVar();
      const covered = depth.greaterThan(0);
      const key = depthKey(covered, getViewPosition(screenUV, depth, this.projectionInverse).z.negate()).toVar();
      // 双線形の重みに、奥行きの鍵の差で 0 へ落ちる係数を掛ける — 輪郭で手前の遮りを奥へ滲ませない。
      const position = screenUV.mul(this.scanSize).sub(0.5).toVar();
      const base = floor(position).toVar();
      const fraction = position.sub(base).toVar();
      const occludedSum = vec3(0).toVar();
      const extentSum = vec2(0).toVar();
      const indirectSum = vec3(0).toVar();
      const weightSum = float(0).toVar();
      const nearestOccluded = vec3(0).toVar();
      const nearestExtent = vec2(0).toVar();
      const nearestIndirect = vec3(0).toVar();
      const nearestGap = float(1e30).toVar();
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const texel = ivec2(clamp(base.add(vec2(dx, dy)), vec2(0), this.scanSize.sub(1))).toVar();
        const candidateOccluded = textureLoad(occluded, texel).xyz.toVar();
        const candidateExtent = textureLoad(extent, texel).toVar();
        const candidateIndirect = indirect === null ? vec3(0) : textureLoad(indirect, texel).rgb.toVar();
        const gap = abs(candidateExtent.w.sub(key)).toVar();
        const bilinear = (dx === 0 ? fraction.x.oneMinus() : fraction.x)
          .mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
        const weight = bilinear.mul(clamp(float(1).sub(gap.div(EDGE_DEPTH_TOLERANCE)), 0, 1)).toVar();
        occludedSum.addAssign(candidateOccluded.mul(weight));
        extentSum.addAssign(candidateExtent.xy.mul(weight));
        indirectSum.addAssign(candidateIndirect.mul(weight));
        weightSum.addAssign(weight);
        const nearer = gap.lessThan(nearestGap);
        nearestOccluded.assign(select(nearer, candidateOccluded, nearestOccluded));
        nearestExtent.assign(select(nearer, candidateExtent.xy, nearestExtent));
        nearestIndirect.assign(select(nearer, candidateIndirect, nearestIndirect));
        nearestGap.assign(select(nearer, gap, nearestGap));
      }
      const blended = weightSum.greaterThan(1e-3);
      const share = max(weightSum, 1e-3);
      const pickedOccluded = select(covered, select(blended, occludedSum.div(share), nearestOccluded), vec3(0));
      const pickedExtent = select(blended, extentSum.div(share), nearestExtent);
      const received = select(covered, select(blended, indirectSum.div(share), nearestIndirect), vec3(0));
      const ambientBlocked = clamp(pickedOccluded.x, 0, 1);
      const planetBlocked = (slot: number, component: FloatNode, range: FloatNode): Vec3Node => {
        const fraction = select(range.greaterThan(MIN_EXTENT),
          clamp(component.div(max(range, MIN_EXTENT)), 0, 1), float(0));
        return planetLight.diffuseIrradianceAtSlot(this.fullSample, slot).mul(fraction);
      };
      const blocked = ambient.irradiance(this.fullSample).mul(ambientBlocked)
        .add(planetBlocked(0, pickedOccluded.y, pickedExtent.x))
        .add(planetBlocked(1, pickedOccluded.z, pickedExtent.y));
      return vec4(signedDiffuseCorrection(received, blocked), 1);
    })();
  }

  // 描画先と標本数を精細さの段へ合わせ、深度から位置を復元する行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    const tier = SCAN_TIERS[this.quality];
    this.sliceCount.value = tier.sliceCount;
    this.stepCount.value = tier.stepCount;
    const scanWidth = Math.max(1, Math.ceil(width * tier.scale));
    const scanHeight = Math.max(1, Math.ceil(height * tier.scale));
    // 描画先の寸法は、変わったときだけ確保し直す。
    for (const target of [this.surfaceTarget, this.scanTarget, this.blurTarget]) {
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
    this.fullSample.sync(camera);
  }

  // 方式がオフのフレームに render の代わりに走る。**オフになった最初の 1 フレームだけ**結果と
  // 照り返しの源を空へ戻す — 残すと、デバッグ表示に切る直前の像が凍ったまま出る。
  private clearOutput(): void {
    if (this.outputCleared) return;
    // 消去色はレンダラーを共有する他のパスのものなので、退避して黒の透明で消し、戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    for (const target of [this.surfaceTarget, this.output.target]) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
    this.outputCleared = true;
  }
}
