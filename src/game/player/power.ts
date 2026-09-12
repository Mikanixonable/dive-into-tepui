// 自機の太陽電池パネル上下2枚の展開と、その発電による蓄電量を扱う。
import { Attitude } from '../../physics/attitude';
import { LOCAL_UP, qRotate } from '../../math/quat';
import { Vec3, dot } from '../../math/vec3';
import { SOLAR_CONSTANT } from '../../physics/srp';
import type { PowerSaveData } from '../save/save-data';
import { RADIATOR_DEPLOY_TIME } from './radiator';

export const POWER_CAPACITY = 1.5e6; // 蓄電容量 [J]
const SOLAR_PANEL_AREA = 7.2; // 発電面積 [m^2](左右2枚合計)
const SOLAR_PANEL_EFFICIENCY = 0.25; // 太陽光→電力の変換効率

export type SolarSide = 'up' | 'down';

class Panel {
  public deployTarget: 0 | 1 = 1; // 展開状態で開始
  public deploy = 1;
}

export class PowerSystem {
  private charge = POWER_CAPACITY * 0.75; // 蓄電量 [J]、0..POWER_CAPACITY

  private readonly panels: Record<SolarSide, Panel> = { up: new Panel(), down: new Panel() };

  // saved があれば蓄電量を復元する。
  public constructor(saved?: PowerSaveData) {
    if (saved && typeof saved.charge === 'number' && Number.isFinite(saved.charge)) {
      this.charge = Math.max(0, Math.min(POWER_CAPACITY, saved.charge));
    }
  }

  // side のパネルの展開/収納目標を反転する。
  public toggle(side: SolarSide): void {
    const p = this.panels[side];
    p.deployTarget = p.deployTarget === 0 ? 1 : 0;
  }

  // side の展開目標を明示的に設定する。
  public setDeployed(side: SolarSide, deployed: boolean): void {
    const p = this.panels[side];
    const target: 0 | 1 = deployed ? 1 : 0;
    if (p.deployTarget !== target) p.deployTarget = target;
  }

  // 毎フレーム呼ぶ。sunlit は sunlitFactor(0..1)、sunDir は太陽方向の単位ベクトル(world)。
  // installedGeneration は装備の発電量 [W]。省略時だけ既定のパネル性能を使い、0 は全損として扱う。
  public update(
    dt: number, sunlit: number, sunDir: Vec3, att: Attitude, installedGeneration?: number,
  ): void {
    // 展開度の更新
    const step = dt / RADIATOR_DEPLOY_TIME; // 放熱板と同じ展開速度
    for (const side of ['up', 'down'] as const) {
      const p = this.panels[side];
      if (p.deploy < p.deployTarget) p.deploy = Math.min(p.deployTarget, p.deploy + step);
      else if (p.deploy > p.deployTarget) p.deploy = Math.max(p.deployTarget, p.deploy - step);
    }

    const deployMult = (this.panels.up.deploy + this.panels.down.deploy) / 2;

    const normal = qRotate(att.q, LOCAL_UP);
    // 裏面(法線が太陽と反対を向く)では発電しないため負値を0に切り詰める
    const cosIncidence = Math.max(0, dot(normal, sunDir));
    // 展開度 deployMult を掛けて、収納時は発電しないようにする
    const basePower = installedGeneration === undefined
      ? SOLAR_CONSTANT * SOLAR_PANEL_EFFICIENCY * SOLAR_PANEL_AREA
      : typeof installedGeneration === 'number' && Number.isFinite(installedGeneration)
        ? Math.max(0, installedGeneration) : 0;
    const power = basePower * cosIncidence * sunlit * deployMult;
    this.charge = Math.min(POWER_CAPACITY, this.charge + power * dt);
  }

  // 蓄電率 0..1。
  public get chargeRatio(): number {
    return this.charge / POWER_CAPACITY;
  }

  // 蓄電量 [J]。
  public get chargeJ(): number {
    return this.charge;
  }

  public deployOf(side: SolarSide): number { return this.panels[side].deploy; }

  // 蓄電量の保存形。
  public serialize(): PowerSaveData {
    return { charge: this.charge };
  }
}
