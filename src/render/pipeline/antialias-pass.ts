// フレーム最後のパス: 合成パスと 3D UI パスが描き終えた表示用の画像の、物体の縁と線の
// ギザギザを均して画面へ出す。均し方は描画品質設定が選ぶ。
//
// 受け取る画像は表示用の階調を持つこと。縁を拾う閾値はその目盛りで定義されていて、
// 線形の明るさで渡すと暗い面の境目がすべて閾値の下に沈む。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { colorSpaceToWorking, texture } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import type { Vec4Node } from '../tsl-types';
import { compileInto } from './compile-into';

// 均し方の選択値。graphics-settings.ts の antialias の選択肢と対応する。
const ANTIALIAS_METHOD = { none: 0, fxaa: 1, smaa: 2 } as const;

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
  // 方式ごとに1枚を遅延生成して持つ。切り替えのたびに作り直すと、シェーダの再コンパイルが
  // フレームを止める。
  private readonly materials = new Map<number, THREE.MeshBasicNodeMaterial>();
  private method: number;

  // source は 3D UI パスまでを描き終えた表示用の画像。
  public constructor(
    private readonly renderer: WebGPURenderer,
    private readonly source: THREE.Texture,
    private readonly gpu: GpuTimings,
    method: number,
  ) {
    this.method = method;
    this.quad = new QuadMesh(this.material());
  }

  // 均し方を差し替える。値が変わった時点で呼ぶ。
  public setMethod(method: number): void {
    this.method = method;
    this.quad.material = this.material();
  }

  // 画面いっぱいに1枚描く。フレームの最後に1回呼ぶ。
  public render(): void {
    this.renderer.setRenderTarget(null);
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.antialias);
    this.quad.render(this.renderer);
  }

  // 現在選ばれている均し方を画面出力へ事前コンパイルする。
  public async compile(): Promise<void> {
    await compileInto(this.renderer, null, this.quad, this.quad.camera);
  }

  // 現在の方式のマテリアル。方式ごとに初回だけ組む。
  private material(): THREE.MeshBasicNodeMaterial {
    const cached = this.materials.get(this.method);
    if (cached !== undefined) return cached;
    // 読む位置は板の uv に任せる。screenUV を渡すと、頂点段で近傍の位置を組み立てる方式が
    // fragCoord を参照することになり、シェーダが通らない。
    const displayColor = texture(this.source);
    const smoothed = this.method === ANTIALIAS_METHOD.fxaa ? fxaa(displayColor)
      : this.method === ANTIALIAS_METHOD.smaa ? smaa(displayColor)
        : displayColor;
    const material = displayMaterial(smoothed);
    this.materials.set(this.method, material);
    return material;
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  public dispose(): void {
    for (const material of this.materials.values()) material.dispose();
  }
}
