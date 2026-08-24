// 恒星の直射光を遮るメッシュ(艦艇・基地・デブリなど)を、恒星方向を向いた平行投影のライト空間へ
// 描き、線形深度をアトラスの 1 スロットへ書く。**天体の球と環はここに描かない** — 解析式で
// 厳密に解けるものを近似で二重に持たないため(lit-layer.ts の SUN_SHADOW_CASTER_LAYER)。
//
// 構造は protein-shadow-pass.ts を踏襲する(遮蔽器の箱の走査・ライトカメラの構成・レンダラ状態の
// 保存と復帰)。違いは 3 点 — 走査対象が userData ではなく層であること、出力が r32float の
// 線形深度であること、スロットの矩形をアトラス内に持つこと。
//
// スロットの near/far は塊へ密着させる。艦の自己影と天体が同じマップに同居しないので、
// light 空間の深度レンジは塊の差し渡し止まりになり、float32 の線形深度で桁が余る。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { clamp, positionView, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Uniform } from '../tsl-types';
import { SUN_SHADOW_CASTER_LAYER } from './lit-layer';
import type { SunLight } from './sun-light';

export const SHADOW_ATLAS_SIZE = 1024;

// 遮蔽器の外接球へ対して平行投影の枠をどれだけ広げるか。ライトカメラの向きによって箱の
// 見かけが回るので、外接球ぶんの余裕が要る。
const SLOT_MARGIN = 1.05;

// スロット 1 枚ぶんの、受け手が引く値。SunOcclusion がこれを読んでグラフを組む。
export type SunShadowSlot = {
  // 描画座標 → ライト空間クリップ。UV は xy だけを使う。
  readonly lightViewProjection: Mat4Uniform;
  // 描画座標 → ライト空間 view。深度は射影の規約(反転深度)に依らないこちらから測る。
  readonly lightView: Mat4Uniform;
  readonly near: FloatUniform;
  readonly far: FloatUniform;
  // このスロットが覆う描画座標の AABB。受け手はこの外なら遮蔽を引かない。
  readonly boundsMin: Vec3Uniform;
  readonly boundsMax: Vec3Uniform;
  // 1 texel が描画座標で何メートルか。バイアスとフィルタ半径の単位になる。
  readonly texelWorld: FloatUniform;
  // 0 ならこのスロットは空。
  readonly active: FloatUniform;
};

export class SunShadowAtlas {
  private readonly target: THREE.RenderTarget;
  private readonly depthMaterial: THREE.MeshBasicNodeMaterial;
  private readonly lightCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly slotUniforms: SunShadowSlot;
  private readonly box = new THREE.Box3();
  private readonly size = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3();
  private readonly clearColor = new THREE.Color();

  constructor(private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings) {
    // r32float はレンダーターゲットとしては描けるがフィルタできない。**サンプラを明示して
    // おかないと three が線形フィルタを要求し、パイプライン生成が落ちて画面が丸ごと黒くなる。**
    this.target = new THREE.RenderTarget(SHADOW_ATLAS_SIZE, SHADOW_ATLAS_SIZE, {
      format: THREE.RedFormat, type: THREE.FloatType, depthBuffer: true, samples: 0,
      magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
    });
    this.target.texture.name = 'sun-shadow-atlas';
    this.target.depthTexture = new THREE.DepthTexture(SHADOW_ATLAS_SIZE, SHADOW_ATLAS_SIZE, THREE.FloatType);

    this.slotUniforms = {
      lightViewProjection: uniform(new THREE.Matrix4()),
      lightView: uniform(new THREE.Matrix4()),
      near: uniform(0.1),
      far: uniform(10),
      boundsMin: uniform(new THREE.Vector3()),
      boundsMax: uniform(new THREE.Vector3()),
      texelWorld: uniform(1),
      active: uniform(0),
    };

    const linearDepth: FloatNode = clamp(
      positionView.z.negate().sub(this.slotUniforms.near)
        .div(this.slotUniforms.far.sub(this.slotUniforms.near)), 0, 1,
    );
    this.depthMaterial = new MeshBasicNodeMaterial({
      depthTest: true, depthWrite: true, transparent: false,
      blending: THREE.NoBlending, side: THREE.DoubleSide,
    });
    this.depthMaterial.colorNode = vec4(vec3(linearDepth), 1);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  get slot(): SunShadowSlot { return this.slotUniforms; }

  // 遮蔽器を包む 1 つの塊へスロットを割り当てて描く。enabled が偽か遮蔽器が1つも無いフレームは
  // active を落とすだけで、GPU 側の仕事はゼロになる。
  render(scene: THREE.Scene, sun: SunLight, enabled: boolean): void {
    this.slotUniforms.active.value = 0;
    if (!enabled || !this.collectCasters(scene) || !this.configureSlot(sun)) return;

    const savedOverride = scene.overrideMaterial;
    const savedTarget = this.renderer.getRenderTarget();
    const savedAutoClear = this.renderer.autoClear;
    const savedClearColor = this.renderer.getClearColor(this.clearColor).clone();
    const savedClearAlpha = this.renderer.getClearAlpha();
    try {
      this.renderer.autoClear = true;
      scene.overrideMaterial = this.depthMaterial;
      this.lightCamera.layers.set(SUN_SHADOW_CASTER_LAYER);
      // 空の texel は「最も遠い」= 1 で埋める。遮蔽器の居ない範囲が影にならないための初期値。
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.setRenderTarget(this.target);
      this.renderer.clear(true, true, false);
      // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
      this.gpu.beginPass(GPU_PASS.shadow);
      this.renderer.render(scene, this.lightCamera);
      this.slotUniforms.active.value = 1;
    } finally {
      scene.overrideMaterial = savedOverride;
      this.renderer.setRenderTarget(savedTarget);
      this.renderer.autoClear = savedAutoClear;
      this.renderer.setClearColor(savedClearColor, savedClearAlpha);
    }
  }

  // SUN_SHADOW_CASTER_LAYER に属するメッシュを包む描画座標の AABB を集める。1つも無ければ偽。
  //
  // **層を見るだけでは足りず、Mesh であることまで見る。** シーンルートは全チャンネルを持つ
  // (レンダラがカメラのチャンネルを絞る間も子を辿れるようにするため)ので、層だけで拾うと
  // ルートに当たり、Box3.expandByObject が子を再帰して天体ごと箱に入れてしまう。
  private collectCasters(scene: THREE.Scene): boolean {
    this.box.makeEmpty();
    this.expandVisibleCasters(scene);
    return !this.box.isEmpty();
  }

  // 見えている枝だけを辿って箱を広げる。traverse は visible を見ずに全体を辿るので、隠した艦が
  // 影だけ落とし続ける — レンダラ自身の走査と同じく、見えない枝はそこで打ち切る。
  private expandVisibleCasters(object: THREE.Object3D): void {
    if (!object.visible) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(SUN_SHADOW_CASTER_LAYER)) this.box.expandByObject(mesh);
    for (const child of object.children) this.expandVisibleCasters(child);
  }

