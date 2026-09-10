// 爆発・マズルフラッシュなどの一時エフェクト。寿命のあいだ発生源の速度で移流しながら、
// ビルボードとして描かれる。
import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { addScaled } from '../../math/vec3';
import { flashResources } from '../../render/billboard';
import { InstancedPool } from '../../render/instanced-pool';
import { FloatingOrigin } from '../../render/camera/floating-origin';
import {
  BULLET_IMPACT_FLASH_COLOR, BULLET_IMPACT_FLASH_DURATION, BULLET_IMPACT_FLASH_SIZE0,
  BULLET_IMPACT_FLASH_SIZE1, DESTROY_FLASH1_DURATION, DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1,
  DESTROY_FLASH2_DURATION, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1, DESTROY_FLASH_COLOR_1,
  DESTROY_FLASH_COLOR_2, GAS_PUFF1_BRIGHTNESS, GAS_PUFF1_DURATION, GAS_PUFF1_SIZE0,
  GAS_PUFF1_SIZE1, GAS_PUFF2_BRIGHTNESS, GAS_PUFF2_DURATION, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1,
  GAS_PUFF_COLOR_1, GAS_PUFF_COLOR_2, MUZZLE_FLASH_COLOR, MUZZLE_FLASH_DURATION,
  MUZZLE_FLASH_SIZE0, MUZZLE_FLASH_SIZE1, PLASMA_IMPACT_FLASH_COLOR,
  PLASMA_IMPACT_FLASH_DURATION, PLASMA_IMPACT_FLASH_SIZE0, PLASMA_IMPACT_FLASH_SIZE1,
} from '../../render/vfx-style';

const ZOOM_MUZZLE_FLASH_SCALE = 0.02; // ズーム中のマズルフラッシュ最大不透明度倍率(完全には消さない)

const MAX_FLASHES = 128; // 同時に存在しうるフラッシュ(発砲・命中・撃破・ガス)の上限。超過分は描画されない

// 生存中のフラッシュ1件を InstancedPool へ積むための姿勢と色の置き場所。
const scratchTransform = new THREE.Object3D();
const scratchColor = new THREE.Color();

// 一時エフェクト1件。軌道速度で流れて見えないよう、時刻つきの state を持ち、発生源の
// 速度で現在の simTime まで移流させる。
interface FlashEffect {
  readonly baseColor: string | number;
  state: KinematicState;
  age: number;
  readonly duration: number;
  readonly size0: number;
  readonly size1: number;
  readonly peakBrightness: number; // 発生直後の最大の明るさ倍率
  readonly dimsInGunsight: boolean; // ガンサイトズーム中に減光するか
}

export class FlashEffects {
  private effects: FlashEffect[] = [];
  private readonly pool: InstancedPool;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;

  // フラッシュ用のインスタンス群を scene へ1つ置く。
  constructor(scene: THREE.Scene) {
    const { geometry, material } = flashResources();
    this.geometry = geometry;
    this.material = material;
    // Billboard の既定 renderOrder(5)に合わせる。
    this.pool = new InstancedPool(scene, geometry, material, MAX_FLASHES, true, 5);
  }

