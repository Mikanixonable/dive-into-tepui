import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, dot, v3 } from '../../physics/vec3';
import * as C from '../const';
import type { PowerSaveData } from '../save-data';
import { SOLAR_OBJECT_NAMES } from '../../render/ships';
import { DeployablePanel, findFoldMeshes, foldThetas, foldTilt, stepDeploy, type PanelSide } from './deployable-panel';
import type { Vessel } from './vessel';

export type SolarSide = PanelSide;

// 完全に平らな全開時の折り角(0)。太陽電池パドルはラジエーターと違い、展開しきったときに
// 蛇腹の折り目が残らない。
const SOLAR_DEPLOY_TILT = 0;
const STOW_TILT = Math.PI / 2;

export class PowerSystem {
  private charge = C.POWER_CAPACITY * 0.75; // 蓄電量 [J]、0..POWER_CAPACITY

  private readonly panels: Record<SolarSide, DeployablePanel> = { up: new DeployablePanel(1), down: new DeployablePanel(1) };
  // 実際にメッシュが見つかった side だけ値を持つ。自由設計では太陽電池パドルが1枚だけの
  // こともあり、その場合は反対側が丸ごと欠損する。
  private readonly solarFolds: Partial<Record<SolarSide, THREE.Object3D[]>> = {};

  // renderObject から左右の太陽電池パネルの蛇腹メッシュを名前で探す。メッシュが見つからない側
  // (太陽電池パドルを1枚しか積んでいない設計)は欠損のまま進む。
  public constructor(renderObject: THREE.Object3D, saved?: PowerSaveData) {
    for (const side of ['up', 'down'] as const) {
      const namePrefix = SOLAR_OBJECT_NAMES[side];
      const found = findFoldMeshes(renderObject, namePrefix, C.RADIATOR_FOLD_COUNT);
      if (!found) continue;
      this.solarFolds[side] = found;
    }
    if (saved) this.charge = saved.charge;
  }

  // side に実際のメッシュ(=太陽電池パドルのパーツ)があるか。
  hasSide(side: SolarSide): boolean {
    return side in this.solarFolds;
  }

  // side のパネルの展開/収納目標を反転する。メッシュが無い side は何もしない。
  toggle(side: SolarSide): void {
    if (!this.hasSide(side)) return;
    const p = this.panels[side];
    p.deployTarget = p.deployTarget === 0 ? 1 : 0;
  }

  // 毎フレーム呼ぶ。sunlit は sunlitFactor(0..1)、sunDir は太陽方向の単位ベクトル(world)。
  update(dt: number, sunlit: number, sunDir: Vec3, att: Attitude, ship: Vessel): void {
    for (const side of ['up', 'down'] as const) stepDeploy(this.panels[side], dt, C.SOLAR_PANEL_DEPLOY_TIME);

    // メッシュの無い side は分子・分母から外す — 反対側1枚だけの機体なら、その1枚の展開度が
    // そのまま deployMult になる。
    const present = (['up', 'down'] as const).filter((side) => this.hasSide(side));
    const deployMult = present.length > 0
      ? present.reduce((sum, side) => sum + this.panels[side].deploy, 0) / present.length
      : 0;

    const normal = qRotate(att.q, v3(0, 1, 0));
    // 裏面(法線が太陽と反対を向く)では発電しないため負値を0に切り詰める
    const cosIncidence = Math.max(0, dot(normal, sunDir));
    // 展開度 deployMult を掛けて、収納時は発電しないようにする
    const power = ship.totalPowerGeneration * cosIncidence * sunlit * deployMult;
    this.charge = Math.min(C.POWER_CAPACITY, this.charge + power * dt);
  }

  sync(): void {
    for (const side of ['up', 'down'] as const) {
      const { even, odd } = foldThetas(side, foldTilt(this.panels[side].deploy, STOW_TILT, SOLAR_DEPLOY_TILT));
      const folds = this.solarFolds[side];
      if (!folds) continue;
      for (let i = 0; i < folds.length; i++) {
        const fold = folds[i];
        if (!fold) continue;
        // 縦方向に蛇腹にするため Z 軸回転を使用
        fold.rotation.z = i === 0 ? even : (i % 2 === 1 ? odd - even : even - odd);
      }
    }
  }

  // HUD 表示用。0..1。
  get chargeRatio(): number {
    return this.charge / C.POWER_CAPACITY;
  }

  // HUD 表示用。蓄電量そのもの [J]。
  get chargeJ(): number {
    return this.charge;
  }

  setChargeJ(val: number): void {
    this.charge = Math.max(0, Math.min(C.POWER_CAPACITY, val));
  }

  addChargeJ(delta: number): number {
    const prev = this.charge;
    this.setChargeJ(this.charge + delta);
    return this.charge - prev;
  }

  deployOf(side: SolarSide): number { return this.panels[side].deploy; }

  serialize(): PowerSaveData {
    return { charge: this.charge };
  }
}
