// フレーム最後のパス: 3D 空間に居るが物理的な明るさを持たない表示物(軌道線・軌跡線・天球
// グリッド・縮尺グリッド・Δv ギズモ)を、合成後の画面へ描き足す。物理量として描くものだけが
// 露出とトーンマッピングを通るので、それらの外へ出す — 指定した色がそのまま画面へ出る。
//
// 深度は自前では書かない。合成パスが G バッファの深度を画面の深度バッファへ複製しているので、
// このパスは普通に深度テストするだけでよく、線のマテリアルをノード化する必要がない。
// 帰結として、深度を書かない透ける物体(環・大気・オーロラ・噴射炎)には隠れない。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { setOverlayPassLayers } from './lit-layer';

export class OverlayPass {
  constructor(private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings) {}

  // 3D UI チャンネルのオブジェクトだけをキャンバスへ重ね描きする。camera は他のパスと同じ
  // インスタンスなので、layers.mask は呼び出し前の値へ必ず戻す。
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const savedMask = camera.layers.mask;
    setOverlayPassLayers(camera);

    // 合成パスが書いた色と深度を残したまま重ねる。
    this.renderer.autoClear = false;
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.overlay);
    this.renderer.render(scene, camera);
    this.renderer.autoClear = true;

    camera.layers.mask = savedMask;
  }
}
