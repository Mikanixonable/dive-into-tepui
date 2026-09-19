import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { ControlSelectionCommands } from '../control-selection-commands';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { ViewMode } from '../view/view-mode';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import type { PropertyWindowOpener } from './property-window-opener';
import type { ObjectAuthoring, InspectedObject } from './inspected-object';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { Player } from '../player/player';
import { strongestAttractor } from '../../physics/attractor';
import { apsisAltitudes } from '../../physics/elements';
import { fmtDist, fmtEnergy } from '../../hud/utils';
import { fmtAmmoStatus } from '../hud/ammo-status';
import { MenuCommon } from '../hud/windows/menu-actions';
import { orbitRows } from './orbit-rows';
import { ENTITY_GLYPH } from '../marker/marker-identity';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { shipMarkerSvg } from '../marker/marker-shapes';
import { PLAN_EXECUTION_MODES, planExecutionLabel } from '../player/player-plan-settings';
import type { Part } from '../dynamic/dynamic-entity/parts';

// Player の表示・一覧・検査面をゲーム状態から分離する adapter。
export class PlayerInspection implements InspectedObject {
  public constructor(private readonly player: Player) {}

  public get id(): string { return this.player.id; }
  public get name(): string { return this.player.name; }
  public get gone(): boolean { return !this.player.motion.alive; }
  public get orbitState() { return this.player.motion.state; }
  public readonly glyph = ENTITY_GLYPH.ship;
  public get glyphSvg(): string { return shipMarkerSvg(true); }
  public readonly listSection = 'player' as const;
  public readonly pickerGenre = '自艦' as const;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = true;
  public get parts(): readonly Part[] { return this.player.parts; }
  public hasPart(part: Part): boolean { return this.player.hasPart(part); }
  // ラジエーター・太陽電池板の part を展開 deployed へ切り替える。同種の先頭が上側、他が下側の翼。
  public setPartDeployment(part: Part, deployed: boolean): void {
    const sameType = this.parts.filter((candidate) => candidate.type === part.type);
    const side = sameType.indexOf(part) === 0 ? 'up' : 'down';
    if (part.type === 'radiator') this.player.motion.radiator.setDeployed(side, deployed);
    if (part.type === 'solar_panel') this.player.motion.power.setDeployed(side, deployed);
  }
  public readonly rename = (name: string): void => { this.player.rename(name); };
  // マップの左クリックで、自艦のプロパティウィンドウを (x, y) に開く。
  public readonly onMapSelect = (windows: PropertyWindowOpener, x: number, y: number): void => {
    windows.openProperties(this, x, y);
  };
  public readonly onMapFocus = (commands: ControlSelectionCommands): void => commands.select(this.player);

  // 表示位置 pos・速度 vel に置く自艦のマーカー項目。isActive は操作対象か。
  public markerItem(viewerPos: Parameters<Player['markerItem']>[0], pos: Parameters<Player['markerItem']>[1],
    vel: Parameters<Player['markerItem']>[2], view: ViewMode, isActive: boolean): GroupedMarkerItem {
    return this.player.markerItem(viewerPos, pos, vel, view, isActive);
  }
  public posAt(displayTime: number) { return this.player.motion.stateAt(displayTime)?.r ?? null; }
  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(`player-${this.player.id}`); }
  // 視線 ray が、pos に描かれた自艦の本体へ当たるか。
  public hitBodyByRay(ray: Parameters<Player['hitBodyByRay']>[0], pos: Parameters<Player['hitBodyByRay']>[1]): boolean {
    return this.player.hitBodyByRay(ray, pos);
  }
  // 表示トグル policy による自艦の表示可否。操作対象 viewer 自身は例外扱いになる。
  public mapVisibility(policy: Parameters<Player['mapVisibility']>[0], viewer: OrbitingObject | null) {
    return this.player.mapVisibility(policy, viewer);
  }
  public listCounted(): boolean { return false; }
  public listPriority(viewer: OrbitingObject | null): number { return this.player === viewer ? -100 : 0; }
  // 一覧の行に添える装甲と、最も強く引く天体まわりの近点高度。
  public listDetail(celestialBodies: CelestialBodies): string {
    const center = strongestAttractor(this.player.motion.state.r, celestialBodies.celestialMotions, this.player.motion.state.t);
    const elements = this.player.motion.orbitalElementsAround(center, this.player.motion.state.t);
    const pe = elements ? fmtDist(apsisAltitudes(elements).pe) : '—';
    return `HP ${Math.round(this.player.hp)}/${Math.round(this.player.maxHp)} · PE ${pe}`;
  }
  public listSearchText(celestialBodies: CelestialBodies): string { return this.listDetail(celestialBodies); }
  // 自艦の操作項目。viewer は操作対象で、自艦がそれかどうかで出す項目が変わる。
  public menuItems(
    _bodies: CelestialBodies, viewer: OrbitingObject | null, navTargetId: string | null,
    trajectoryLineShown: boolean,
  ): readonly MenuItem<MenuAction>[] {
    const active = this.player === viewer;
    // 線表示と削除は、操作対象でない艦にだけ出す。
    return [
      MenuCommon.target(navTargetId === this.player.id),
      { label: `軌道計画の実行: ${planExecutionLabel(this.player.planExecution)}`, act: 'planExecCycle', keepOpen: true },
      active ? { label: '操作対象を解除', act: 'deactivate' } : { label: '操作対象にする', act: 'activate' },
      MenuCommon.focus(),
      ...(active ? [] : [MenuCommon.trajectoryLine(trajectoryLineShown)]),
      MenuCommon.duplicate(),
      ...(active ? [] : [{ label: '削除', act: 'delete' as const }]),
      MenuCommon.cancel(),
    ];
  }
  // 操作対象の切り替え・計画実行モードの循環・複製・削除を実行する。
  public runMenu(act: MenuAction, selection: ControlSelection, authoring: ObjectAuthoring | null): void {
    if (act === 'activate') selection.select(this.player);
    else if (act === 'deactivate') selection.release(this.player);
    else if (act === 'planExecCycle') {
      const index = PLAN_EXECUTION_MODES.indexOf(this.player.planExecution);
      this.player.setPlanExecution(PLAN_EXECUTION_MODES[(index + 1) % PLAN_EXECUTION_MODES.length]!);
    } else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.player.mapKind, this.player.motion.state);
    else if (act === 'delete') selection.remove(this.player);
  }
  // 操作状態・計画実行・装甲・温度・電力・弾薬の行と、軌道の行。
  public propertyRows(bodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number, _displayTime: number): readonly PropertyRow[] {
    return [
      { key: 'operated', label: '操作対象か', value: this.player === viewer ? 'はい' : 'いいえ', collapsible: true },
      { key: 'follow', label: '計画実行', value: planExecutionLabel(this.player.planExecution), collapsible: true },
      { key: 'hp', label: '装甲', value: `${Math.floor(this.player.hp)} / ${this.player.maxHp}` },
      { key: 'temp', label: '温度', value: `${this.player.motion.temperature.toFixed(0)} K` },
      { key: 'power', label: '電力', value: fmtEnergy(this.player.motion.power.chargeJ) },
      { key: 'ammo', label: '弾薬', value: fmtAmmoStatus(this.player.roundsInMag, this.player.magsLeft, this.player.reloadTimer) },
      ...orbitRows(this.player, bodies, simTime),
    ];
  }
}
