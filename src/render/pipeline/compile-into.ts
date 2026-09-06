// 描画時と同じターゲットへパイプラインを組み、初回描画のコンパイル待ちを先に終える。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

// target の添付形式と深度・ステンシル設定を保ったまま object をコンパイルする。
export async function compileInto(
  renderer: WebGPURenderer,
  target: THREE.RenderTarget | null,
  object: THREE.Object3D,
  camera: THREE.Camera,
): Promise<void> {
  const savedTarget = renderer.getRenderTarget();
  const savedDepth = renderer.depth;
  const savedStencil = renderer.stencil;
  renderer.setRenderTarget(target);
  renderer.depth = target?.depthBuffer ?? true;
  renderer.stencil = target?.stencilBuffer ?? false;
  try {
    await renderer.compileAsync(object, camera);
  } finally {
    renderer.setRenderTarget(savedTarget);
    renderer.depth = savedDepth;
    renderer.stencil = savedStencil;
  }
}

// 描画時に出力ターゲットを張って描くパスをコンパイルする。three は出力ターゲットへ書くときだけ
// 階調変換の板を挟み、その手前を作業色空間の中間ターゲットへ描くので、同じ描画先でも
// compileInto とは別のパイプラインになる。階調変換の板自体は実際に描くまで作られない。
export async function compileIntoOutput(
  renderer: WebGPURenderer,
  outputTarget: THREE.RenderTarget | null,
  object: THREE.Object3D,
  camera: THREE.Camera,
): Promise<void> {
  const savedOutput = renderer.getOutputRenderTarget();
  renderer.setOutputRenderTarget(outputTarget);
  try {
    await compileInto(renderer, null, object, camera);
  } finally {
    renderer.setOutputRenderTarget(savedOutput);
  }
}
