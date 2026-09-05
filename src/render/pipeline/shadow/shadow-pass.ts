// G バッファの深度から画素ごとの描画座標を復元し、そこへ恒星の直射光がどれだけ届くかを 1 枚の
// 透過率へ書く。透過率を決めるのは shadow/ の源ごとのモジュールで、このパスはその関数を面の
// 写っている画素で評価してキャッシュする。
//
// **源ごとにフルスクリーン 1 枚を乗算合成で積む。** 影の合成は積なので、源ごとに 1 枚ずつ
// 積んでも答えは同じになる。源が増えてもマテリアルの組み合わせは増えず、そのフレームに影を
// 落とすものが無い源は描画命令ごと落とせる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { Fn, If, dot, float, length, max, normalize, screenUV, texture, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { octDecodeNormal, type GBufferPass } from '../gbuffer';
import { viewPositionAt } from '../view-ray';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node } from '../../tsl-types';
import type { BodyShadow } from './body-shadow';
import type { RingShadow } from './ring-shadow';
import type { CumulusShadow } from './cumulus-shadow';
import type { MeshShadow } from './mesh-shadow';
import { compileInto } from '../compile-into';

// 画素の覆う実寸を伸ばす入射角の余弦の下限。地平線では 0 へ落ちるので、伸びしろに天井を張る。
const MIN_INCIDENCE_COSINE = 0.05;

// 影の源 1 つぶんの、透過率のターゲットへ積む 1 枚。
interface ShadowSource {
  // このフレームに影を落とすものがあるか。偽なら描画命令は発行されない。
  casts(): boolean;
  readonly material: THREE.MeshBasicNodeMaterial;
}

// 透過率のノードを、ターゲットにいま入っている値へ掛け合わせるマテリアルに包む。面が写って
// いない画素は素通しの 1 を返す — そこに受け手は居ないので、影の計算ごと分岐で飛ばす
// (select では両辺が評価されて飛ばない)。
function multiplyingMaterial(covered: BoolNode, transmittance: FloatNode): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true,
  });
  // 乗算合成(src × dst)。
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.DstColorFactor;
  material.blendDst = THREE.ZeroFactor;
  material.colorNode = Fn(() => {
    const value = float(1).toVar();
    If(covered, () => { value.assign(transmittance); });
    return vec4(vec3(value), 1);
  })();
  return material;
}

export class ShadowPass {
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly sources: readonly ShadowSource[];
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;
  // 画面 1 px が 1 m 先で張る実寸 [m]。受け手までの視距離を掛けると、その画素が地表で覆う
  // 実寸になる。
  private readonly pixelAngle: FloatUniform;
  // クリア色の退避先。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // 透過率の書き込み先を確保し、深度から復元した位置で源ごとの透過率を評価するグラフを
  // 一度だけ組む。
  constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    bodyShadow: BodyShadow, ringShadow: RingShadow, cumulusShadow: CumulusShadow, meshShadow: MeshShadow,
    private readonly gpu: GpuTimings,
  ) {
    this.target = new THREE.RenderTarget(1, 1, {
      format: THREE.RedFormat, type: THREE.HalfFloatType, depthBuffer: false, samples: 0,
    });

    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    this.pixelAngle = uniform(0);

    const viewPos = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse);
    const worldPos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    // メッシュの影のバイアスが受け手の法線を要る。G バッファの法線は view 空間なので、
    // 位置と同じ行列で描画座標へ回す。
    const viewNormal = octDecodeNormal(texture(gbuffer.normalTexture, screenUV).rg);
    const meshNormal: Vec3Node = this.viewToWorld.mul(vec4(viewNormal, 0)).xyz;
    // 画素が受け手の面で覆う実寸。**面の傾きで伸びる** — 視線に対して寝ている面ほど 1 画素は
    // 広い範囲を覆うので、掠める構図では正対したときの何倍にもなる。
    const viewDistance = length(viewPos);
    const incidence = max(dot(normalize(viewPos).negate(), viewNormal), MIN_INCIDENCE_COSINE);
    const cumulusFootprint = this.pixelAngle.mul(viewDistance).div(incidence);
    const covered = gbuffer.covered();
    this.sources = [
      {
        casts: () => bodyShadow.casts(),
        material: multiplyingMaterial(covered, bodyShadow.transmittance(worldPos)),
      },
      {
        casts: () => ringShadow.casts(),
        material: multiplyingMaterial(covered, ringShadow.transmittance(worldPos)),
      },
      {
        casts: () => cumulusShadow.casts(),
        material: multiplyingMaterial(covered, cumulusShadow.transmittance(worldPos, cumulusFootprint)),
      },
      {
        casts: () => meshShadow.casts(),
        material: multiplyingMaterial(covered, meshShadow.transmittance(worldPos, meshNormal)),
      },
    ];
    this.quad = new QuadMesh();
  }

  get texture(): THREE.Texture { return this.target.texture; }

  // 影を落とすものがある源だけを、素通しの 1 へ順に掛け合わせる。camera は逆射影行列と
  // view→描画座標の行列を毎フレーム引き直すためだけに使う。
  render(camera: THREE.Camera, width: number, height: number): void {
    this.writeCamera(camera, width, height);

    // 乗算合成の土台は 1。クリア色は共有状態なので退避して戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.setRenderTarget(this.target);
    let cleared = false;
    for (const source of this.sources) {
      if (!source.casts()) continue;
      this.quad.material = source.material;
      this.renderer.autoClear = !cleared;
      cleared = true;
      // beginPass は render() 呼び出しごとに申告する。同じパスの複数回ぶんは計測側が足し合わせる。
      this.gpu.beginPass(GPU_PASS.occlusion);
      this.quad.render(this.renderer);
    }
    // 影を落とす源が 1 つも無いフレームでも、前のフレームの透過率を残さない。
    if (!cleared) this.renderer.clear(true, false, false);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  // 源ごとの全マテリアルを透過率ターゲットへ事前コンパイルする。
  async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    this.writeCamera(camera, width, height);
    for (const source of this.sources) {
      this.quad.material = source.material;
      await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
    }
  }

  // 書き込み先を画面へ合わせ、深度から位置を復元するための行列と画素の張る角を書き込む。
  private writeCamera(camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);
    // 射影行列の [1][1] は半画角の正接の逆数なので、画面の高さで割ると 1 画素の張る角になる。
    this.pixelAngle.value = 2 / (camera.projectionMatrix.elements[5]! * height);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    for (const source of this.sources) source.material.dispose();
  }
}
