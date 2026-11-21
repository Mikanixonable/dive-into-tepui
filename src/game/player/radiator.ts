// 展開式ラジエーターの状態・放熱面・接触代理を、搭載 module の変換から求める。
import { pointVelocityLocal, type Attitude } from '../../physics/attitude';
import { qRotate } from '../../math/quat';
import { add, dot, v3, type Vec3 } from '../../math/vec3';
import { deployablePanelPoses } from '../../physics/ship-panel-layout';
import { RADIATOR_FOLD_COUNT, RADIATOR_PANEL_WIDTH, RADIATOR_SEGMENT_LENGTH } from '../../physics/player-shape';
import { kinematicState } from '../../physics/kinematic-state';
import type { Contact } from '../dynamic/entity/contact';
import { ContactProxy } from '../dynamic/contact-proxy';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';
import type { ShipAssembly } from '../ship/ship-assembly';
import { applyTransformToDirection, applyTransformToPoint } from '../ship/ship-assembly-transform';
import { DeployablePanelState } from './deployable-panel-state';
import {
  DeployablePanelSet,
  type RestoredDeployablePanel,
  type SerializedDeployablePanelSet,
} from './deployable-panel-set';

const RADIATOR_DEPLOY_TIME = 3.0; // 収納⇔全開にかかる時間 [s]
const RADIATOR_SOLAR_ABSORB = 0.15; // 日照面の太陽光吸収率
const RADIATOR_CONTACT_DEPLOY = 0.15; // これ以上展開していると被弾対象になる展開度
const RADIATOR_FOLD_MASS = 5; // 接触で押し合うときの、蛇腹1折りの質量 [kg]

export type RadiatorSide = 'up' | 'down';

export type SerializedRadiatorSystem = SerializedDeployablePanelSet;

type RadiatorContactReaction = (
  moduleId: string,
  other: EntityContactParticipant,
  contact: Contact,
  services: DynamicReactionServices,
) => void;

export class RadiatorSystem {
  private readonly panels: DeployablePanelSet;
  private readonly wear = new Map<string, number>();
  private readonly foldProxies = new Map<string, ContactProxy[]>();
  private activeFolds: readonly ContactProxy[] = [];

  public constructor(
    private readonly owner: EntityContactParticipant,
    private readonly onContact: RadiatorContactReaction,
    up = new DeployablePanelState(0, 0),
    down = new DeployablePanelState(0, 0),
    assembly: ShipAssembly | null = null,
    restoredPanels: readonly RestoredDeployablePanel[] = [],
  ) {
    this.panels = new DeployablePanelSet('radiator', 0, up, down, assembly, restoredPanels);
  }

  public static deserialize(
    serialized: SerializedRadiatorSystem,
    owner: EntityContactParticipant,
    onContact: RadiatorContactReaction,
    assembly: ShipAssembly | null = null,
  ): RadiatorSystem {
    const { up, down, restoredPanels } = DeployablePanelSet.restore(serialized, 0);
    return new RadiatorSystem(owner, onContact, up, down, assembly, restoredPanels);
  }

  // assembly の radiator module ID へ状態を結び付ける。互換スロット名（up/down）は接続順へ移譲する。
  public syncAssembly(assembly: ShipAssembly | null = null): void {
    if (assembly === null) this.panels.syncAssembly();
    else this.panels.syncAssembly(assembly);
  }

  public toggle(sideOrId: RadiatorSide | string): void {
    this.panels.toggle(sideOrId);
  }

  public setDeployed(sideOrId: RadiatorSide | string, deployed: boolean): void {
    this.panels.setDeployed(sideOrId, deployed);
  }

  public update(dt: number, wear: Readonly<Record<string, number>>): void {
    if (this.panels.assembly !== null) this.panels.syncAssembly();
    for (const [key, state] of this.panels) {
      state.update(dt, RADIATOR_DEPLOY_TIME);
      this.wear.set(key, Math.max(0, Math.min(1, wear[key] ?? 0)));
    }
  }

  // side の展開方向を残した互換 API。実際の配置は module local layout が所有する。
  public foldThetas(sideOrId: RadiatorSide | string): { even: number; odd: number } {
    const key = this.panels.key(sideOrId);
    const deploy = key === null ? 0 : this.panels.get(key)?.value ?? 0;
    const tilt = Math.PI / 2 + (15 * Math.PI / 180 - Math.PI / 2) * deploy;
    return { even: tilt, odd: -tilt };
  }

  private panelArea(key: string, totalCoolingRate: number): number {
    if ((this.wear.get(key) ?? 0) >= 1) return 0;
    const assembly = this.panels.assembly;
    if (assembly !== null) {
      const module = assembly.module(key);
      const definition = module === null ? null : assembly.definition(key);
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
    const transform = this.panels.assembly?.worldTransformOf(key);
    if (transform === null || transform === undefined) {
      return { center: layout.center, normal: qRotate(att.q, layout.normal) };
    }
    return {
      center: applyTransformToPoint(transform, layout.center),
      normal: qRotate(att.q, applyTransformToDirection(transform, layout.normal)),
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
    const assembly = this.panels.assembly;
    const module = assembly?.module(key);
    return module === null || module === undefined ? 1 : assembly?.definition(key)?.length ?? 1;
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
      const transform = this.panels.assembly?.worldTransformOf(key);
      for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        if (layout === undefined) continue;
        const assemblyOffset = transform === null || transform === undefined
          ? layout.center : applyTransformToPoint(transform, layout.center);
        const worldPos = add(shipR, qRotate(att.q, assemblyOffset));
        const worldVel = pointVelocityLocal(shipV, att, assemblyOffset);
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
    const key = this.panels.key(sideOrId);
    if (key === null) return v3(shipR.x, shipR.y, shipR.z);
    const layouts = deployablePanelPoses('radiator', this.moduleLength(key) / 2, this.panels.get(key)?.value ?? 0);
    const layout = layouts[layouts.length - 1];
    if (layout === undefined) return v3(shipR.x, shipR.y, shipR.z);
    const transform = this.panels.assembly?.worldTransformOf(key);
    const offset = transform === null || transform === undefined
      ? layout.center : applyTransformToPoint(transform, layout.center);
    return add(shipR, qRotate(att.q, offset));
  }

  // 放熱板を1枚でも積んでいるか。deployOf と同じ結び付けで判定する。
  public hasPanels(): boolean {
    return this.panels.hasPanels();
  }

  // side に放熱板を積んでいるか。deployOf と同じ結び付けで判定する。
  public hasPanel(side: RadiatorSide): boolean {
    return this.panels.hasPanel(side);
  }

  public deployOf(sideOrId: RadiatorSide | string): number {
    return this.panels.deployOf(sideOrId);
  }

  // 装備していない側の損耗は 0。deployOf と同じく「無いものは無い」とし、積んでいない
  // 放熱板を「損耗100%」の赤表示にしない。
  public wearOf(sideOrId: RadiatorSide | string): number {
    const key = this.panels.key(sideOrId);
    return key === null ? 0 : this.wear.get(key) ?? 0;
  }

  public serialize(): SerializedRadiatorSystem {
    return this.panels.serializeSet();
  }
}