  // 経過時間を進めて各エフェクトを simTime まで移流させ、寿命切れのものを破棄する。
  update(dt: number, simTime: number): void {
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) return false;
      const s = fx.state;
      fx.state = kinematicState<'eci'>(simTime, addScaled(s.r, s.v, simTime - s.t), s.v);
      return true;
    });
  }

  // 生存中のフラッシュを現在の位置・寿命進捗・カメラ向きへ同期し、InstancedPool へ積む。
  // zoomActive はガンサイトズーム中かどうか(dimsInGunsight なフラッシュだけ減光する)。
  sync(fo: FloatingOrigin, activeCamera: THREE.Camera, zoomActive: boolean): void {
    this.pool.beginFrame();
    const camQuat = activeCamera.quaternion;
    for (const fx of this.effects) {
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      const zoomScale = zoomActive && fx.dimsInGunsight ? ZOOM_MUZZLE_FLASH_SCALE : 1;
      const brightness = fx.peakBrightness * (1 - t) * zoomScale;
      scratchTransform.position.copy(fo.RtoThreeV3(fx.state.r));
      scratchTransform.scale.setScalar(size);
      scratchTransform.quaternion.copy(camQuat);
      // **明るさは色に載せ、不透明度は 1 のままにする**(render/billboard.ts と同じ規約)。
      // 加算ブレンドでは 最終色 = テクスチャ × material.color × instanceColor なので、
      // 寿命による減衰も instanceColor 一本へ畳める。
      scratchColor.set(fx.baseColor).multiplyScalar(brightness);
      this.pool.push(scratchTransform, scratchColor);
    }
    this.pool.endFrame();
  }

  // flashResources() が個体ごとに新規生成する geometry/material を、プールと共に破棄する。
  dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.effects.length = 0;
  }

  // プラズマ弾命中フラッシュを生成する。
  spawnPlasmaFlash(state: KinematicState): void {
    this.spawnFlash(state,
      PLASMA_IMPACT_FLASH_SIZE0,
      PLASMA_IMPACT_FLASH_SIZE1,
      PLASMA_IMPACT_FLASH_DURATION,
      PLASMA_IMPACT_FLASH_COLOR);
  }

  // 実弾命中フラッシュを生成する。
  spawnBulletFlash(state: KinematicState): void {
    this.spawnFlash(state,
      BULLET_IMPACT_FLASH_SIZE0,
      BULLET_IMPACT_FLASH_SIZE1,
      BULLET_IMPACT_FLASH_DURATION,
      BULLET_IMPACT_FLASH_COLOR);
  }

  // 自機の撃破フラッシュ。芯と外殻の2枚を重ねる。
  spawnPlayerDestroyFlash(state: KinematicState): void {
    this.spawnFlash(state, DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1, DESTROY_FLASH1_DURATION, DESTROY_FLASH_COLOR_1);
    this.spawnFlash(state, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1, DESTROY_FLASH2_DURATION, DESTROY_FLASH_COLOR_2);
  }

  // 敵機の撃破フラッシュ。芯と外殻の2枚を、機体メッシュのスケール meshScale へ見合った
  // 大きさで重ねる。
  spawnEnemyDestroyFlash(state: KinematicState, meshScale: number): void {
    this.spawnFlash(
      state, DESTROY_FLASH1_SIZE0 * meshScale, DESTROY_FLASH1_SIZE1 * meshScale,
      DESTROY_FLASH1_DURATION, DESTROY_FLASH_COLOR_1);
    this.spawnFlash(
      state, DESTROY_FLASH2_SIZE0 * meshScale, DESTROY_FLASH2_SIZE1 * meshScale,
      DESTROY_FLASH2_DURATION, DESTROY_FLASH_COLOR_2);
  }

  // 気体が噴き出すエフェクト。大きさと色の違う2枚のパフを重ねる。
  spawnGasPuff(state: KinematicState): void {
    this.spawnFlash(state, GAS_PUFF1_SIZE0, GAS_PUFF1_SIZE1, GAS_PUFF1_DURATION, GAS_PUFF_COLOR_1, GAS_PUFF1_BRIGHTNESS);
    this.spawnFlash(state, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1, GAS_PUFF2_DURATION, GAS_PUFF_COLOR_2, GAS_PUFF2_BRIGHTNESS);
  }

  // マズルフラッシュを生成する(ガンサイトズーム中は減光される)。
  spawnMuzzleFlash(state: KinematicState): void {
    this.spawnFlash(
      state,
      MUZZLE_FLASH_SIZE0,
      MUZZLE_FLASH_SIZE1,
      MUZZLE_FLASH_DURATION,
      MUZZLE_FLASH_COLOR,
      1,
      true,
    );
  }

  // タンパク質の状態遷移フラッシュ。kind('critical' / 'dissociated' / その他)で色を分ける。
  spawnProteinStateFlash(state: KinematicState, kind: string): void {
    const color = kind === 'critical' ? 0xff3d88 : kind === 'dissociated' ? 0xa76dff : 0x59e7ff;
    this.spawnFlash(state, 2.5, 13, 0.34, color, 0.9, true);
  }

  // state は発生位置・発生源速度と、その位置が表す時刻(エポック)。積分前の座標から
  // 生成する場合も、その座標の時刻をそのまま渡せば取り残されない。
  spawnFlash(
    state: KinematicState,
    size0: number,
    size1: number,
    duration: number,
    color: string | number,
    peakBrightness = 1,
    dimsInGunsight = false,
  ): void {
    this.effects.push({
      baseColor: color,
      state, age: 0, duration, size0, size1, peakBrightness, dimsInGunsight,
    });
  }
}
