// フレーム最後のパス: 合成パスと 3D UI パスが描き終えた表示用の画像を、画面へ1枚として出す。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { colorSpaceToWorking, screenUV, texture } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { Vec4Node } from '../tsl-types';

export class AntialiasPass {
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;

  // source は 3D UI パスまでを描き終えた表示用の画像。
  public constructor(
    private readonly renderer: WebGPURenderer,
    source: THREE.Texture,
    private readonly gpu: GpuTimings,
  ) {
    this.material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: false });
    // 読む画像は表示用の階調を持ち、レンダラは画面へ書くときに同じ変換をもう一度掛ける。
    // 線形へ戻しておくことで往復が相殺される — 外すと画面全体が白く浮く。
    const displayColor: Vec4Node = texture(source, screenUV);
    // colorSpaceToWorking の @types/three 上の戻り値型 ColorSpaceNode はメソッドチェインを
    // 持たない(型定義側の欠落)ため、Vec4Node へ読み替える。
    this.material.colorNode = colorSpaceToWorking(displayColor, THREE.SRGBColorSpace) as unknown as Vec4Node;
    this.quad = new QuadMesh(this.material);
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
    this.material.dispose();
  }
}
