import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { ViewMode } from '../view/view-mode';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import type { PropertyWindowOpener } from './property-window-opener';
import type { ObjectAuthoring, InspectedObject } from './inspected-object';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { ModularShip } from '../ship/modular-ship';
import { strongestAttractor } from '../../physics/attractor';
import { apsisAltitudes } from '../../physics/elements';
import { fmtDist, fmtEnergy } from '../../hud/utils';
import { fmtAmmoStatus } from '../hud/ammo-status';
import { MenuCommon } from '../hud/windows/menu-actions';
import { orbitRows } from './orbit-rows';
import { ENTITY_GLYPH } from '../marker/marker-identity';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { baseMarkerSvg, shipMarkerSvg } from '../marker/marker-shapes';
import { PLAN_EXECUTION_MODES, planExecutionLabel } from '../player/player-plan-settings';
import type { ShipModuleInstance } from '../ship/ship-module-instance';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Vec3 } from '../../math/vec3';
import type { MapVisibility } from '../map/visibility-policy';

const ROLE_LABEL = { ship: '船', base: '基地', material: '物資' } as const;

// モジュール船の表示・一覧・検査面をゲーム状態から分離する adapter。
export class ShipInspection implements InspectedObject {
  public constructor(private readonly ship: ModularShip) {}

  public get id(): string { return this.ship.id; }
  public get name(): string { return this.ship.name; }
  public get gone(): boolean { return !this.ship.motion.alive; }
  public get orbitState(): KinematicState { return this.ship.motion.state; }
  public get glyph(): string { return this.ship.capabilities.role === 'base' ? ENTITY_GLYPH.base : ENTITY_GLYPH.ship; }
  public get glyphSvg(): string { return this.ship.capabilities.role === 'base' ? baseMarkerSvg() : shipMarkerSvg(true); }
  public get listSection(): 'player' | 'base' { return this.ship.capabilities.role === 'base' ? 'base' : 'player'; }
  public get pickerGenre(): '自艦' | '基地' { return this.ship.capabilities.role === 'base' ? '基地' : '自艦'; }
  public readonly hiddenBehindBodies = true;
  public get onlyInFocusedSystem(): boolean { return this.ship.capabilities.role !== 'base'; }
  public get modules(): readonly ShipModuleInstance[] { return this.ship.assembly.modules; }
  public hasModule(moduleId: string): boolean { return this.ship.assembly.module(moduleId) !== null; }
  public setModuleDeployment(moduleId: string, deployed: boolean): void {
    const module = this.ship.assembly.module(moduleId);
    if (module === null || (module.kind !== 'radiator' && module.kind !== 'solar_panel')) return;
    const sameKind = this.modules.filter(candidate => candidate.kind === module.kind);
    const side = sameKind.findIndex(candidate => candidate.id === moduleId) === 0 ? 'up' : 'down';
    if (module.kind === 'radiator') this.ship.motion.radiator.setDeployed(side, deployed);
    else this.ship.motion.power.setDeployed(side, deployed);
    this.ship.assembly.setDeployment(moduleId, deployed ? 1 : 0);
  }
  public readonly rename = (name: string): void => { this.ship.rename(name); };
  public readonly onMapSelect = (windows: PropertyWindowOpener, x: number, y: number): void => {
    windows.openProperties(this, x, y);
  };
  public readonly onMapFocus = (selection: ControlSelection): void => selection.select(this.ship);

