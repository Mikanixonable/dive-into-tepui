// 近傍拡散補正のパスの描画命令 1 本の形と、その材質の組み方。描画命令は、全画面に 1 枚のマテリアルを描いて描画先へ書く。
import * as THREE from 'three/webgpu';
import { Fn, mrt, property, vec4 } from 'three/tsl';
import type { GpuPassId } from '../../gpu-timings';
import type { Vec4Node } from '../../tsl-types';

// 描画命令 1 本: material を全画面に描いて target へ書き、GPU 時間を gpuPass の行へ計上する。
export interface ScreenSpaceStage {
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly target: THREE.RenderTarget;
  readonly gpuPass: GpuPassId;
}

// 全画面で書くマテリアル。出力は呼び出し側が mrtNode へ置く。**合成を切る** — 負の補正をそのまま書く。
export function stageMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
}

// target のテクスチャへ、並びの順に values() の値を書くマテリアル。values は 1 つの Fn の中で一度だけ呼ばれる —
// テクスチャごとに組むと、値を求める計算がテクスチャの枚数だけ走る。
export function multiOutputMaterial(
  target: THREE.RenderTarget, values: () => readonly Vec4Node[],
): THREE.MeshBasicNodeMaterial {
  const outputs = target.textures.map(() => property('vec4'));
  const material = stageMaterial();
  // MRT の出力が読む変数を、色として組む Fn の中で書く。
  material.colorNode = Fn(() => {
    for (const [index, value] of values().entries()) outputs[index]!.assign(value);
    return vec4(0);
  })();
  material.mrtNode = mrt(Object.fromEntries(target.textures.map((texture, index) => [texture.name, outputs[index]!])));
  return material;
}
