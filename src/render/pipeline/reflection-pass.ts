// 映り込みのパス。G バッファの深度を追跡の解像度へ縮小し、滑らかな面の画素ごとに反射の向きの ray をその上で
// 進めて、当たった点の像をマテリアルパスの像の元から読み、置換の重みと一緒に映り込みの描画先
// (ScreenSpaceReflection)の均す前の側へ書き、それを粗さに応じて均した値を均した側へ書く。描画設定のオン / オフと
// 精細さを受け、オフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, clamp, float, floor, ivec2, max, min, mrt, screenSize, screenUV, select, struct, textureLoad, uniform,
  vec2, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { BlueNoise } from '../blue-noise';
import { ShadingSample } from './lighting/shading-sample';
import { ggxAlbedo } from './lighting/ltc';
import { createLtcTables } from './lighting/ltc-table.generated';
import { compileInto } from './compile-into';
import { reflectionRayOf, thicknessFarZ, traceReflection, viewZOf } from './screen-space/reflection-trace';
import { ReflectionDenoise } from './screen-space/reflection-denoise';
import { encodedRawReflection, type ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { GBufferPass } from './gbuffer';
import type { FloatNode, IntNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../tsl-types';

// 描画設定「映り込みの精細さ」の値。値は保存された設定を読む鍵なので、段を足しても既存の値は動かさない。
export const SCREEN_SPACE_SPECULAR_QUALITY = { low: 0, medium: 1, high: 2 } as const;
type ScreenSpaceSpecularQuality = (typeof SCREEN_SPACE_SPECULAR_QUALITY)[keyof typeof SCREEN_SPACE_SPECULAR_QUALITY];

// 精細さの段ごとの追跡。scale は追跡する深度の解像度の描画バッファに対する比で、1 / 整数(1/2 か 1)に限る —
// 深度の画素 1 つが描画バッファの画素の整数個四方を覆う前提で縮小と追跡が揃う。stepCount は ray 1 本の歩数。
interface TraceTier {
  readonly scale: number;
  readonly stepCount: number;
}
// TODO: 段の値は仮置き。追跡の費用と画を実測して決め直す。
const TRACE_TIERS: Readonly<Record<ScreenSpaceSpecularQuality, TraceTier>> = {
  [SCREEN_SPACE_SPECULAR_QUALITY.low]: { scale: 0.5, stepCount: 16 },
  [SCREEN_SPACE_SPECULAR_QUALITY.medium]: { scale: 0.5, stepCount: 32 },
  [SCREEN_SPACE_SPECULAR_QUALITY.high]: { scale: 1, stepCount: 48 },
};

// 画素 1 つぶんの追跡と像の結果。image は当たった点の像 I、distance は当たるまでの距離 [m]、weight は置換の重み w。
// 当たらなかった画素ではどれも 0。
const TracedReflection = struct({ image: 'vec3', distance: 'float', weight: 'float' }, 'TracedReflection');

// 全画面で書くマテリアル。出力は呼び出し側が mrtNode へ置く。
function stageMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
}

export class ReflectionPass {
  // 追跡の解像度の素の深度(逆 Z、虚空は 0)。32bit 浮動小数で持つので、読むのは textureLoad だけ。
  private readonly depthTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly downsampleMaterial = stageMaterial();
  private readonly traceMaterial = stageMaterial();
  private readonly denoise: ReflectionDenoise;
  private readonly quad = new QuadMesh();
  // G バッファの素の深度(逆 Z、虚空は 0)。
  private readonly depth: THREE.DepthTexture;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの射影行列とその逆、近クリップ距離は毎フレーム自前で書き込む。
  private readonly projection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly near = uniform(1);
  // 描画バッファの解像度 [px]、それを footprint で割った追跡する深度の画素を単位とする画面の寸法(割り切れなければ
  // 端の深度の画素は画面の外へはみ出す)、深度の画素 1 つが覆う描画バッファの画素の一辺の数、歩数。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly traceSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly footprint = uniform(1, 'int');
  // 描画バッファの画素 1 つの横の幅(x, y)。clip 座標の w を掛けると view 空間の長さ [m] になる。
  private readonly pixelSpan: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly stepCount = uniform(1, 'int');
  // 描画バッファの画素の、反射する面のシェーディング入力。
  private readonly sample: ShadingSample;
  private readonly blueNoise = new BlueNoise();
  // GGX のアルベドを引く係数表。
  private readonly ltcTables = createLtcTables();
  // 直前に render したときのオン / オフ。null はまだ render していないこと。
  private renderedEnabled: boolean | null = null;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // reflectionSource は当たった点の像を読む像の元(放射輝度、描画バッファの解像度)。output は映り込みの描画先。
  // enabled / quality は構築時点の描画設定 screenSpaceSpecular / screenSpaceSpecularQuality の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, reflectionSource: THREE.Texture,
    private readonly output: ScreenSpaceReflection, private readonly gpu: GpuTimings,
    private enabled: boolean, private quality: ScreenSpaceSpecularQuality,
  ) {
    this.depthTarget.texture.name = 'reflectionDepth';
    this.depth = gbuffer.depthTexture;
    this.sample = new ShadingSample(gbuffer);
    this.downsampleMaterial.mrtNode = mrt({ reflectionDepth: vec4(this.downsampledDepth(gbuffer), 0, 0, 1) });
    const traced = this.tracedReflection(gbuffer, reflectionSource);
    this.traceMaterial.mrtNode = encodedRawReflection(
      traced.get('image') as Vec3Node, traced.get('distance') as FloatNode, traced.get('weight') as FloatNode,
    );
    this.denoise = new ReflectionDenoise(renderer, gbuffer, output, gpu);
  }

  // uv(0..1)の画素の、追跡した素の深度(逆 Z、虚空は 0)。
  public depthAt(uv: Vec2Node): FloatNode {
    return textureLoad(this.depthTarget.texture, ivec2(floor(uv.mul(this.traceSize)))).r;
  }

  // 次の render からオン / オフを enabled にする。
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // 次の render から精細さ quality の解像度と歩数で追跡する。
  public setQuality(quality: ScreenSpaceSpecularQuality): void {
    this.quality = quality;
  }

  // 1 フレームぶんを描く。マテリアルパスの後に、G バッファと同じ寸法 width × height で呼ぶ。camera は深度から
  // 位置を復元する行列を引き直すためだけに使う。
  public render(camera: THREE.Camera, width: number, height: number): void {
    if (this.enabled !== this.renderedEnabled && !this.enabled) this.clearOutputs();
    this.renderedEnabled = this.enabled;
    if (!this.enabled) return;
    this.prepare(camera, width, height);
    // 深度の縮小 → 追跡と像 → 均しの順に書く。
    for (const [material, target] of this.stages()) {
      this.renderer.setRenderTarget(target);
      this.quad.material = material;
      this.gpu.beginPass(GPU_PASS.reflection);
      this.quad.render(this.renderer);
    }
    this.denoise.render(camera, width, height);
    this.renderer.setRenderTarget(null);
  }

  // オンなら全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    if (!this.enabled) return;
    this.prepare(camera, width, height);
    for (const [material, target] of this.stages()) {
      this.quad.material = material;
      await compileInto(this.renderer, target, this.quad, this.quad.camera);
    }
    await this.denoise.compile(camera, width, height);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する単一の板
  // なので、ここでは解放しない。
  public dispose(): void {
    this.depthTarget.dispose();
    this.downsampleMaterial.dispose();
    this.traceMaterial.dispose();
    this.denoise.dispose();
    this.blueNoise.dispose();
    this.ltcTables.ltc1.dispose();
    this.ltcTables.ltc2.dispose();
  }

  // 均すまでの描画命令の列。マテリアルとその描画先の組を、書く順に並べる。
  private stages(): readonly (readonly [THREE.MeshBasicNodeMaterial, THREE.RenderTarget])[] {
    return [[this.downsampleMaterial, this.depthTarget], [this.traceMaterial, this.output.rawTarget]];
  }

  // 追跡の解像度の画素が覆う G バッファの画素のうち、いちばん手前(逆 Z で最大)の素の深度。細い物体を縮小で
  // 落とさない。
  private downsampledDepth(gbuffer: GBufferPass): FloatNode {
    return Fn(() => {
      // 覆う範囲の左上の画素と、描画バッファの端の画素。左上は整数どうしの積で求める — 整数値の積は浮動小数でも
      // 厳密だが、除算は丸めで floor を 1 px 手前へずらし、追跡の画素と覆う範囲が食い違う。
      const footprint: IntNode = this.footprint;
      const base = floor(screenUV.mul(screenSize)).mul(float(footprint)).toVar();
      const last = this.fullSize.sub(1).toVar();
      const nearest = float(0).toVar();
      // 覆う範囲を footprint × footprint で走り、いちばん手前を採る。
      Loop({ start: 0, end: footprint, type: 'int', condition: '<' }, ({ i }) => {
        Loop({ start: 0, end: footprint, type: 'int', condition: '<' }, ({ i: j }) => {
          const texel = ivec2(min(base.add(vec2(float(i), float(j))), last));
          nearest.assign(max(nearest, textureLoad(gbuffer.depthTexture, texel).r));
        });
      });
      return nearest;
    })();
  }

  // 描画バッファの画素の追跡と像(TracedReflection)。面の写っていない画素と、当たらなかった画素はどれも 0。
  private tracedReflection(gbuffer: GBufferPass, reflectionSource: THREE.Texture): THREE.Node {
    return Fn(() => {
      const image = vec3(0).toVar();
      const distance = float(0).toVar();
      const weight = float(0).toVar();
      // 面の写っている画素だけを追跡する。
      If(gbuffer.covered(), () => {
        // 鏡面ローブから向きを選び、重みをアルベドで割る — 全方向が近くの物体に当たる面で、w の期待値が 1 になる。
        const ray = reflectionRayOf(this.sample, this.blueNoise);
        const albedo = ggxAlbedo(this.ltcTables.ltc2, this.sample.normal, this.sample.viewDir, this.sample.roughness);
        const hit = traceReflection(
          this.depthTarget.texture, this.footprint, this.traceSize, this.pixelSpan, this.projection,
          this.projectionInverse, this.near, this.stepCount, this.blueNoise.atScreenPixel(), this.sample,
          ray.direction, ray.weight.div(max(albedo, 1e-3)),
        );
        // 当たった画素だけ、当たった点の奥行きを ray から求めて像を読む。
        If(hit.weight.greaterThan(0), () => {
          const hitZ = this.sample.position.add(ray.direction.mul(hit.distance)).z;
          image.assign(this.radianceAt(reflectionSource, hit.hitUV, hitZ));
          distance.assign(hit.distance);
          weight.assign(hit.weight);
        });
      });
      return TracedReflection(image, distance, weight);
    })();
  }

  // 像の元 source を uv で双線形に読んだ放射輝度。hitZ は当たった点の view 空間の奥行きで、それより ray thickness を
  // 超えて奥の面が写る画素は読まない — ray が当たった面の像ではない。**Fn の中から呼ぶこと。**
  private radianceAt(source: THREE.Texture, uv: Vec2Node, hitZ: FloatNode): Vec3Node {
    const farZ = thicknessFarZ(hitZ).toVar();
    // uv を囲む描画画素 4 つと、双線形の端数。
    const position = uv.mul(this.fullSize).sub(0.5).toVar();
    const base = floor(position).toVar();
    const fraction = position.sub(base).toVar();
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    // rgb は読んだ画素の放射輝度の重み付きの和、a は重みの和。
    const sum = corners.reduce<Vec4Node>((total, [dx, dy]) => {
      const texel = base.add(vec2(dx, dy));
      const inside = texel.x.greaterThanEqual(0).and(texel.y.greaterThanEqual(0))
        .and(texel.x.lessThan(this.fullSize.x)).and(texel.y.lessThan(this.fullSize.y));
      const clamped = ivec2(clamp(texel, vec2(0), this.fullSize.sub(1))).toVar();
      const z = viewZOf(textureLoad(this.depth, clamped).r, this.projectionInverse);
      const accepted = inside.and(z.greaterThanEqual(farZ));
      const weight = (dx === 0 ? fraction.x.oneMinus() : fraction.x).mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
      return total.add(select(accepted, vec4(textureLoad(source, clamped).rgb, 1).mul(weight), vec4(0)));
    }, vec4(0)).toVar();
    // 当たった画素は必ず読むので、a は正。
    return sum.rgb.div(max(sum.a, 1e-6));
  }

  // 描画先と歩数を精細さの段へ合わせ、深度から位置を復元する行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    const tier = TRACE_TIERS[this.quality];
    this.stepCount.value = tier.stepCount;
    const footprint = Math.round(1 / tier.scale);
    this.footprint.value = footprint;
    const traceWidth = Math.max(1, Math.ceil(width / footprint));
    const traceHeight = Math.max(1, Math.ceil(height / footprint));
    // 描画先の寸法は、変わったときだけ確保し直す。
    if (this.depthTarget.width !== traceWidth || this.depthTarget.height !== traceHeight) {
      this.depthTarget.setSize(traceWidth, traceHeight);
    }
    for (const target of [this.output.rawTarget, this.output.denoisedTarget]) {
      if (target.width !== width || target.height !== height) target.setSize(width, height);
    }
    this.fullSize.value.set(width, height);
    this.traceSize.value.set(width / footprint, height / footprint);
    // 実カメラの行列と近クリップ距離。
    this.projection.value.copy(camera.projectionMatrix);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    // 画素 1 つは NDC で 2 / 寸法、view 空間では clip の w あたりその 1 / 射影の対角成分。
    const matrix = camera.projectionMatrix.elements;
    this.pixelSpan.value.set(2 / (width * matrix[0]!), 2 / (height * matrix[5]!));
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
      this.near.value = camera.near;
    }
    this.sample.sync(camera);
  }

  // 縮小した深度と、均す前と均した映り込みを空へ戻す。映り込みの w が 0 になるので、遠方の鏡面光は厳密にそのまま
  // 残る。残すと、切る直前の映り込みが凍ったまま遠方の鏡面光を置き換え続ける。
  private clearOutputs(): void {
    // 消去色はレンダラーを共有する他のパスのものなので、退避して黒の透明で消し、戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    for (const target of [this.depthTarget, this.output.rawTarget, this.output.denoisedTarget]) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }
}