  public markerItem(viewerPos: Parameters<ModularShip['markerItem']>[0], pos: Parameters<ModularShip['markerItem']>[1],
    vel: Parameters<ModularShip['markerItem']>[2], view: ViewMode, isActive: boolean): GroupedMarkerItem {
    return this.ship.markerItem(viewerPos, pos, vel, view, isActive);
  }
  public posAt(displayTime: number): Vec3 | null { return this.ship.motion.stateAt(displayTime)?.r ?? null; }
  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(this.ship.markerKey); }
  public hitBodyByRay(ray: Parameters<ModularShip['hitBodyByRay']>[0], pos: Parameters<ModularShip['hitBodyByRay']>[1]): boolean {
    return this.ship.hitBodyByRay(ray, pos);
  }
  public mapVisibility(
    policy: Parameters<ModularShip['mapVisibility']>[0], viewer: OrbitingObject | null,
  ): MapVisibility {
    return this.ship.mapVisibility(policy, viewer);
  }
  public listCounted(): boolean { return false; }
  public listPriority(viewer: OrbitingObject | null): number { return this.ship === viewer ? -100 : 0; }
  public listDetail(celestialBodies: CelestialBodies): string {
    const center = strongestAttractor(this.ship.motion.state.r, celestialBodies.celestialMotions, this.ship.motion.state.t);
    const elements = this.ship.motion.orbitalElementsAround(center, this.ship.motion.state.t);
    const pe = elements ? fmtDist(apsisAltitudes(elements).pe) : '—';
    return `${ROLE_LABEL[this.ship.capabilities.role]} · HP ${Math.round(this.ship.hp)}/${Math.round(this.ship.maxHp)} · PE ${pe}`;
  }
  public listSearchText(celestialBodies: CelestialBodies): string { return this.listDetail(celestialBodies); }
  public menuItems(_bodies: CelestialBodies, viewer: OrbitingObject | null, navTargetId: string | null): readonly MenuItem<MenuAction>[] {
    const active = this.ship === viewer;
    return [
      MenuCommon.target(navTargetId === this.ship.id),
      { label: `軌道計画の実行: ${planExecutionLabel(this.ship.planExecution)}`, act: 'planExecCycle', keepOpen: true },
      active ? { label: '操作対象を解除', act: 'deactivate' } : { label: '操作対象にする', act: 'activate' },
      MenuCommon.focus(),
      ...(active ? [] : [MenuCommon.trajectoryLine(this.ship.trajectoryLineVisible)]),
      MenuCommon.duplicate(),
      ...(active ? [] : [{ label: '削除', act: 'delete' as const }]),
      MenuCommon.cancel(),
    ];
  }
  public runMenu(act: MenuAction, selection: ControlSelection, authoring: ObjectAuthoring | null): void {
    if (act === 'toggleTrajectoryLine') this.ship.trajectoryLineVisible = !this.ship.trajectoryLineVisible;
    else if (act === 'activate') selection.select(this.ship);
    else if (act === 'deactivate') selection.release(this.ship);
    else if (act === 'planExecCycle') {
      const index = PLAN_EXECUTION_MODES.indexOf(this.ship.planExecution);
      const nextMode = PLAN_EXECUTION_MODES[(index + 1) % PLAN_EXECUTION_MODES.length];
      if (nextMode !== undefined) this.ship.setPlanExecution(nextMode);
    } else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.ship.mapKind, this.ship.motion.state);
    else if (act === 'delete') selection.remove(this.ship);
  }
  public propertyRows(
    bodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    const dockRows: PropertyRow[] = this.ship.assembly.modules
      .filter(module => module.kind === 'dock' || module.kind === 'docking_port')
      .map(module => ({
        key: `dock-${module.id}`,
        label: `接舷部 ${module.id}`,
        value: module.hp <= 0 ? '全損' : this.ship.docks.status(this.ship.assembly, module.id),
        collapsible: true,
      }));
    return [
      { key: 'role', label: '役割', value: ROLE_LABEL[this.ship.capabilities.role] },
      { key: 'operated', label: '操作対象か', value: this.ship === viewer ? 'はい' : 'いいえ', collapsible: true },
      { key: 'follow', label: '計画実行', value: planExecutionLabel(this.ship.planExecution), collapsible: true },
      {
        key: 'hp', label: 'HULL',
        value: `${Math.round((this.ship.hp / Math.max(1, this.ship.maxHp)) * 100)}% · ${Math.floor(this.ship.hp)} / ${this.ship.maxHp}`,
        presentation: 'hero',
      },
      {
        key: 'temp', label: '温度', value: `${this.ship.motion.temperature.toFixed(0)} K`,
        presentation: 'major',
      },
      { key: 'power', label: '電力', value: fmtEnergy(this.ship.motion.power.chargeJ), presentation: 'major' },
      {
        key: 'ammo', label: '弾薬', value: fmtAmmoStatus(this.ship.roundsInMag, this.ship.magsLeft, this.ship.reloadTimer),
        presentation: 'major',
      },
      ...dockRows,
      ...orbitRows(this.ship, bodies, simTime),
    ];
  }
}