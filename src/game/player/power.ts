// 自機の太陽電池パネル上下2枚の展開と、その発電による蓄電量を扱う。
import { Attitude } from '../../physics/attitude';
import { LOCAL_UP, qRotate } from '../../math/quat';
import { Vec3, dot } from '../../math/vec3';
import { SOLAR_CONSTANT } from '../../physics/astronomical-unit';
import { RADIATOR_DEPLOY_TIME } from './radiator';
import { DeployablePanelState, type SerializedDeployablePanelState } from './deployable-panel-state';

export const POWER_CAPACITY = 1.5e6; // 蓄電容量 [J]
const SOLAR_PANEL_AREA = 7.2; // 発電面積 [m^2](左右2枚合計)
const SOLAR_PANEL_EFFICIENCY = 0.25; // 太陽光→電力の変換効率

export type SolarSide = 'up' | 'down';

export interface SerializedPowerSystem {
  readonly charge: number;
  readonly up: SerializedDeployablePanelState;
  readonly down: SerializedDeployablePanelState;
}

export class PowerSystem {
  private readonly panels: Record<SolarSide, DeployablePanelState>;

  // charge は蓄電量 [J]、0..POWER_CAPACITY。up・down は各側のパネルの展開状態で、省いた側は展開から
  // 始める。
  public constructor(
    private charge = POWER_CAPACITY * 0.75,
    up = new DeployablePanelState(1, 1),
    down = new DeployablePanelState(1, 1),
  ) {
    this.panels = { up, down };
  }

  // 直列化した蓄電量とパネルの展開状態から復元する。有限でない蓄電量は既定へ落とし、容量の範囲へ収める。
  public static deserialize(serialized: SerializedPowerSystem): PowerSystem {
    const { charge, up, down } = serialized;
    return new PowerSystem(
      typeof charge === 'number' && Number.isFinite(charge) ? Math.max(0, Math.min(POWER_CAPACITY, charge)) : undefined,
      up ? DeployablePanelState.deserialize(up) : undefined,
      down ? DeployablePanelState.deserialize(down) : undefined,
    );
  }

  // side のパネルの展開/収納目標を反転する。
  public toggle(side: SolarSide): void {
    const p = this.panels[side];
    p.toggle();
  }

  // side の展開目標を明示的に設定する。
  public setDeployed(side: SolarSide, deployed: boolean): void {
    const p = this.panels[side];
    p.setTarget(deployed);
  }

  // 毎フレーム呼ぶ。sunlight は日照率込みの太陽光の放射照度 [W/m²]、sunDir は太陽方向の単位ベクトル(world)。
  // installedGeneration は太陽定数の光を正面に受けたときの装備の発電量 [W]。省略時だけ既定のパネル
  // 性能を使い、0 は装備の全損として扱う。
  public update(
    dt: number, sunlight: number, sunDir: Vec3, att: Attitude, installedGeneration?: number,
  ): void {
    // 展開度の更新
    for (const side of ['up', 'down'] as const) {
      this.panels[side].update(dt, RADIATOR_DEPLOY_TIME);
    }

    const deployMult = (this.panels.up.value + this.panels.down.value) / 2;

    const normal = qRotate(att.q, LOCAL_UP);
    // 裏面(法線が太陽と反対を向く)では発電しないため負値を0に切り詰める
    const cosIncidence = Math.max(0, dot(normal, sunDir));
    // 展開度 deployMult を掛けて、収納時は発電しないようにする
    const basePower = installedGeneration === undefined
      ? sunlight * SOLAR_PANEL_EFFICIENCY * SOLAR_PANEL_AREA
      : Math.max(0, installedGeneration) * (sunlight / SOLAR_CONSTANT);
    const power = basePower * cosIncidence * deployMult;
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

  public deployOf(side: SolarSide): number { return this.panels[side].value; }

  // 蓄電量とパネルの展開状態の直列化した形。
  public serialize(): SerializedPowerSystem {
    return { charge: this.charge, up: this.panels.up.serialize(), down: this.panels.down.serialize() };
  }
}
