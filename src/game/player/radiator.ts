// 展開式ラジエーターの状態・放熱面・接触代理を、搭載 module の変換から求める。
import type { Attitude } from '../../physics/attitude';
import { qRotate } from '../../math/quat';
import { add, cross, dot, v3, type Vec3 } from '../../math/vec3';
import { deployablePanelPoses } from '../../physics/ship-panel-layout';
import { RADIATOR_FOLD_COUNT, RADIATOR_PANEL_WIDTH, RADIATOR_SEGMENT_LENGTH } from '../../physics/player-shape';
import { kinematicState } from '../../physics/kinematic-state';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import { ContactProxy } from '../dynamic/contact-proxy';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';
import type { ShipAssembly } from '../ship/ship-assembly';
import { DeployablePanelState, type SerializedDeployablePanelState } from './deployable-panel-state';

export const RADIATOR_DEPLOY_TIME = 3.0; // 収納⇔全開にかかる時間 [s]
const RADIATOR_SOLAR_ABSORB = 0.15; // 日照面の太陽光吸収率
const RADIATOR_CONTACT_DEPLOY = 0.15; // これ以上展開していると被弾対象になる展開度
const RADIATOR_FOLD_MASS = 5; // 接触で押し合うときの、蛇腹1折りの質量 [kg]

export type RadiatorSide = 'up' | 'down';

export interface SerializedRadiatorPanel {
  readonly id: string;
  readonly state: SerializedDeployablePanelState;
}

export interface SerializedRadiatorSystem {
  readonly up: SerializedDeployablePanelState;
  readonly down: SerializedDeployablePanelState;
  readonly panels: readonly SerializedRadiatorPanel[] | null;
}

interface RestoredRadiatorPanel {
  readonly id: string;
  readonly state: DeployablePanelState;
}

type RadiatorContactReaction = (
  moduleId: string,
  other: EntityContactParticipant,
  contact: Contact,
  services: DynamicReactionServices,
) => void;

export class RadiatorSystem {
  private readonly panels = new Map<string, DeployablePanelState>();
  private readonly wear = new Map<string, number>();
  private readonly foldProxies = new Map<string, ContactProxy[]>();
  private activeFolds: readonly ContactProxy[] = [];
  private assemblyValue: ShipAssembly | null;

  public constructor(
    private readonly owner: EntityContactParticipant,
    private readonly onContact: RadiatorContactReaction,
    up = new DeployablePanelState(0, 0),
    down = new DeployablePanelState(0, 0),
    assembly: ShipAssembly | null = null,
    restoredPanels: readonly RestoredRadiatorPanel[] = [],
  ) {
    this.panels.set('up', up);
    this.panels.set('down', down);
    for (const panel of restoredPanels) {
      if (panel.id.length > 0) this.panels.set(panel.id, panel.state);
    }
    this.assemblyValue = assembly;
  }

  public static deserialize(
    serialized: SerializedRadiatorSystem,
    owner: EntityContactParticipant,
    onContact: RadiatorContactReaction,
    assembly: ShipAssembly | null = null,
  ): RadiatorSystem {
    const up = DeployablePanelState.deserialize(serialized.up) ?? new DeployablePanelState(0, 0);
    const down = DeployablePanelState.deserialize(serialized.down) ?? new DeployablePanelState(0, 0);
    const restoredPanels: RestoredRadiatorPanel[] = [];
    for (const panel of serialized.panels ?? []) {
      const state = DeployablePanelState.deserialize(panel.state);
      if (state !== null && panel.id.length > 0) restoredPanels.push({ id: panel.id, state });
    }
    return new RadiatorSystem(owner, onContact, up, down, assembly, restoredPanels);
  }

  // assembly の radiator module ID へ状態を結び付ける。互換スロット名（up/down）は接続順へ移譲する。
  public syncAssembly(assembly: ShipAssembly = this.assemblyValue as ShipAssembly): void {
    if (assembly === null || assembly === undefined) return;
    this.assemblyValue = assembly;
    const old = new Map(this.panels);
    const radiators = assembly.modules.filter(module => module.kind === 'radiator');
    const next = new Map<string, DeployablePanelState>();
    for (const [index, module] of radiators.entries()) {
      const legacy = index === 0 ? old.get('up') : index === 1 ? old.get('down') : undefined;
      const state = old.get(module.id) ?? legacy
        ?? new DeployablePanelState(module.deployed >= 0.5 ? 1 : 0, module.deployed);
      next.set(module.id, state);
    }
    this.panels.clear();
    for (const [id, state] of next) this.panels.set(id, state);
  }

  private key(sideOrId: RadiatorSide | string): string | null {
    if (this.panels.has(sideOrId)) return sideOrId;
    if (this.assemblyValue === null) return null;
    const radiators = this.assemblyValue.modules.filter(module => module.kind === 'radiator');
    const index = sideOrId === 'up' ? 0 : sideOrId === 'down' ? 1 : -1;
    return index >= 0 ? radiators[index]?.id ?? null : null;
  }

  public toggle(sideOrId: RadiatorSide | string): void {
    const key = this.key(sideOrId);
    if (key !== null) this.panels.get(key)?.toggle();
  }

  public setDeployed(sideOrId: RadiatorSide | string, deployed: boolean): void {
    const key = this.key(sideOrId);
    if (key !== null) this.panels.get(key)?.setTarget(deployed);
  }

  public update(dt: number, wear: Readonly<Record<string, number>>): void {
    if (this.assemblyValue !== null) this.syncAssembly();
    for (const [key, state] of this.panels) {
      state.update(dt, RADIATOR_DEPLOY_TIME);
      this.wear.set(key, Math.max(0, Math.min(1, wear[key] ?? 0)));
    }
  }