  // 箱へ平行投影のライトカメラを合わせ、スロットの uniform を書く。恒星方向が取れなければ偽。
  private configureSlot(sun: SunLight): boolean {
    this.box.getCenter(this.center);
    this.box.getSize(this.size);
    this.lightDirection.copy(sun.position.value).sub(this.center);
    const distance = this.lightDirection.length();
    if (!(distance > 1e-6) || !Number.isFinite(distance)) return false;
    this.lightDirection.multiplyScalar(1 / distance);

    const radius = Math.max(this.size.length() * 0.5, 1);
    const extent = radius * SLOT_MARGIN;
    // カメラは箱の外へ、半径の 2 倍だけ引く。near/far を塊へ密着させるので、深度の分解能は
    // 塊の差し渡しだけで決まる。
    const eyeDistance = radius * 2;
    this.lightCamera.left = -extent;
    this.lightCamera.right = extent;
    this.lightCamera.top = extent;
    this.lightCamera.bottom = -extent;
    this.lightCamera.near = eyeDistance - radius * SLOT_MARGIN;
    this.lightCamera.far = eyeDistance + radius * SLOT_MARGIN;
    this.lightCamera.position.copy(this.center).addScaledVector(this.lightDirection, eyeDistance);
    // 視線と平行な up は姿勢を決められない。protein-shadow-pass.ts と同じ切り替えで避ける。
    this.lightCamera.up.set(
      Math.abs(this.lightDirection.y) < 0.9 ? 0 : 1,
      Math.abs(this.lightDirection.y) < 0.9 ? 1 : 0,
      0,
    );
    this.lightCamera.lookAt(this.center);
    this.lightCamera.updateProjectionMatrix();
    this.lightCamera.updateMatrixWorld(true);

    this.slotUniforms.near.value = this.lightCamera.near;
    this.slotUniforms.far.value = this.lightCamera.far;
    this.slotUniforms.lightView.value.copy(this.lightCamera.matrixWorldInverse);
    this.slotUniforms.lightViewProjection.value.multiplyMatrices(
      this.lightCamera.projectionMatrix, this.lightCamera.matrixWorldInverse,
    );
    // 受け手の判定に使う境界は、法線オフセットぶんだけ箱より広く取る — 箱の面ぎりぎりに
    // 居る受け手が、オフセット後に範囲外へ落ちて影を失うのを避ける。
    this.slotUniforms.texelWorld.value = (2 * extent) / SHADOW_ATLAS_SIZE;
    this.slotUniforms.boundsMin.value.copy(this.box.min).addScalar(-this.slotUniforms.texelWorld.value * 4);
    this.slotUniforms.boundsMax.value.copy(this.box.max).addScalar(this.slotUniforms.texelWorld.value * 4);
    return true;
  }

  dispose(): void {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}
