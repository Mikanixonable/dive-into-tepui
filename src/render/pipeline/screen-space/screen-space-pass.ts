// 遮蔽と照り返しのパス。G バッファの深度と法線から、画素ごとに近くの構造がどれだけ・どの向きに空を
// 塞いでいるかと、照り返しを描く方式では塞いでいる面が返す光を求め、全解像度の可視率と照り返しの
// テクスチャへ書く。描画設定の方式と精細さを受け、方式がオフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, abs, clamp, float, floor, max, mrt, normalize, screenSize, screenUV, select, struct, texture, uniform, vec2,
  vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { BlueNoise } from '../../blue-noise';
import { octDecodeNormal, type GBufferPass } from '../gbuffer';
import { ShadingSample } from '../lighting/shading-sample';
import { viewPositionAt } from '../view-ray';
import { compileInto } from '../compile-into';
import { scanHemisphere, type HemisphereScan, type SurfaceRadiance } from './hemisphere-scan';
import { encodeVisibility } from './environment-occlusion';
import type { SunSource } from '../lighting/sun-source';
import type { Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node } from '../../tsl-types';

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
  [SCREEN_SPACE_QUALITY.medium]: { scale: 0.5, sliceCount: 3, stepCount: 4 },
  [SCREEN_SPACE_QUALITY.high]: { scale: 1, sliceCount: 3, stepCount: 6 },
};

// 均しで隣の重みが 0 に落ちる、中心との view 深度の相対差。
const EDGE_DEPTH_TOLERANCE = 0.05;

// 前処理より後の段が書く 1 画素 — 遮蔽と照り返し。描画先の同名の 2 枚へ stageOutput で書く。
const STAGE_TEXEL = struct({ occlusion: 'vec4', indirect: 'vec4' }, 'ScreenSpaceTexel');

// 描画命令 1 本: material を全画面に描いて target へ書く。
interface Stage {
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly target: THREE.RenderTarget;
}

// 走査の解像度の面。textures は素の深度(r32float)、法線(oct 符号化、rg16float)、面が放つ放射輝度
// (rgba16float)の順。
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

// 前処理より後の段の描画先。textures[0] が遮蔽、textures[1] が照り返し(どちらも rgba16float)。どの段も画素
// ちょうどで読むので、補間しない。
function createTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 名前は STAGE_TEXEL の成員と結び付く。
  const [occlusion, indirect] = target.textures;
  occlusion!.name = 'occlusion';
  indirect!.name = 'indirect';
  return target;
}

// 全画面で書くマテリアル。出力は呼び出し側が mrtNode へ置く。**合成を切る** — α に載せた値をそのまま書き、
// 32 bit 浮動小数点の添付は合成できない。
function stageMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
}

// Fn が返した STAGE_TEXEL の 2 つの値を、描画先の 2 枚へ書く出力。**2 つの値は 1 つの Fn から構造体で返す** —
// 別々の Fn で組むと、走査や均しを値ごとに回すことになる。
function stageOutput(texel: THREE.Node): ReturnType<typeof mrt> {
  return mrt({ occlusion: texel.get('occlusion'), indirect: texel.get('indirect') });
}

// 走査の結果(occlusion は rgb = 曲げた法線 × 0.5 + 0.5、a = 可視率。indirect は rgb = 照り返し)を 3×3 で均し、
// STAGE_TEXEL で返す。indirect が null なら照り返しは 0 とする。重みは 1-2-1 の二項係数に、中心との view 深度の
// 相対差で 0 へ落ちる係数を掛ける — 深度の段差を跨いで、手前の遮りを奥へ滲ませない。depth は走査の解像度の
// 素の深度。
function denoised(
  occlusion: THREE.Texture, indirect: THREE.Texture | null, depth: THREE.Texture, projectionInverse: Mat4Uniform,
): THREE.Node {
  return Fn(() => {
    const texel = vec2(1).div(screenSize);
    const centerDepth = viewPositionAt(depth, projectionInverse).z.toVar();
    const occlusionSum = vec4(0).toVar();
    const indirectSum = vec4(0).toVar();
    const weightSum = float(0).toVar();
    // 中心は深度の差が 0 なので、重みの和は 0 にならない。
    for (const dy of [-1, 0, 1]) {
      for (const dx of [-1, 0, 1]) {
        const uv = screenUV.add(vec2(dx, dy).mul(texel));
        const gap = abs(viewPositionAt(depth, projectionInverse, uv).z.sub(centerDepth))
          .div(max(abs(centerDepth), 1e-6));
        const weight = clamp(float(1).sub(gap.div(EDGE_DEPTH_TOLERANCE)), 0, 1)
          .mul((2 - Math.abs(dx)) * (2 - Math.abs(dy)));
        occlusionSum.addAssign(texture(occlusion, uv).mul(weight));
        if (indirect !== null) indirectSum.addAssign(texture(indirect, uv).mul(weight));
        weightSum.addAssign(weight);
      }
    }
    return STAGE_TEXEL(occlusionSum.div(weightSum), indirectSum.div(weightSum));
  })();
}

