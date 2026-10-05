// 描画先のテクスチャを、パスごとに偶数番目と奇数番目に分けて、値の和と成分ごとの二乗の和を float32 で GPU の上で足し込む
// 器。多くのパスの平均と分散を、パスごとに読み戻さずに作るためのもの。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { ivec2, mrt, screenCoordinate, textureLoad, vec4 } from 'three/tsl';
import { stageMaterial } from '../../src/render/pipeline/screen-space/screen-space-stage';

// 和の描画先の 2 枚のテクスチャ — 値の和と成分ごとの二乗の和 — の番号と名前(MRT の出力と結び付く)。
const SUM_INDEX = 0;
const SQUARE_INDEX = 1;
const SUM_NAME = 'passSum';
const SQUARE_NAME = 'passSquare';

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
  // 和の描画先の 2 枚へ 0 を書く材質。
  private readonly zeroMaterial = stageMaterial();

  // sources は足すテクスチャ(どれも width × height の RGBA)。
  public constructor(
    private readonly renderer: WebGPURenderer, public readonly sources: readonly THREE.Texture[],
    width: number, height: number,
  ) {
    const targetOf = (): THREE.RenderTarget => {
      const target = new THREE.RenderTarget(width, height, {
        count: 2, type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      target.textures[SUM_INDEX]!.name = SUM_NAME;
      target.textures[SQUARE_INDEX]!.name = SQUARE_NAME;
      return target;
    };
    // 和 previous に source を足して書く材質。値は負にもなるので、色の経路(colorNode)を通さず MRT の出力で書く。
    const materialOf = (previous: THREE.RenderTarget, source: THREE.Texture): THREE.MeshBasicNodeMaterial => {
      const material = stageMaterial();
      const pixel = ivec2(screenCoordinate.xy);
      const value = textureLoad(source, pixel);
      material.mrtNode = mrt({
        [SUM_NAME]: textureLoad(previous.textures[SUM_INDEX]!, pixel).add(value),
        [SQUARE_NAME]: textureLoad(previous.textures[SQUARE_INDEX]!, pixel).add(value.mul(value)),
      });
      return material;
    };
    this.sums = [0, 1].map(() => sources.map((source): AlternatingSum => {
      const targets = [targetOf(), targetOf()] as const;
      return { targets, materials: [materialOf(targets[0], source), materialOf(targets[1], source)], current: 0 };
    }));
    this.zeroMaterial.mrtNode = mrt({ [SUM_NAME]: vec4(0), [SQUARE_NAME]: vec4(0) });
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

  // いまの値の和を持つテクスチャ。[偶奇][sources の番号]。
  public get sumTextures(): readonly (readonly THREE.Texture[])[] { return this.currentTextures(SUM_INDEX); }

  // いまの成分ごとの二乗の和を持つテクスチャ。[偶奇][sources の番号]。
  public get squareTextures(): readonly (readonly THREE.Texture[])[] { return this.currentTextures(SQUARE_INDEX); }

  // いまの和の描画先の index 枚目のテクスチャ。[偶奇][sources の番号]。
  private currentTextures(index: number): readonly (readonly THREE.Texture[])[] {
    return this.sums.map((sums) => sums.map((sum) => sum.targets[sum.current].textures[index]!));
  }

  // 和を 0 に戻す。
  public clear(): void {
    // renderer.clear は MRT の 2 枚目以降を消去色によらず α = 1 で消すので、0 を書いて消す。
    this.quad.material = this.zeroMaterial;
    for (const sum of this.sums.flat()) {
      for (const target of sum.targets) {
        this.renderer.setRenderTarget(target);
        this.quad.render(this.renderer);
      }
    }
    this.renderer.setRenderTarget(null);
  }

  // 持っている描画先と材質を解放する。
  public dispose(): void {
    for (const sum of this.sums.flat()) {
      for (const target of sum.targets) target.dispose();
      for (const material of sum.materials) material.dispose();
    }
    this.zeroMaterial.dispose();
  }
}
