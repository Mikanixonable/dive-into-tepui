import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, dot, v3 } from '../../physics/vec3';
import * as C from '../const';
import type { PowerSaveData } from '../save-data';

export type SolarSide = 'up' | 'down';

class Panel {
  deployTarget: 0 | 1 = 1; // 展開状態で開始
  deploy = 1;
}

export class PowerSystem {
  private charge = C.POWER_CAPACITY * 0.75; // 蓄電量 [J]、0..POWER_CAPACITY

  private readonly panels: Record<SolarSide, Panel> = { up: new Panel(), down: new Panel() };
  private readonly solarFolds: Record<SolarSide, THREE.Object3D[]>;

  // renderObject から左右の太陽電池パネルの蛇腹メッシュを名前で探す。見つからなければ例外を投げる。
  public constructor(renderObject: THREE.Object3D, saved?: PowerSaveData) {
    const collect = (side: SolarSide): THREE.Object3D[] => {
      const namePrefix = 'solar' + (side === 'up' ? 'Up' : 'Down');
      const found = Array.from({ length: 6 }, (_, i) =>
        renderObject.getObjectByName(`${namePrefix}Fold${i}`));
      if (found.some((f) => !f)) throw new Error(`solar fold objects not found in ship model`);
      return found as THREE.Object3D[];
    };
    this.solarFolds = { up: collect('up'), down: collect('down') };
    if (saved) this.charge = saved.charge;
  }

  // side のパネルの展開/収納目標を反転する。
  toggle(side: SolarSide): void {
    const p = this.panels[side];
    p.deployTarget = p.deployTarget === 0 ? 1 : 0;
  }

  // 毎フレーム呼ぶ。sunlit は sunlitFactor(0..1)、sunDir は太陽方向の単位ベクトル(world)。
  update(dt: number, sunlit: number, sunDir: Vec3, att: Attitude, ship: import('../game-entity/ship').Ship): void {
    // 展開度の更新
    const step = dt / C.RADIATOR_DEPLOY_TIME; // 同じ速度を使用
    for (const side of ['up', 'down'] as const) {
      const p = this.panels[side];
      if (p.deploy < p.deployTarget) p.deploy = Math.min(p.deployTarget, p.deploy + step);
      else if (p.deploy > p.deployTarget) p.deploy = Math.max(p.deployTarget, p.deploy - step);
    }

    const deployMult = (this.panels.up.deploy + this.panels.down.deploy) / 2;

    const normal = qRotate(att.q, v3(0, 1, 0));
    // 裏面(法線が太陽と反対を向く)では発電しないため負値を0に切り詰める
    const cosIncidence = Math.max(0, dot(normal, sunDir));
    // 展開度 deployMult を掛けて、収納時は発電しないようにする
    const basePower = ship.totalPowerGeneration > 0 ? ship.totalPowerGeneration : C.SOLAR_CONSTANT * C.SOLAR_PANEL_EFFICIENCY * C.SOLAR_PANEL_AREA;
    const power = basePower * cosIncidence * sunlit * deployMult;
    this.charge = Math.min(C.POWER_CAPACITY, this.charge + power * dt);
  }

  sync(): void {
    const STOW_TILT = Math.PI / 2;
    for (const side of ['up', 'down'] as const) {
      const deploy = this.panels[side].deploy;
      // deploy=0 で STOW_TILT、deploy=1 で 0 (完全に平ら)
      const psi = STOW_TILT * (1 - deploy);
      const sign = side === 'up' ? 1 : -1;
      const even = sign * psi;
      const odd = -sign * psi;

      const folds = this.solarFolds[side];
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