export class ScreenSpacePass {
  // 走査の解像度の面、走査と均しを往復する 2 組、全解像度の可視率と照り返し。
  private readonly surfaceTarget = createSurfaceTarget();
  private readonly scanTarget = createTarget();
  private readonly blurTarget = createTarget();
  private readonly outputTarget = createTarget();
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
  // 前処理で描いている画素に当たる、G バッファの全解像度の画素の中心の uv。**G バッファは画素の中心で読む** —
  // 画素の角で補間すると、輪郭で虚空の値が混ざり、面が自分自身を遮る。
  private readonly gbufferUV: Vec2Node = floor(screenUV.mul(this.fullSize)).add(0.5).div(this.fullSize);
  // 前処理で、遮る面が受ける太陽の直射を引くシェーディング入力。
  private readonly sample: ShadingSample;
  private readonly blueNoise = new BlueNoise();
  // 直前のフレームで出力を書いたか。方式がオフへ切り替わったあと 1 度だけ空へ戻すために持つ。
  private drawn = false;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // sun は照り返しの光源になる面が受ける直射を引く太陽。mode / quality は構築時点の描画設定
  // screenSpaceDiffuse / screenSpaceQuality の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, sun: SunSource, private readonly gpu: GpuTimings,
    private mode: ScreenSpaceDiffuse, private quality: ScreenSpaceQuality,
  ) {
    this.sample = new ShadingSample(gbuffer, this.gbufferUV);
    this.stages = {
      [SCREEN_SPACE_DIFFUSE.off]: [],
      [SCREEN_SPACE_DIFFUSE.occlusion]: this.createStages(gbuffer, null),
      [SCREEN_SPACE_DIFFUSE.indirect]: this.createStages(gbuffer, sun),
    };
  }

  // 全解像度。rg = 曲げた法線(view 空間、oct 符号化)、b = 余弦重みの可視率 V、a = 相互反射の持ち上げ g。
  // 符号化の正本は environment-occlusion.ts。方式がオフのフレームは V = 0 の空。
  public get visibilityTexture(): THREE.Texture { return this.outputTarget.textures[0]!; }

  // 全解像度。rgb = 照り返しの放射照度(SUN_IRRADIANCE_1AU の目盛り)。照り返しを集めないフレームは 0。
  public get indirectTexture(): THREE.Texture { return this.outputTarget.textures[1]!; }

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
    for (const { material, target } of this.stages[this.mode]) {
      this.renderer.setRenderTarget(target);
      this.quad.material = material;
      this.gpu.beginPass(GPU_PASS.screenSpace);
      this.quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(null);
    this.drawn = true;
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
    for (const target of [this.surfaceTarget, this.scanTarget, this.blurTarget, this.outputTarget]) {
      target.dispose();
    }
    for (const stages of Object.values(this.stages)) {
      for (const { material } of stages) material.dispose();
    }
    this.blueNoise.dispose();
  }

  // 前処理 → 走査 → 均し 2 回 → 拡大の描画命令を組む。sun が null なら照り返しを集めず、照り返しの出力は 0。
  private createStages(gbuffer: GBufferPass, sun: SunSource | null): readonly Stage[] {
    const [surfaceDepth, surfaceNormal, surfaceRadiance] = this.surfaceTarget.textures;
    const [scanOcclusion, scanIndirect] = this.scanTarget.textures;
    const [blurOcclusion, blurIndirect] = this.blurTarget.textures;

    // 前処理: 走査の画素ごとに、G バッファの深度と法線と、面が放つ放射輝度を同じ全解像度の画素から写す。
    const prepass = stageMaterial();
    prepass.mrtNode = mrt({
      surfaceDepth: texture(gbuffer.depthTexture, this.gbufferUV).r,
      surfaceNormal: texture(gbuffer.normalTexture, this.gbufferUV).rg,
      surfaceRadiance: vec4(sun === null ? vec3(0) : this.emittedRadiance(gbuffer, sun), 1),
    });
    // 走査: 遮蔽は rgb = 曲げた法線 × 0.5 + 0.5、a = 可視率。照り返しは rgb = 放射照度。
    const source: SurfaceRadiance | null = sun === null ? null : {
      radianceAt: (uv) => texture(surfaceRadiance!, uv).rgb,
      normalAt: (uv) => octDecodeNormal(texture(surfaceNormal!, uv).rg),
    };
    const scan = stageMaterial();
    const noise = vec2(this.blueNoise.atScreenPixel(), this.blueNoise.atScreenPixel(0.5));
    scan.mrtNode = stageOutput(Fn(() => {
      const result = scanHemisphere(
        surfaceDepth!, surfaceNormal!, this.projection, this.projectionInverse, this.sliceCount, this.stepCount, noise,
        source,
      );
      // three の NodeMaterial は色の出力を 0 以上へ切るので、符号つきの法線はそのまま書くと負の成分を失う。
      return STAGE_TEXEL(vec4(result.bentNormal.mul(0.5).add(0.5), result.visibility), vec4(result.indirect, 1));
    })());
    // 均しは走査と均しの 2 組を往復し、走査の組へ戻す。
    const blurred = stageMaterial();
    blurred.mrtNode = stageOutput(
      denoised(scanOcclusion!, sun === null ? null : scanIndirect!, surfaceDepth!, this.projectionInverse),
    );
    const reblurred = stageMaterial();
    reblurred.mrtNode = stageOutput(
      denoised(blurOcclusion!, sun === null ? null : blurIndirect!, surfaceDepth!, this.projectionInverse),
    );
    const upsampled = stageMaterial();
    upsampled.mrtNode = stageOutput(
      this.upsampled(gbuffer, surfaceDepth!, scanOcclusion!, sun === null ? null : scanIndirect!),
    );
    return [
      { material: prepass, target: this.surfaceTarget },
      { material: scan, target: this.scanTarget },
      { material: blurred, target: this.blurTarget },
      { material: reblurred, target: this.scanTarget },
      { material: upsampled, target: this.outputTarget },
    ];
  }

  // 前処理の画素に写っている面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)— 太陽の直射を拡散で返す光と、
  // 自己発光。
  private emittedRadiance(gbuffer: GBufferPass, sun: SunSource): Vec3Node {
    const material = texture(gbuffer.basecolorTexture, this.sample.uv);
    const albedo = material.rgb.mul(material.a.oneMinus());
    return albedo.div(Math.PI).mul(sun.pointIrradiance(this.sample))
      .add(texture(gbuffer.emissiveTexture, this.sample.uv).rgb);
  }

  // 全解像度の画素ごとに、近い 2×2 の走査の画素のうち view 深度が最も近いものの結果を採り、STAGE_TEXEL で返す。
  // 遮蔽はアルベドと一緒に可視率テクスチャの詰め方で詰める。面の写っていない画素は遮られず、照り返しを受けない
  // とする。surfaceDepth は走査の解像度の素の深度、occlusion / indirect は走査の解像度の遮蔽と照り返しで、
  // indirect が null なら照り返しは 0。
  private upsampled(
    gbuffer: GBufferPass, surfaceDepth: THREE.Texture, occlusion: THREE.Texture, indirect: THREE.Texture | null,
  ): THREE.Node {
    return Fn(() => {
      // 近い 2×2 の走査の画素から、view 深度の差が最も小さいものを採る。
      const depth = viewPositionAt(gbuffer.depthTexture, this.projectionInverse).z.toVar();
      const base = floor(screenUV.mul(this.scanSize).sub(0.5)).toVar();
      // 走査の段と同じ詰め方(rgb = 曲げた法線 × 0.5 + 0.5)。初期値は視点を向いた遮りの無い画素。
      const picked = vec4(0.5, 0.5, 1, 1).toVar();
      const pickedIndirect = vec4(0).toVar();
      const pickedGap = float(1e30).toVar();
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const texel = clamp(base.add(vec2(dx, dy)), vec2(0), this.scanSize.sub(1));
        const uv = texel.add(0.5).div(this.scanSize);
        const gap = abs(viewPositionAt(surfaceDepth, this.projectionInverse, uv).z.sub(depth));
        If(gap.lessThan(pickedGap), () => {
          pickedGap.assign(gap);
          picked.assign(texture(occlusion, uv));
          if (indirect !== null) pickedIndirect.assign(texture(indirect, uv));
        });
      }
      // 遮蔽は受け手のアルベド(拡散の色)と一緒に詰める。
      const covered = gbuffer.covered();
      const scan: HemisphereScan = {
        visibility: select(covered, picked.w, float(1)),
        bentNormal: normalize(picked.xyz.mul(2).sub(1)),
        indirect: select(covered, pickedIndirect.rgb, vec3(0)),
      };
      const material = texture(gbuffer.basecolorTexture, screenUV);
      return STAGE_TEXEL(encodeVisibility(scan, material.rgb.mul(material.a.oneMinus())), vec4(scan.indirect, 1));
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
    if (this.outputTarget.width !== width || this.outputTarget.height !== height) {
      this.outputTarget.setSize(width, height);
    }
    this.fullSize.value.set(width, height);
    this.scanSize.value.set(scanWidth, scanHeight);
    // 実カメラの行列。
    this.projection.value.copy(camera.projectionMatrix);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.sample.sync(camera);
  }

  // 方式がオフのフレームに render の代わりに走る。**オフへ切り替わった最初の 1 フレームだけ**可視率と照り返しを
  // 空へ戻す — 残すと、デバッグ表示に切る直前の像が凍ったまま出る。
  private clearOutput(): void {
    if (!this.drawn) return;
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.outputTarget);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
    this.drawn = false;
  }
}
