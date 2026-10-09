// 映り込みのパス。映り込みの判定(ScreenSpaceReflection)が当たった位置の像を、マテリアルパスが共有の描画先へ書いた
// 絵から読み、鏡面反射率と置換の重みを掛けて共有の描画先へ足す。描画設定のオン / オフを受け、オフのフレームは
// 描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, clamp, floor, ivec2, max, screenUV, select, texture, textureLoad, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { ShadingSample } from './lighting/shading-sample';
import { specularReflectanceAt } from './material-pass';
import { compileInto } from './compile-into';
import { reflectionRayOf, thicknessFarZ, viewZOf } from './screen-space/reflection-trace';
import { BlueNoise } from '../blue-noise';
import type { ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { GBufferPass } from './gbuffer';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../tsl-types';

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

export class ReflectionPass {
  // rgb は共有の描画先へ足す像 R × w × I。足した後もこのフレームの値を残す。
  private readonly imageTarget = imageTarget();
  private readonly resolveMaterial: THREE.MeshBasicNodeMaterial;
  private readonly addMaterial: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 反射する面のシェーディング入力。
  private readonly sample: ShadingSample;
  // 追跡した ray の向きを引き直す blue noise。
  private readonly blueNoise = new BlueNoise();
  // G バッファの素の深度(逆 Z、虚空は 0)。
  private readonly depth: THREE.DepthTexture;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの射影行列の逆は毎フレーム自前で書き込む。
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // 描画バッファの解像度 [px]。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
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
    this.depth = gbuffer.depthTexture;
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
  // 当たった位置の奥行きを求める行列を引き直すためだけに使う。
  public render(camera: THREE.Camera, width: number, height: number): void {
    if (this.enabled !== this.renderedEnabled && !this.enabled) this.clearImage();
    this.renderedEnabled = this.enabled;
    if (!this.enabled) return;
    this.prepare(camera, width, height);
    // 像 → 加算の順に書く。どの段も、自分の描画先を読まない。
    for (const [material, target] of this.stages()) {
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = target === this.imageTarget;
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
    this.imageTarget.dispose();
    this.resolveMaterial.dispose();
    this.addMaterial.dispose();
    this.blueNoise.dispose();
  }

  // 描画命令の列。マテリアルとその描画先の組を、書く順に並べる。
  private stages(): readonly (readonly [THREE.MeshBasicNodeMaterial, THREE.RenderTarget])[] {
    return [
      [this.resolveMaterial, this.imageTarget],
      [this.addMaterial, this.sharedTarget],
    ];
  }

  // 画素ごとの像 R × w × I。置換の重み w が 0 の画素は像が 0。
  private image(gbuffer: GBufferPass, reflection: ScreenSpaceReflection): Vec4Node {
    return Fn(() => {
      const image = vec3(0).toVar();
      // 判定は面の写っている画素にだけ w を書くので、w の正の画素は面の画素。
      const weight = reflection.weightAt(screenUV).toVar();
      If(weight.greaterThan(0), () => {
        const distance = reflection.hitDistanceAt(screenUV).toVar();
        const direction = reflectionRayOf(this.sample, this.blueNoise).direction;
        const hitZ = this.sample.position.add(direction.mul(distance)).z;
        const radiance = this.radianceAt(reflection.hitUVAt(screenUV), hitZ);
        image.assign(specularReflectanceAt(gbuffer, screenUV).mul(weight).mul(radiance));
      });
      return vec4(image, 1);
    })();
  }

  // 共有の描画先を uv で双線形に読んだ放射輝度。hitZ は当たった点の view 空間の奥行きで、それより ray thickness を
  // 超えて奥の面が写る画素は読まない — ray が当たった面の像ではない。**Fn の中から呼ぶこと。**
  private radianceAt(uv: Vec2Node, hitZ: FloatNode): Vec3Node {
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
      return total.add(select(accepted, vec4(textureLoad(this.sharedTarget.texture, clamped).rgb, 1).mul(weight), vec4(0)));
    }, vec4(0)).toVar();
    // 当たった画素は必ず読むので、a は正。
    return sum.rgb.div(max(sum.a, 1e-6));
  }

  // 描画先を描画バッファの寸法へ合わせ、実カメラの行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    // 描画先の寸法は、変わったときだけ確保し直す。
    if (this.imageTarget.width !== width || this.imageTarget.height !== height) {
      this.imageTarget.setSize(width, height);
    }
    this.fullSize.value.set(width, height);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
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
