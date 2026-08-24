// G バッファの深度から画素ごとの描画座標を復元し、そこへ恒星の直射光がどれだけ届くかを
// 1 枚の透過率へ書く。透過率そのものを決めるのは sun-occlusion.ts で、このパスはその関数を
// 画面の全画素で評価してキャッシュするだけ。ライティングパスはこの 1 枚を読んで恒星の
// 放射照度へ掛ける。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { Mat4Uniform, Vec3Node } from '../tsl-types';
import type { GBufferPass } from './gbuffer';
import type { SunOcclusion } from './sun-occlusion';
import { viewPositionAt } from './view-ray';

export class OcclusionPass {
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む(light-prepass.ts の逆射影行列と同じ理由)。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;

  // 透過率の書き込み先を確保し、深度から復元した位置で遮蔽関数を評価するグラフを一度だけ組む。
  constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    sunOcclusion: SunOcclusion,
    private readonly gpu: GpuTimings,
  ) {
    this.target = new THREE.RenderTarget(1, 1, {
      format: THREE.RedFormat, type: THREE.HalfFloatType, depthBuffer: false, samples: 0,
    });

    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());

    const viewPos = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse);
    const worldPos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    const transmittance = sunOcclusion.transmittance(worldPos, { spheres: true, rings: true });
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.colorNode = vec4(vec3(transmittance), 1);
    this.quad = new QuadMesh(this.material);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  // G バッファの深度だけを読んで透過率を書く(フルスクリーン1枚)。camera は逆射影行列と
  // view→描画座標の行列を毎フレーム引き直すためだけに使う。
  render(camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);

    this.renderer.setRenderTarget(this.target);
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.occlusion);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