  // side の展開方向を残した互換 API。実際の配置は module local layout が所有する。
  public foldThetas(sideOrId: RadiatorSide | string): { even: number; odd: number } {
    const key = this.key(sideOrId);
    const deploy = key === null ? 0 : this.panels.get(key)?.value ?? 0;
    const tilt = Math.PI / 2 + (15 * Math.PI / 180 - Math.PI / 2) * deploy;
    return { even: tilt, odd: -tilt };
  }

  private panelArea(key: string, totalCoolingRate: number): number {
    if ((this.wear.get(key) ?? 0) >= 1) return 0;
    if (this.assemblyValue !== null) {
      const module = this.assemblyValue.module(key);
      const definition = module === null ? null : this.assemblyValue.definition(key);
      return definition?.abilities.radiationArea ?? 0;
    }
    return totalCoolingRate / 2;
  }

  public radiatingArea(totalCoolingRate: number): number {
    return [...this.panels].reduce((sum, [key, state]) => sum + this.panelArea(key, totalCoolingRate) * state.value, 0);
  }

  private worldPanel(key: string, layout: { readonly center: Vec3; readonly normal: Vec3 }, att: Attitude): {
    readonly center: Vec3;
    readonly normal: Vec3;
  } {
    const transform = this.assemblyValue?.worldTransformOf(key);
    if (transform === null || transform === undefined) {
      return { center: layout.center, normal: qRotate(att.q, layout.normal) };
    }
    return {
      center: add(transform.position, qRotate(transform.rotation, layout.center)),
      normal: qRotate(att.q, qRotate(transform.rotation, layout.normal)),
    };
  }

  public solarAbsorbArea(sunDir: Vec3, att: Attitude, totalCoolingRate: number): number {
    let area = 0;
    for (const [key, state] of this.panels) {
      const panelArea = this.panelArea(key, totalCoolingRate) / RADIATOR_FOLD_COUNT;
      for (const layout of deployablePanelPoses('radiator', this.moduleLength(key) / 2, state.value)) {
        const world = this.worldPanel(key, layout, att);
        area += RADIATOR_SOLAR_ABSORB * panelArea * Math.abs(dot(world.normal, sunDir));
      }
    }
    return area;
  }

  private moduleLength(key: string): number {
    const module = this.assemblyValue?.module(key);
    return module === null || module === undefined ? 1 : this.assemblyValue?.definition(key)?.length ?? 1;
  }

  public get contactFolds(): readonly ContactProxy[] { return this.activeFolds; }

  // shipR / shipV は assembly root の ECI 位置・速度。COMとの差は呼び出し側で除く。
  public placeContactFolds(shipR: Vec3, shipV: Vec3, att: Attitude, t: number): void {
    const result: ContactProxy[] = [];
    for (const [key, state] of this.panels) {
      if (state.value < RADIATOR_CONTACT_DEPLOY || (this.wear.get(key) ?? 0) >= 1) continue;
      const proxies = this.foldProxies.get(key) ?? [];
      this.foldProxies.set(key, proxies);
      const layouts = deployablePanelPoses('radiator', this.moduleLength(key) / 2, state.value);
      const transform = this.assemblyValue?.worldTransformOf(key);
      for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        if (layout === undefined) continue;
        const assemblyOffset = transform === null || transform === undefined
          ? layout.center : add(transform.position, qRotate(transform.rotation, layout.center));
        const worldPos = add(shipR, qRotate(att.q, assemblyOffset));
        const worldVel = add(shipV, qRotate(att.q, cross(att.w, assemblyOffset)));
        const known = proxies[i];
        const world = kinematicState<'eci'>(t, worldPos, worldVel);
        const fold = known ?? new ContactProxy(
          this.owner,
          'radiator-fold',
          RADIATOR_FOLD_MASS,
          Math.hypot(RADIATOR_SEGMENT_LENGTH / 2, RADIATOR_PANEL_WIDTH / 2),
          world,
          (other, contact, services) => this.onContact(key, other, contact, services),
        );
        if (known === undefined) proxies.push(fold);
        else fold.reset(world);
        result.push(fold);
      }
    }
    this.activeFolds = result;
  }

  public tipWorldPosition(sideOrId: RadiatorSide | string, shipR: Vec3, att: Attitude): Vec3 {
    const key = this.key(sideOrId);
    if (key === null) return v3(shipR.x, shipR.y, shipR.z);
    const layouts = deployablePanelPoses('radiator', this.moduleLength(key) / 2, this.panels.get(key)?.value ?? 0);
    const layout = layouts[layouts.length - 1];
    if (layout === undefined) return v3(shipR.x, shipR.y, shipR.z);
    const transform = this.assemblyValue?.worldTransformOf(key);
    const offset = transform === null || transform === undefined
      ? layout.center : add(transform.position, qRotate(transform.rotation, layout.center));
    return add(shipR, qRotate(att.q, offset));
  }

  public deployOf(sideOrId: RadiatorSide | string): number {
    const key = this.key(sideOrId);
    return key === null ? 0 : this.panels.get(key)?.value ?? 0;
  }

  public wearOf(sideOrId: RadiatorSide | string): number {
    const key = this.key(sideOrId);
    return key === null ? 1 : this.wear.get(key) ?? 0;
  }

  public serialize(): SerializedRadiatorSystem {
    const up = this.panels.get('up') ?? new DeployablePanelState(0, 0);
    const down = this.panels.get('down') ?? new DeployablePanelState(0, 0);
    const panels = [...this.panels]
      .filter(([id]) => id !== 'up' && id !== 'down')
      .map(([id, state]) => ({ id, state: state.serialize() }));
    return {
      up: up.serialize(),
      down: down.serialize(),
      panels: panels.length === 0 ? null : panels,
    };
  }
}
