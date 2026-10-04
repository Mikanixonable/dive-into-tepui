// 描画先のテクスチャを、パスごとに偶数番目と奇数番目に分けて float32 の和へ GPU の上で足し込む器。多くのパスの平均を、
// パスごとに読み戻さずに作るためのもの。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { ivec2, mrt, screenCoordinate, textureLoad } from 'three/tsl';
import { stageMaterial } from '../../src/render/pipeline/screen-space/screen-space-stage';

// 和の描画先のテクスチャの名前(MRT の出力と結び付く)。
const SUM_NAME = 'passSum';

// 1 つの和: 交互に書く 2 枚の描画先と、materials[i] が targets[i] に足して targets[1 − i] へ書く材質、いまの和の番号。
interface AlternatingSum {
  readonly targets: readonly [THREE.RenderTarget, THREE.RenderTarget];
  readonly materials: readonly [THREE.MeshBasicNodeMaterial, THREE.MeshBasicNodeMaterial];
  current: 0 | 1;
}

export class PassAccumulator {
  // 偶奇(0 が偶数番目)ごと・足すテクスチャごとの和。float32 の合成(加算の混合)は WebGPU で保証されないので、交互に
  // 書く 2 枚で足す。
  private readonly sums: readonly (readonly AlternatingSum[])[];
  private readonly quad = new QuadMesh();
  // 0 に戻すときに退避する消去色。
  private readonly savedClearColor = new THREE.Color();

  // sources は足すテクスチャ(どれも width × height の RGBA)。
  public constructor(
    private readonly renderer: WebGPURenderer, public readonly sources: readonly THREE.Texture[],
    width: number, height: number,
  ) {
    const targetOf = (): THREE.RenderTarget => {
      const target = new THREE.RenderTarget(width, height, {
        type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      target.texture.name = SUM_NAME;
      return target;
    };
    // 和 previous に source を足して書く材質。値は負にもなるので、色の経路(colorNode)を通さず MRT の出力で書く。
    const materialOf = (previous: THREE.RenderTarget, source: THREE.Texture): THREE.MeshBasicNodeMaterial => {
      const material = stageMaterial();
      const pixel = ivec2(screenCoordinate.xy);
      material.mrtNode = mrt({ [SUM_NAME]: textureLoad(previous.texture, pixel).add(textureLoad(source, pixel)) });
      return material;
    };
    this.sums = [0, 1].map(() => sources.map((source): AlternatingSum => {
      const targets = [targetOf(), targetOf()] as const;
      return { targets, materials: [materialOf(targets[0], source), materialOf(targets[1], source)], current: 0 };
    }));
    this.clear();
  }

  // 直前に描いた sources を、偶奇 parity(0 が偶数番目のパス)の和へ足す。
  public add(parity: 0 | 1): void {
    for (const sum of this.sums[parity]!) {
      this.renderer.setRenderTarget(sum.targets[1 - sum.current]!);
      this.quad.material = sum.materials[sum.current];
      this.quad.render(this.renderer);
      sum.current = sum.current === 0 ? 1 : 0;
    }
    this.renderer.setRenderTarget(null);
  }

  // いまの和を持つテクスチャ。[偶奇][sources の番号]。
  public get textures(): readonly (readonly THREE.Texture[])[] {
    return this.sums.map((sums) => sums.map((sum) => sum.targets[sum.current].texture));
  }

  // 和を 0 に戻す。
  public clear(): void {
    // 消去色はレンダラーを共有する他のパスのものなので、退避して黒の透明で消し、戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    for (const sum of this.sums.flat()) {
      for (const target of sum.targets) {
        this.renderer.setRenderTarget(target);
        this.renderer.clear(true, false, false);
      }
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  // 持っている描画先と材質を解放する。
  public dispose(): void {
    for (const sum of this.sums.flat()) {
      for (const target of sum.targets) target.dispose();
      for (const material of sum.materials) material.dispose();
    }
  }
}
