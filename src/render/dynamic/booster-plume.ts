// ブースターの噴射炎。ノズル出口から船尾へ伸びる発光プルームを、段ごとに描く。
import * as THREE from 'three/webgpu';
import { Billboard } from '../billboard';
import { SchematicThrustCone } from '../schematic-thrust-cone';
import type { RenderStyle } from '../render-style';

const BOOSTER_PLUME_CORE_COLOR = 0xaee6ff;
const BOOSTER_PLUME_OUTER_COLOR = 0x4f9fff;
const BOOSTER_PLUME_CORE_OFFSET = 0.55;
const BOOSTER_PLUME_OUTER_OFFSET = 1.35;
const BOOSTER_PLUME_CORE_SIZE = 0.95;
const BOOSTER_PLUME_OUTER_SIZE = 2.2;

// 噴射炎1本の、そのフレームの表示入力。
interface BoosterPlumeSample {
  /** ノズル出口のワールド座標。 */
  readonly position: THREE.Vector3;
  /** ノズルから船尾へ向くワールド方向。ゼロベクトルは非表示扱い。 */
  readonly direction: THREE.Vector3;
  readonly intensity?: number;
  readonly scale?: number;
  readonly visible?: boolean;
}

/**
 * 一段分の発光プルーム。音源を持たないため、共有 WorldSfx の主推力ループを
 * 複数段が奪い合わない。sound は外側の gameplay/controller が必要な段だけ
 * 選んで制御する。
 */
export class BoosterPlume {
  private readonly core = new THREE.Object3D();
  private readonly outer = new THREE.Object3D();
  private readonly coreBillboard = new Billboard(BOOSTER_PLUME_CORE_COLOR);
  private readonly outerBillboard = new Billboard(BOOSTER_PLUME_OUTER_COLOR);
  private readonly schematicCone = new SchematicThrustCone();
  private disposed = false;

  // scene を渡すと、生成と同時にそこへ登録する。
  public constructor(scene?: THREE.Scene) {
    // Billboard のメッシュを、scene と親から一括で外せる Object3D の子にまとめる。
    this.core.name = 'booster-plume-core';
    this.outer.name = 'booster-plume-outer';
    this.core.add(this.coreBillboard.mesh);
    this.outer.add(this.outerBillboard.mesh);
    if (scene) this.addToScene(scene);
  }

  // 噴射炎を構成する表示物を scene へ登録する。
  private addToScene(scene: THREE.Scene): void {
    scene.add(this.core, this.outer, this.schematicCone.mesh);
  }

  // そのフレームの噴射炎を sample へ同期する。style が模式図なら、ビルボードの代わりに
  // 輪郭抽出へ拾われるコーンを出す。破棄後は何度呼んでもよい。
  public sync(sample: BoosterPlumeSample, cameraQuaternion: THREE.Quaternion, style: RenderStyle): void {
    if (this.disposed) return;
    // 見えない・向きの無いフレームは全部隠す。
    if (sample.visible === false || sample.direction.lengthSq() < 1e-12) {
      this.hide();
      return;
    }
    const direction = sample.direction.clone().normalize();
    const intensity = Math.max(0, sample.intensity ?? 1);
    const scale = Math.max(0, sample.scale ?? 1);

    // 模式図はコーンだけで描く。
    if (style === 'schematic') {
      this.coreBillboard.hide();
      this.outerBillboard.hide();
      this.schematicCone.sync(sample.position, direction, Math.min(1, intensity), scale);
      return;
    }
    this.schematicCone.hide();

    // 芯と外炎のビルボードを、ノズルから船尾方向へずらして置く。
    const corePosition = sample.position.clone().addScaledVector(direction, BOOSTER_PLUME_CORE_OFFSET);
    const outerPosition = sample.position.clone().addScaledVector(direction, BOOSTER_PLUME_OUTER_OFFSET);
    this.coreBillboard.sync(corePosition, BOOSTER_PLUME_CORE_SIZE * scale, intensity, cameraQuaternion);
    this.outerBillboard.sync(outerPosition, BOOSTER_PLUME_OUTER_SIZE * scale, intensity * 0.38, cameraQuaternion);
  }

  // 噴射炎の表示物をすべて隠す。
  public hide(): void {
    this.coreBillboard.hide();
    this.outerBillboard.hide();
    this.schematicCone.hide();
  }

  // 表示物を scene と親から外して破棄する。何度呼んでもよい。
  public dispose(scene?: THREE.Scene): void {
    if (this.disposed) return;
    this.disposed = true;
    if (scene) scene.remove(this.core, this.outer, this.schematicCone.mesh);
    // scene 引数が生成時の scene と違っても、現在の親から必ず外す。
    this.core.removeFromParent();
    this.outer.removeFromParent();
    this.schematicCone.dispose();
    this.coreBillboard.dispose();
    this.outerBillboard.dispose();
    this.core.clear();
    this.outer.clear();
  }
}

/** 複数ブースターのプルームを一回の同期で更新する小さな描画専用管理クラス。 */
export class BoosterPlumeSet {
  private readonly plumes: BoosterPlume[] = [];
  private disposed = false;

  // scene を渡すと、増やした噴射炎をそこへ登録する。
  public constructor(private readonly scene?: THREE.Scene) {}

  // samples の i 番目を i 本目の噴射炎へ同期する。破棄後は何度呼んでもよい。
  public sync(samples: readonly BoosterPlumeSample[], cameraQuaternion: THREE.Quaternion, style: RenderStyle): void {
    if (this.disposed) return;
    // 足りない本数を補ってから、samples より余った噴射炎は隠す。
    while (this.plumes.length < samples.length) {
      const plume = new BoosterPlume(this.scene);
      this.plumes.push(plume);
    }
    for (let i = 0; i < this.plumes.length; i++) {
      const sample = samples[i];
      if (sample) this.plumes[i]!.sync(sample, cameraQuaternion, style);
      else this.plumes[i]!.hide();
    }
  }

  // すべての噴射炎を破棄する。何度呼んでもよい。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const plume of this.plumes) plume.dispose(this.scene);
    this.plumes.length = 0;
  }
}
