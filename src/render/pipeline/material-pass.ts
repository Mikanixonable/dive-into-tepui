// ライトプリパスが書いた拡散/鏡面の照度へ G バッファの素材(ベース色・金属度・自己発光)を
// 掛け合わせて最終的な陰影を求め、world パスと共有する HDR ターゲットへ画面 1 枚として書き込む
// (このパスがそこへの最初の書き込みなのでクリアする)。背景専用レイヤーの星野を陰影より先に
// 描くのと、G バッファの深度を同じターゲットへ複製するのもこのパスが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { BRDF_Lambert, Discard, Fn, mix, screenUV, texture, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { WORLD_BACKGROUND_LAYER } from './lit-layer';
import type { GBufferPass } from './gbuffer';
import type { LightPrepass } from './light-prepass';
import type { Vec3Node, Vec4Node } from '../tsl-types';

// 画素の最終的な陰影。拡散は BRDF_Lambert(ベース色×(1−金属度)/π)、鏡面は F0(誘電体 0.04 と
// 金属色を金属度で混ぜた値)を照度へ掛け、自己発光を足す。照度バッファが持つのは放射照度なので、
// 掛けるのは反射率ではなく BRDF — 拡散の 1/π を落とすと、それだけで π 倍明るくなる。
function shadedColor(lightPrepass: LightPrepass, gbuffer: GBufferPass): Vec4Node {
  return Fn(() => {
    // 物体の無い画素を捨てて、先に描いた星野を残す。
    Discard(gbuffer.covered().not());

    const material = texture(gbuffer.basecolorTexture, screenUV);
    const baseColor: Vec3Node = material.rgb;
    const metalness = material.a;
    // BRDF_Lambert の @types/three 上の戻り値型はメソッドチェインを持たないため、Vec3Node へ読み替える。
    const lambert = BRDF_Lambert({
      diffuseColor: baseColor.mul(metalness.oneMinus()),
    }) as unknown as Vec3Node;
    const diffuse = texture(lightPrepass.diffuseTexture, screenUV).rgb.mul(lambert);
    const specular = texture(lightPrepass.specularTexture, screenUV).rgb
      .mul(mix(vec3(0.04), baseColor, metalness));
    const emissive = texture(gbuffer.emissiveTexture, screenUV).rgb;

    return vec4(diffuse.add(specular).add(emissive), 1);
  })();
}

export class MaterialPass {
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // 照度と素材を掛け合わせる全画面の板ポリを一度だけ組み立てる。
  public constructor(
    private readonly renderer: WebGPURenderer,
    lightPrepass: LightPrepass,
    gbuffer: GBufferPass,
    private readonly gpu: GpuTimings,
  ) {
    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false, depthWrite: true, transparent: false, blending: THREE.NoBlending,
    });
    this.material.colorNode = shadedColor(lightPrepass, gbuffer);
    // 深度は G バッファのものを複製する。depthTest を切ったまま depthWrite を立てるので、
    // 捨てなかった画素が無条件に書かれる。
    this.material.depthNode = texture(gbuffer.depthTexture, screenUV).r;
    this.quad = new QuadMesh(this.material);
  }

  // 背景専用レイヤーと陰影の板ポリを sharedTarget へ描く。camera はこのあと world パスでも
  // 使う同一インスタンスなので、layers.mask は呼び出し前の値へ必ず戻す。
  public render(scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget): void {
    const savedMask = camera.layers.mask;
    camera.layers.set(WORLD_BACKGROUND_LAYER);

    this.renderer.setRenderTarget(sharedTarget);
    // beginPass は描画命令ごとに申告する — 板ポリのぶんも同じパスへ計上する。
    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.autoClear = true;
    this.renderer.render(scene, camera);

    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.autoClear = false;
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;

    this.renderer.setRenderTarget(null);
    camera.layers.mask = savedMask;
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.material.dispose();
  }
}
