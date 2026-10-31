// ラスタのずれだけを変えた 2 枚 A・B の合流 M を対にして、A・B と差 A − B の和と二乗の和を GPU の上で積む器(LabView.accumulateRasterPairs)。
// A を描いたあと hold で写し、B を描いたあと add で差を作って足す。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { ivec2, mrt, screenCoordinate, textureLoad } from 'three/tsl';
import { stageMaterial } from '../../src/render/pipeline/screen-space/screen-space-stage';
import { PassAccumulator } from './pass-accumulator';

const HELD_NAME = 'rasterPairHeld';
const DIFFERENCE_NAME = 'rasterPairDifference';

export class RasterPairs {
  // 和は [偶奇][A, B, A − B]。
  public readonly accumulator: PassAccumulator;
  private readonly held: THREE.RenderTarget;
  private readonly difference: THREE.RenderTarget;
  private readonly holdQuad: QuadMesh;
  private readonly differenceQuad: QuadMesh;
  private readonly materials: readonly THREE.Material[];

  // merged は合流の描画先(走査の解像度の 'merged-0')。
  public constructor(private readonly renderer: WebGPURenderer, public readonly merged: THREE.RenderTarget) {
    const targetOf = (name: string): THREE.RenderTarget => {
      const target = new THREE.RenderTarget(merged.width, merged.height, {
        type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      target.texture.name = name;
      return target;
    };
    this.held = targetOf(HELD_NAME);
    this.difference = targetOf(DIFFERENCE_NAME);
    const pixel = ivec2(screenCoordinate.xy);
    const hold = stageMaterial();
    hold.mrtNode = mrt({ [HELD_NAME]: textureLoad(merged.texture, pixel) });
    this.holdQuad = new QuadMesh(hold);
    const subtract = stageMaterial();
    subtract.mrtNode = mrt({ [DIFFERENCE_NAME]: textureLoad(this.held.texture, pixel).sub(textureLoad(merged.texture, pixel)) });
    this.differenceQuad = new QuadMesh(subtract);
    this.materials = [hold, subtract];
    this.accumulator = new PassAccumulator(renderer, [this.held.texture, merged.texture, this.difference.texture], merged.width, merged.height);
  }

  // 直前に描いた A を写して持つ。
  public hold(): void {
    this.renderTo(this.held, this.holdQuad);
  }

  // 直前に描いた B と持っている A から差を作り、A・B・差を偶奇 parity の和へ足す。
  public add(parity: 0 | 1): void {
    this.renderTo(this.difference, this.differenceQuad);
    this.accumulator.add(parity);
  }

  public dispose(): void {
    this.accumulator.dispose();
    for (const target of [this.held, this.difference]) target.dispose();
    for (const material of this.materials) material.dispose();
  }

  private renderTo(target: THREE.RenderTarget, quad: QuadMesh): void {
    this.renderer.setRenderTarget(target);
    quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }
}
