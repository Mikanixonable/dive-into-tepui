// 太陽電池の蓄電状態と発電量を、搭載 module の姿勢・展開度から求める。
import type { Attitude } from '../../physics/attitude';
import { LOCAL_UP, qRotate } from '../../math/quat';
import { type Vec3, dot } from '../../math/vec3';
import { SOLAR_CONSTANT } from '../../physics/astronomical-unit';
import { deployablePanelPoses } from '../../physics/ship-panel-layout';
import { SOLAR_MODULE_GENERATION, SOLAR_PANEL_COUNT } from '../../physics/player-shape';
import type { ShipAssembly } from '../ship/ship-assembly';
import { applyTransformToDirection } from '../ship/ship-assembly-transform';
import { DeployablePanelState } from './deployable-panel-state';
import {
  DeployablePanelSet,
  type RestoredDeployablePanel,
  type SerializedDeployablePanelSet,
} from './deployable-panel-set';

export const POWER_CAPACITY = 1.5e6; // 蓄電容量 [J]
const LEGACY_SOLAR_AREA = 7.2; // assembly を持たない旧式の既定経路用 [m^2]
const LEGACY_SOLAR_EFFICIENCY = 0.25;

export type SolarSide = 'up' | 'down';

export interface SerializedPowerSystem extends SerializedDeployablePanelSet {
  readonly charge: number;
}

function validCharge(value: number | null): number | null {
  return value !== null && Number.isFinite(value)
    ? Math.max(0, Math.min(POWER_CAPACITY, value)) : null;
}

export class PowerSystem {
  private readonly panels: DeployablePanelSet;

  public constructor(
    private charge = POWER_CAPACITY * 0.75,
    up = new DeployablePanelState(1, 1),
    down = new DeployablePanelState(1, 1),
    assembly: ShipAssembly | null = null,
    restoredPanels: readonly RestoredDeployablePanel[] = [],
  ) {
    this.panels = new DeployablePanelSet('solar_panel', 1, up, down, assembly, restoredPanels);
  }

  public static deserialize(serialized: SerializedPowerSystem, assembly: ShipAssembly | null = null): PowerSystem {
    const { up, down, restoredPanels } = DeployablePanelSet.deserialize(serialized, 1);
    return new PowerSystem(
      validCharge(serialized.charge) ?? POWER_CAPACITY * 0.75,
      up,
      down,
      assembly,
      restoredPanels,
    );
  }

  // assembly の solar_panel module ID へ状態を結び付ける。互換スロット名（up/down）は接続順へ移譲する。
  public syncAssembly(assembly: ShipAssembly | null = null): void {
    if (assembly === null) this.panels.syncAssembly();
    else this.panels.syncAssembly(assembly);
  }

  public toggle(sideOrId: SolarSide | string): void {
    this.panels.toggle(sideOrId);
  }

  public setDeployed(sideOrId: SolarSide | string, deployed: boolean): void {
    this.panels.setDeployed(sideOrId, deployed);
  }

  // 太陽電池パドルを1枚でも積んでいるか。deployOf と同じ結び付けで判定する。
  public hasPanels(): boolean {
    return this.panels.hasPanels();
  }

  // side に太陽電池パドルを積んでいるか。deployOf と同じ結び付けで判定する。
  public hasPanel(side: SolarSide): boolean {
    return this.panels.hasPanel(side);
  }

  public deployOf(sideOrId: SolarSide | string): number {
    return this.panels.deployOf(sideOrId);
  }

  // 展開度と蓄電量を dt 秒ぶん進める。assembly があれば各 module のワールド法線を使う。
  public update(
    dt: number, sunlight: number, sunDir: Vec3, att: Attitude, installedGeneration?: number,
  ): void {
    const assembly = this.panels.assembly;
    if (assembly !== null) {
      this.panels.syncAssembly();
      let power = 0;
      for (const module of assembly.modules) {
        if (module.kind !== 'solar_panel' || module.hp <= 0) continue;
        const state = this.panels.get(module.id);
        const transform = assembly.worldTransformOf(module.id);
        const definition = assembly.definition(module.id);
        if (state === undefined || transform === null || definition === null) continue;
        state.update(dt, 3);
        const generation = definition.abilities.powerGeneration ?? SOLAR_MODULE_GENERATION;
        for (const panel of deployablePanelPoses('solar_panel', definition.length / 2, state.value)) {
          const normal = qRotate(att.q, applyTransformToDirection(transform, panel.normal));
          const incidence = Math.max(0, dot(normal, sunDir));
          power += (generation / SOLAR_PANEL_COUNT) * (sunlight / SOLAR_CONSTANT) * incidence * state.value;
        }
      }
      this.charge = Math.min(POWER_CAPACITY, this.charge + power * dt);
      return;
    }

    for (const state of this.panels.values()) state.update(dt, 3);
    const deployValues = [...this.panels.values()].map(panel => panel.value);
    const deploy = deployValues.length === 0
      ? 0 : deployValues.reduce((sum, value) => sum + value, 0) / deployValues.length;
    const normal = qRotate(att.q, LOCAL_UP);
    const incidence = Math.max(0, dot(normal, sunDir));
    const basePower = installedGeneration === undefined
      ? sunlight * LEGACY_SOLAR_EFFICIENCY * LEGACY_SOLAR_AREA
      : Math.max(0, installedGeneration) * (sunlight / SOLAR_CONSTANT);
    this.charge = Math.min(POWER_CAPACITY, this.charge + basePower * incidence * deploy * dt);
  }

  public get chargeRatio(): number { return this.charge / POWER_CAPACITY; }
  public get chargeJ(): number { return this.charge; }

  public serialize(): SerializedPowerSystem {
    return {
      charge: this.charge,
      ...this.panels.serializeSet(),
    };
  }
}
