import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { ViewMode } from '../../render/view-mode';
import type { MarkerVisibility } from '../marker/marker-visibility';
import type { ObjectAuthoring, InspectedObject } from './inspected-object';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import { len, sub } from '../../math/vec3';
import { fmtDist, fmtSpeed } from '../../hud/utils';
import { relativeInfo } from '../orbit-info';
import { orbitRows } from './orbit-rows';
import { ENTITY_GLYPH } from '../marker/marker-identity';
import { shipMarkerSvg } from '../marker/marker-shapes';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { MenuCommon } from '../hud/windows/menu-actions';

const ENEMY_APPROACH_DIST = 2e5;

// Enemy の表示・一覧・検査面を戦闘 AI と分離する adapter。
export class EnemyInspection implements InspectedObject {
  public constructor(private readonly enemy: Enemy) {}
  public get id(): string { return this.enemy.id; }
  public get name(): string { return this.enemy.name; }
  public get gone(): boolean { return !this.enemy.motion.alive; }
  public get orbitState() { return this.enemy.motion.state; }
  public readonly glyph = ENTITY_GLYPH.enemyShip;
  public get glyphSvg(): string { return shipMarkerSvg(false); }
  public readonly listSection = 'enemy' as const;
  public readonly pickerGenre = '敵' as const;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;
  public markerItem(viewerPos: Parameters<Enemy['markerItem']>[0], pos: Parameters<Enemy['markerItem']>[1],
    vel: Parameters<Enemy['markerItem']>[2], view: ViewMode, _isActive: boolean): GroupedMarkerItem {
    return this.enemy.markerItem(viewerPos, pos, vel, view);
  }
  public posAt(displayTime: number) { return this.enemy.motion.stateAt(displayTime)?.r ?? null; }
  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(`enemy-${this.enemy.id}`); }
  public hitBodyByRay(ray: Parameters<Enemy['hitBodyByRay']>[0], pos: Parameters<Enemy['hitBodyByRay']>[1]): boolean {
    return this.enemy.hitBodyByRay(ray, pos);
  }
  public mapVisibility(policy: Parameters<Enemy['mapVisibility']>[0], viewer: OrbitingObject | null) {
    return this.enemy.mapVisibility(policy, viewer);
  }
  public listPriority(): number { return 0; }
  public listCounted(viewer: OrbitingObject | null, displayTime: number): boolean {
    if (viewer === null) return false;
    return len(sub(this.posAt(displayTime) ?? this.enemy.motion.state.r, viewer.motion.state.r)) < ENEMY_APPROACH_DIST;
  }
  public listDetail(_bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    if (viewer === null) return '';
    const d = len(sub(this.posAt(displayTime) ?? this.enemy.motion.state.r, viewer.motion.state.r));
    const label = this.listCounted(viewer, displayTime) ? '接近' : '距離';
    return `${label} ${fmtDist(d)} · ${fmtSpeed(len(sub(this.enemy.motion.state.v, viewer.motion.state.v)))}`;
  }
  public listSearchText(bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    return this.listDetail(bodies, viewer, displayTime);
  }
  public menuItems(_bodies: CelestialBodies, _viewer: OrbitingObject | null, navTargetId: string | null): readonly MenuItem<MenuAction>[] {
    return [MenuCommon.target(navTargetId === this.enemy.id), MenuCommon.focus(),
      MenuCommon.trajectoryLine(this.enemy.trajectoryLineVisible), MenuCommon.duplicate(),
      { label: '削除', act: 'delete' }, MenuCommon.cancel()];
  }
  public runMenu(act: MenuAction, _selection: ControlSelection, authoring: ObjectAuthoring | null): void {
    if (act === 'delete') this.enemy.motion.alive = false;
    else if (act === 'toggleTrajectoryLine') this.enemy.trajectoryLineVisible = !this.enemy.trajectoryLineVisible;
    else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.enemy.mapKind, this.enemy.motion.state);
  }
  public propertyRows(bodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number, _displayTime: number): readonly PropertyRow[] {
    const rel = viewer ? relativeInfo(viewer, this.enemy, bodies.celestialMotions, simTime) : null;
    const rows: PropertyRow[] = [{ key: 'hp', label: '装甲', value: `${Math.floor(this.enemy.hp)} / ${this.enemy.maxHp}` }];
    if (rel) rows.push({ key: 'dist', label: '距離', value: fmtDist(rel.dist) },
      { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing) },
      { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed), collapsible: true });
    rows.push(...orbitRows(this.enemy, bodies, simTime));
    if (rel) rows.push({ key: 'relinc', label: '相対傾斜 [AN/DN]',
      value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---', group: '軌道' });
    return rows;
  }
}
