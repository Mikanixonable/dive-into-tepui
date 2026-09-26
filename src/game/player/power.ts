// 太陽電池の蓄電状態と発電量を、搭載 module の姿勢・展開度から求める。
import type { Attitude } from '../../physics/attitude';
import { LOCAL_UP, qRotate } from '../../math/quat';
import { type Vec3, dot } from '../../math/vec3';
import { SOLAR_CONSTANT } from '../../physics/astronomical-unit';
import { deployablePanelPoses } from '../../physics/ship-panel-layout';
import { SOLAR_MODULE_GENERATION, SOLAR_PANEL_COUNT } from '../../physics/player-shape';
import type { ShipAssembly } from '../ship/ship-assembly';
import { DeployablePanelState, type SerializedDeployablePanelState } from './deployable-panel-state';

export const POWER_CAPACITY = 1.5e6; // 蓄電容量 [J]
const LEGACY_SOLAR_AREA = 7.2; // assembly を持たない旧式の既定経路用 [m^2]
const LEGACY_SOLAR_EFFICIENCY = 0.25;

export type SolarSide = 'up' | 'down';

export interface SerializedPowerPanel {
  readonly id: string;
  readonly state: SerializedDeployablePanelState;
}

export interface SerializedPowerSystem {
  readonly charge: number;
  readonly up: SerializedDeployablePanelState;
  readonly down: SerializedDeployablePanelState;
  readonly panels: readonly SerializedPowerPanel[] | null;
}

interface RestoredPowerPanel {
  readonly id: string;
  readonly state: DeployablePanelState;
}

function validCharge(value: number | null): number | null {
  return value !== null && Number.isFinite(value)
    ? Math.max(0, Math.min(POWER_CAPACITY, value)) : null;
}

export class PowerSystem {
  private readonly panels = new Map<string, DeployablePanelState>();
  private assemblyValue: ShipAssembly | null;

  public constructor(
    private charge = POWER_CAPACITY * 0.75,
    up = new DeployablePanelState(1, 1),
    down = new DeployablePanelState(1, 1),
    assembly: ShipAssembly | null = null,
    restoredPanels: readonly RestoredPowerPanel[] = [],
  ) {
    this.panels.set('up', up);
    this.panels.set('down', down);
    for (const panel of restoredPanels) {
      if (panel.id.length > 0) this.panels.set(panel.id, panel.state);
    }
    this.assemblyValue = assembly;
  }

  public static deserialize(serialized: SerializedPowerSystem, assembly: ShipAssembly | null = null): PowerSystem {
    const up = DeployablePanelState.deserialize(serialized.up) ?? new DeployablePanelState(1, 1);
    const down = DeployablePanelState.deserialize(serialized.down) ?? new DeployablePanelState(1, 1);
    const restoredPanels: RestoredPowerPanel[] = [];
    for (const panel of serialized.panels ?? []) {
      const state = DeployablePanelState.deserialize(panel.state);
      if (state !== null && panel.id.length > 0) restoredPanels.push({ id: panel.id, state });
    }
    return new PowerSystem(
      validCharge(serialized.charge) ?? POWER_CAPACITY * 0.75,
      up,
      down,
      assembly,
      restoredPanels,
    );
  }

  // assembly の solar_panel module ID へ状態を結び付ける。互換スロット名（up/down）は接続順へ移譲する。
  public syncAssembly(assembly: ShipAssembly = this.assemblyValue as ShipAssembly): void {
    if (assembly === null || assembly === undefined) return;
    this.assemblyValue = assembly;
    const old = new Map(this.panels);
    const solar = assembly.modules.filter(module => module.kind === 'solar_panel');
    const next = new Map<string, DeployablePanelState>();
    for (const [index, module] of solar.entries()) {
      const legacy = index === 0 ? old.get('up') : index === 1 ? old.get('down') : undefined;
      const state = old.get(module.id) ?? legacy
        ?? new DeployablePanelState(module.deployed >= 0.5 ? 1 : 0, module.deployed);
      next.set(module.id, state);
    }
    this.panels.clear();
    for (const [id, state] of next) this.panels.set(id, state);
  }

  private key(sideOrId: SolarSide | string): string | null {
    if (this.panels.has(sideOrId)) return sideOrId;
    if (this.assemblyValue === null) return null;
    const solar = this.assemblyValue.modules.filter(module => module.kind === 'solar_panel');
    const index = sideOrId === 'up' ? 0 : sideOrId === 'down' ? 1 : -1;
    return index >= 0 ? solar[index]?.id ?? null : null;
  }

  public toggle(sideOrId: SolarSide | string): void {
    const key = this.key(sideOrId);
    if (key !== null) this.panels.get(key)?.toggle();
  }

  public setDeployed(sideOrId: SolarSide | string, deployed: boolean): void {
    const key = this.key(sideOrId);
    if (key !== null) this.panels.get(key)?.setTarget(deployed);
  }

  public deployOf(sideOrId: SolarSide | string): number {
    const key = this.key(sideOrId);
    return key === null ? 0 : this.panels.get(key)?.value ?? 0;
  }

  // 展開度と蓄電量を dt 秒ぶん進める。assembly があれば各 module のワールド法線を使う。
  public update(
    dt: number, sunlight: number, sunDir: Vec3, att: Attitude, installedGeneration?: number,
  ): void {
    if (this.assemblyValue !== null) {
      this.syncAssembly();
      let power = 0;
      for (const module of this.assemblyValue.modules) {
        if (module.kind !== 'solar_panel' || module.hp <= 0) continue;
        const state = this.panels.get(module.id);
        const transform = this.assemblyValue.worldTransformOf(module.id);
        const definition = this.assemblyValue.definition(module.id);
        if (state === undefined || transform === null || definition === null) continue;
        state.update(dt, 3);
        const generation = definition.abilities.powerGeneration ?? SOLAR_MODULE_GENERATION;
        for (const panel of deployablePanelPoses('solar_panel', definition.length / 2, state.value)) {
          const normal = qRotate(att.q, qRotate(transform.rotation, panel.normal));
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
    const up = this.panels.get('up') ?? new DeployablePanelState(1, 1);
    const down = this.panels.get('down') ?? new DeployablePanelState(1, 1);
    const panels = [...this.panels]
      .filter(([id]) => id !== 'up' && id !== 'down')
      .map(([id, state]) => ({ id, state: state.serialize() }));
    return {
      charge: this.charge,
      up: up.serialize(),
      down: down.serialize(),
      panels: panels.length === 0 ? null : panels,
    };
  }
}
