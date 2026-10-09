// 映り込みのパス。マテリアルパスが共有の描画先へ書いた絵を縮小列にし、映り込みの判定(ScreenSpaceReflection)が
// 当たった位置の像を、鏡面ローブが当たり距離で張る円の大きさに合う段から読んで(Uludag 2014「Hi-Z Screen-Space
// Cone-Traced Reflections」)、鏡面反射率と置換の重みを掛けた像を共有の描画先へ足す。描画設定のオン / オフを受け、
// オフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, abs, clamp, float, log2, max, screenSize, screenUV, tan, texture, uniform, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { ShadingSample } from './lighting/shading-sample';
import { specularReflectanceAt } from './material-pass';
import { compileInto } from './compile-into';
import type { ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { GBufferPass } from './gbuffer';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 縮小列の段数。段 0 は共有の描画先そのもので、段 k は画面の 1/2^k の解像度。
// TODO: 段数は仮置き。映り込みの精細さの段と合わせて、ぼけの届く粗さと費用を実測して決め直す。
const LEVEL_COUNT = 5;
// 鏡面ローブの半幅 [rad] の、GGX の α(知覚的粗さの 2 乗)に対する比。
const LOBE_HALF_WIDTH_PER_ALPHA = 2;

// 全画面で書くマテリアル。additive を立てると、描画先へ加算で積む。
function stageMaterial(colorNode: Vec4Node, additive = false): THREE.MeshBasicNodeMaterial {
  // 加算合成は透過を明示しないと効かないので、上書きの段も含めて透過で作る。
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true });
  if (additive) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
  } else {
    material.blending = THREE.NoBlending;
  }
  material.colorNode = colorNode;
  return material;
}

// 深度を持たない半精度の描画先。
function imageTarget(): THREE.RenderTarget {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
  });
}

// 縮小列の 1 段。target は source を半分の解像度へ縮めた絵を持つ。
interface ReductionLevel {
  readonly target: THREE.RenderTarget;
  readonly material: THREE.MeshBasicNodeMaterial;
}

