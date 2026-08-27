// フレーム最後のパス: 合成パスと 3D UI パスが描き終えた表示用の画像の、物体の縁と線の
// ギザギザを均して画面へ出す。均すかどうかは描画品質設定で切り替わる。
//
// 受け取る画像は表示用の階調を持つこと。縁を拾う閾値はその目盛りで定義されていて、
// 線形の明るさで渡すと暗い面の境目がすべて閾値の下に沈む。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { colorSpaceToWorking, screenUV, texture } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { Vec4Node } from '../tsl-types';

// 表示用の階調で読んだ色を線形へ戻して返す板の材質。レンダラは画面へ書くときに同じ変換を
// もう一度掛けるので、往復が相殺される — 戻さないと画面全体が白く浮く。
function displayMaterial(displayColor: THREE.Node): THREE.MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: false });
  // colorSpaceToWorking の @types/three 上の戻り値型 ColorSpaceNode はメソッドチェインを
  // 持たない(型定義側の欠落)ため、Vec4Node へ読み替える。
  material.colorNode = colorSpaceToWorking(displayColor, THREE.SRGBColorSpace) as unknown as Vec4Node;
  return material;
}

export class AntialiasPass {
  private readonly quad: QuadMesh;
  private readonly smoothedMaterial: THREE.MeshBasicNodeMaterial;
  private readonly rawMaterial: THREE.MeshBasicNodeMaterial;

  // source は 3D UI パスまでを描き終えた表示用の画像。
  public constructor(
    private readonly renderer: WebGPURenderer,
    source: THREE.Texture,
    private readonly gpu: GpuTimings,
    enabled: boolean,
  ) {
    this.smoothedMaterial = displayMaterial(fxaa(texture(source, screenUV)));
    this.rawMaterial = displayMaterial(texture(source, screenUV));
    this.quad = new QuadMesh(enabled ? this.smoothedMaterial : this.rawMaterial);
  }

  // 縁を均すかどうかを切り替える。値が変わった時点で呼ぶ。
  public setEnabled(enabled: boolean): void {
    this.quad.material = enabled ? this.smoothedMaterial : this.rawMaterial;
  }

  // 画面いっぱいに1枚描く。フレームの最後に1回呼ぶ。
  public render(): void {
    this.renderer.setRenderTarget(null);
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.antialias);
    this.quad.render(this.renderer);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  public dispose(): void {
    this.smoothedMaterial.dispose();
    this.rawMaterial.dispose();
  }
}
