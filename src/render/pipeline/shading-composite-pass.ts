// 陰影の合成のパス。面の画素の最終の陰影 keep + R × ((1 − w) × 遠方の鏡面照度 + w × I) を、world パスと共有する
// HDR ターゲットへ書き、G バッファの深度を同じターゲットへ複製する。近くの物体の映り込み(w × I と w)が遠方の
// 鏡面光を置き換えるのはこの式の中だけで、鏡面反射率 R は両方へ同じ値を一度だけ掛ける。面の無い画素は捨て、先に
// 描かれた背景を残す。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { Discard, Fn, screenUV, texture, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { specularReflectanceAt } from './material-pass';
import { compileInto } from './compile-into';
import type { GBufferPass } from './gbuffer';
import type { ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { Vec4Node } from '../tsl-types';

// 画素の最終の陰影。物体の無い画素は捨てる。
function composedShading(
  gbuffer: GBufferPass, keep: THREE.Texture, farSpecular: THREE.Texture, reflection: ScreenSpaceReflection,
): Vec4Node {
  return Fn(() => {
    Discard(gbuffer.covered().not());
    const weight = reflection.weightAt(screenUV);
    const replaced = texture(farSpecular, screenUV).rgb.mul(weight.oneMinus())
      .add(reflection.weightedImageAt(screenUV));
    const specular = specularReflectanceAt(gbuffer, screenUV).mul(replaced);
    return vec4(texture(keep, screenUV).rgb.add(specular), 1);
  })();
}

export class ShadingCompositePass {
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // keep は映り込みが置き換えない成分(放射輝度)、farSpecular は遠方の鏡面照度、reflection は映り込み、sharedTarget は
  // 書き込む共有の描画先。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, keep: THREE.Texture, farSpecular: THREE.Texture,
    reflection: ScreenSpaceReflection, private readonly sharedTarget: THREE.RenderTarget,
    private readonly gpu: GpuTimings,
  ) {
    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false, depthWrite: true, transparent: false, blending: THREE.NoBlending,
    });
    this.material.colorNode = composedShading(gbuffer, keep, farSpecular, reflection);
    // 深度は G バッファのものを複製する。depthTest を切ったまま depthWrite を立てるので、捨てなかった画素が
    // 無条件に書かれる。
    this.material.depthNode = texture(gbuffer.depthTexture, screenUV).r;
    this.quad = new QuadMesh(this.material);
  }

  // 共有の描画先にいま描かれている背景を残したまま、面の画素を上書きする。
  public render(): void {
    this.renderer.setRenderTarget(this.sharedTarget);
    this.renderer.autoClear = false;
    this.gpu.beginPass(GPU_PASS.shadingComposite);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // 合成の板を共有の描画先へ事前コンパイルする。
  public async compile(): Promise<void> {
    await compileInto(this.renderer, this.sharedTarget, this.quad, this.quad.camera);
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.material.dispose();
  }
}
