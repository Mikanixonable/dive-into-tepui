// 陰影の合成のパス。面の画素の最終の陰影 keep + R × ((1 − w) × 遠方の鏡面照度 + w × I) を、world パスと共有する
// HDR ターゲットへ書き、G バッファの深度を同じターゲットへ複製する。近くの物体の映り込み(均した、または均す前の
// w × I と w)が遠方の鏡面光を置き換えるのはこの式の中だけで、鏡面反射率 R は両方へ同じ値を一度だけ掛ける。面の無い
// 画素は捨て、先に描かれた背景を残す。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { Discard, Fn, screenUV, texture, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { specularReflectanceAt } from './material-pass';
import { compileInto } from './compile-into';
import type { GBufferPass } from './gbuffer';
import type { ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { FloatNode, Vec3Node, Vec4Node } from '../tsl-types';

// 画素の最終の陰影。weight と weightedImage はいま描く画素の置換の重み w と、それを掛けた像 w × I で、映り込みの同じ
// 描画先の同じ texel から読んだもの。物体の無い画素は捨てる。
function composedShading(
  gbuffer: GBufferPass, keep: THREE.Texture, farSpecular: THREE.Texture, weight: FloatNode, weightedImage: Vec3Node,
): Vec4Node {
  return Fn(() => {
    Discard(gbuffer.covered().not());
    const replaced = texture(farSpecular, screenUV).rgb.mul(weight.oneMinus()).add(weightedImage);
    const specular = specularReflectanceAt(gbuffer, screenUV).mul(replaced);
    return vec4(texture(keep, screenUV).rgb.add(specular), 1);
  })();
}

// 映り込みの w と w × I を weight / weightedImage から読んで合成する板のマテリアル。
function compositeMaterial(
  gbuffer: GBufferPass, keep: THREE.Texture, farSpecular: THREE.Texture, weight: FloatNode, weightedImage: Vec3Node,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: true, transparent: false, blending: THREE.NoBlending,
  });
  material.colorNode = composedShading(gbuffer, keep, farSpecular, weight, weightedImage);
  // 深度は G バッファのものを複製する。depthTest を切ったまま depthWrite を立てるので、捨てなかった画素が
  // 無条件に書かれる。
  material.depthNode = texture(gbuffer.depthTexture, screenUV).r;
  return material;
}

export class ShadingCompositePass {
  // 均す前と均した映り込みを読む 2 枚。ぼかしの切り替えでは持ち替えるだけにする — 組み直すとシェーダの再コンパイルが
  // フレームを止める。
  private readonly rawMaterial: THREE.MeshBasicNodeMaterial;
  private readonly denoisedMaterial: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();

  // keep は映り込みが置き換えない成分(放射輝度)、farSpecular は遠方の鏡面照度、reflection は映り込み、sharedTarget は
  // 書き込む共有の描画先。denoised は構築時点の描画設定 screenSpaceSpecularDenoise の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, keep: THREE.Texture, farSpecular: THREE.Texture,
    reflection: ScreenSpaceReflection, private readonly sharedTarget: THREE.RenderTarget,
    private readonly gpu: GpuTimings, private denoised: boolean,
  ) {
    this.rawMaterial = compositeMaterial(
      gbuffer, keep, farSpecular, reflection.rawWeightAt(screenUV), reflection.rawWeightedImageAt(screenUV),
    );
    this.denoisedMaterial = compositeMaterial(
      gbuffer, keep, farSpecular, reflection.denoisedWeightAt(screenUV), reflection.denoisedWeightedImageAt(screenUV),
    );
  }

  // 次の render から、均した映り込み(denoised が真)か均す前の映り込みを読む。
  public setDenoised(denoised: boolean): void {
    this.denoised = denoised;
  }

  // 共有の描画先にいま描かれている背景を残したまま、面の画素を上書きする。
  public render(): void {
    this.renderer.setRenderTarget(this.sharedTarget);
    this.renderer.autoClear = false;
    this.quad.material = this.denoised ? this.denoisedMaterial : this.rawMaterial;
    this.gpu.beginPass(GPU_PASS.shadingComposite);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // 2 枚の合成の板を共有の描画先へ事前コンパイルする。
  public async compile(): Promise<void> {
    for (const material of [this.rawMaterial, this.denoisedMaterial]) {
      this.quad.material = material;
      await compileInto(this.renderer, this.sharedTarget, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.rawMaterial.dispose();
    this.denoisedMaterial.dispose();
  }
}