export class ReflectionPass {
  // 縮小列の段 1 以降。段 k は levels[k − 1]。
  private readonly levels: readonly ReductionLevel[];
  // 共有の描画先へ足す像 R × w × I。足した後もこのフレームの値を残す。
  private readonly imageTarget = imageTarget();
  private readonly resolveMaterial: THREE.MeshBasicNodeMaterial;
  private readonly addMaterial: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 反射する面のシェーディング入力。
  private readonly sample: ShadingSample;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの射影行列は毎フレーム自前で書き込む。
  private readonly projection: Mat4Uniform = uniform(new THREE.Matrix4());
  // 直前に render したときのオン / オフ。null はまだ render していないこと。
  private renderedEnabled: boolean | null = null;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // sharedTarget はマテリアルパスが書いた共有の描画先で、像はそこから読み、そこへ足す。reflection は映り込みの
  // 判定。enabled は構築時点の描画設定 screenSpaceSpecular の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, reflection: ScreenSpaceReflection,
    private readonly sharedTarget: THREE.RenderTarget, private readonly gpu: GpuTimings, private enabled: boolean,
  ) {
    const levels: ReductionLevel[] = [];
    for (let level = 1; level < LEVEL_COUNT; level++) {
      const source = level === 1 ? sharedTarget.texture : levels[level - 2]!.target.texture;
      // 半分の解像度の画素の中心で双線形に読むと、元の 2 × 2 の画素の平均になる。
      levels.push({ target: imageTarget(), material: stageMaterial(vec4(texture(source, screenUV).rgb, 1)) });
    }
    this.levels = levels;
    this.sample = new ShadingSample(gbuffer);
    this.resolveMaterial = stageMaterial(this.image(gbuffer, reflection));
    // α を 0 で積み、共有の描画先の α を変えない。
    this.addMaterial = stageMaterial(vec4(texture(this.imageTarget.texture, screenUV).rgb, 0), true);
  }

  // このフレームに共有の描画先へ足した像。
  public get texture(): THREE.Texture { return this.imageTarget.texture; }

  // 次の render からオン / オフを enabled にする。
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // 1 フレームぶんを描く。マテリアルパスの後・大気パスの前に、描画バッファの寸法 width × height で呼ぶ。camera は
  // 当たった位置を画面へ写す行列を引き直すためだけに使う。
  public render(camera: THREE.Camera, width: number, height: number): void {
    if (this.enabled !== this.renderedEnabled && !this.enabled) this.clearImage();
    this.renderedEnabled = this.enabled;
    if (!this.enabled) return;
    this.prepare(camera, width, height);
    // 縮小列 → 像 → 加算の順に書く。どの段も、自分の描画先を読まない。
    for (const [material, target] of this.stages()) {
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = target !== this.sharedTarget;
      this.quad.material = material;
      this.gpu.beginPass(GPU_PASS.reflection);
      this.quad.render(this.renderer);
    }
    this.renderer.autoClear = true;
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
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する単一の板
  // なので、ここでは解放しない。
  public dispose(): void {
    for (const { target, material } of this.levels) {
      target.dispose();
      material.dispose();
    }
    this.imageTarget.dispose();
    this.resolveMaterial.dispose();
    this.addMaterial.dispose();
  }

  // 描画命令の列。マテリアルとその描画先の組を、書く順に並べる。
  private stages(): readonly (readonly [THREE.MeshBasicNodeMaterial, THREE.RenderTarget])[] {
    return [
      ...this.levels.map(({ material, target }) => [material, target] as const),
      [this.resolveMaterial, this.imageTarget],
      [this.addMaterial, this.sharedTarget],
    ];
  }

  // 画素ごとの像 R × w × I。置換の重み w が 0 の画素は 0。
  private image(gbuffer: GBufferPass, reflection: ScreenSpaceReflection): Vec4Node {
    return Fn(() => {
      const image = vec3(0).toVar();
      // 判定は面の写っている画素にだけ w を書くので、w の正の画素は面の画素。
      const weight = reflection.weightAt(screenUV).toVar();
      If(weight.greaterThan(0), () => {
        const level = this.levelOf(reflection.hitDistanceAt(screenUV));
        const radiance = this.radianceAt(reflection.hitUVAt(screenUV), level);
        image.assign(specularReflectanceAt(gbuffer, screenUV).mul(weight).mul(radiance));
      });
      return vec4(image, 1);
    })();
  }

  // 当たり距離 distance [m] で鏡面ローブが張る円を覆う縮小列の段(小数)。円の直径が段の画素 1 つに収まる段を選ぶ。
  private levelOf(distance: FloatNode): FloatNode {
    const alpha = this.sample.roughness.mul(this.sample.roughness);
    const radius = distance.mul(tan(alpha.mul(LOBE_HALF_WIDTH_PER_ALPHA)));
    // 当たった点と、そこから画面の横へ円の半径だけずらした点を画面へ写し、半径を画素で測る。
    const hit = this.sample.position.add(this.sample.reflected.mul(distance)).toVar();
    const center = this.projection.mul(vec4(hit, 1));
    const edge = this.projection.mul(vec4(hit.add(vec3(radius, 0, 0)), 1));
    const radiusPixels = abs(edge.x.div(edge.w).sub(center.x.div(center.w))).mul(0.5).mul(screenSize.x);
    return clamp(log2(max(radiusPixels.mul(2), 1)), 0, LEVEL_COUNT - 1);
  }

  // 縮小列を段 level(小数)で読んだ uv の放射輝度。隣り合う 2 段を段の端数で線形に混ぜる。
  private radianceAt(uv: Vec2Node, level: FloatNode): Vec3Node {
    const sources = [this.sharedTarget.texture, ...this.levels.map(({ target }) => target.texture)];
    return sources.reduce<Vec3Node>((sum, source, index) => {
      const share = max(float(1).sub(abs(level.sub(index))), 0);
      // 段を明示して読む — 一様でない分岐の中では暗黙の段を組めない。どの描画先も段は 1 つだけ。
      return sum.add(texture(source, uv).level(float(0)).rgb.mul(share));
    }, vec3(0));
  }

  // 描画先を描画バッファの寸法へ合わせ、実カメラの行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    // 描画先の寸法は、変わったときだけ確保し直す。
    if (this.imageTarget.width !== width || this.imageTarget.height !== height) {
      this.imageTarget.setSize(width, height);
    }
    for (const [index, { target }] of this.levels.entries()) {
      const scale = 2 ** (index + 1);
      const levelWidth = Math.max(1, Math.ceil(width / scale));
      const levelHeight = Math.max(1, Math.ceil(height / scale));
      if (target.width !== levelWidth || target.height !== levelHeight) target.setSize(levelWidth, levelHeight);
    }
    this.projection.value.copy(camera.projectionMatrix);
    this.sample.sync(camera);
  }

  // 像を空へ戻す。残すと、切る直前の像が「映り込み」の表示に凍ったまま残る。
  private clearImage(): void {
    // 消去色はレンダラーを共有する他のパスのものなので、退避して黒の透明で消し、戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.imageTarget);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }
}
