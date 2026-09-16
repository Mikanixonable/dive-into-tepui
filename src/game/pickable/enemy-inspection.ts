import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { ViewMode } from '../../render/view-mode';
import type { MarkerVisibility } from '../../render/marker/marker-visibility';
import type { ObjectAuthoring, InspectedObject } from './inspected-object';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import type { Quat } from '../../math/quat';
import type { Ray } from '../../math/ray';
import type { Vec3 } from '../../math/vec3';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import type { ProteinCombatReadout } from '../protein/protein-schema';
import type { ProteinSiteMarker } from '../../render/dynamic/dynamic-entity/protein-enemy-view';
import { len, sub } from '../../math/vec3';
import { fmtDist, fmtSpeed } from '../../hud/utils';
import { relativeInfo } from '../orbit-info';
import { orbitRows } from './orbit-rows';
import { ENTITY_GLYPH } from '../../render/marker/marker-identity';
import { shipMarkerSvg } from '../marker/marker-shapes';
import { MenuCommon } from '../hud/windows/menu-actions';

const ENEMY_APPROACH_DIST = 2e5;

// Enemyの内部全体ではなく、表示・一覧・検査が必要とする面だけを受け取る契約。
export interface EnemyProteinInspection {
  combatReadout(): ProteinCombatReadout;
  siteMarkers(displayPos: Vec3, attitude: Quat): readonly ProteinSiteMarker[];
}

export interface EnemyInspectionSource extends OrbitingObject {
  readonly name: string;
  readonly mapKind: DynamicEntityKind;
  readonly motion: DynamicMotion;
  readonly hp: number;
  readonly maxHp: number;
  readonly pickable: boolean;
  trajectoryLineVisible: boolean;
  readonly proteinInspection: EnemyProteinInspection | null;
  markerItem(viewerPos: Vec3, pos: Vec3, vel: Vec3, view: ViewMode): GroupedMarkerItem;
  hitBodyByRay(ray: Ray, pos: Vec3): boolean;
  mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility;
}

// Enemyの表示・一覧・検査面を戦闘AIと分離するadapter。
export class EnemyInspection implements InspectedObject {
  public constructor(private readonly source: EnemyInspectionSource) {}
  public get id(): string { return this.source.id; }
  public get name(): string { return this.source.name; }
  public get gone(): boolean { return !this.source.motion.alive; }
  public get orbitState() { return this.source.motion.state; }
  public readonly glyph = ENTITY_GLYPH.enemyShip;
  public get glyphSvg(): string { return shipMarkerSvg(false); }
  public readonly listSection = 'enemy' as const;
  public readonly pickerGenre = '敵' as const;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;

  public get protein(): EnemyProteinInspection | null { return this.source.proteinInspection; }

  public markerItem(viewerPos: Vec3, pos: Vec3, vel: Vec3, view: ViewMode, _isActive: boolean): GroupedMarkerItem {
    return this.source.markerItem(viewerPos, pos, vel, view);
  }

  public posAt(displayTime: number): Vec3 | null {
    return this.source.motion.stateAt(displayTime)?.r ?? null;
  }

  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(`enemy-${this.source.id}`); }
  public hitBodyByRay(ray: Ray, pos: Vec3): boolean { return this.source.hitBodyByRay(ray, pos); }
  public mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility {
    return this.source.mapVisibility(policy, viewer);
  }
  public listPriority(): number { return 0; }

  public listCounted(viewer: OrbitingObject | null, displayTime: number): boolean {
    if (viewer === null) return false;
    return len(sub(this.posAt(displayTime) ?? this.source.motion.state.r, viewer.motion.state.r)) < ENEMY_APPROACH_DIST;
  }

  public listDetail(_bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    if (viewer === null) return '';
    const distance = len(sub(this.posAt(displayTime) ?? this.source.motion.state.r, viewer.motion.state.r));
    const label = this.listCounted(viewer, displayTime) ? '接近' : '距離';
    return `${label} ${fmtDist(distance)} · ${fmtSpeed(len(sub(this.source.motion.state.v, viewer.motion.state.v)))}`;
  }

  public listSearchText(bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    return this.listDetail(bodies, viewer, displayTime);
  }

  public menuItems(_bodies: CelestialBodies, _viewer: OrbitingObject | null, navTargetId: string | null): readonly MenuItem<MenuAction>[] {
    return [MenuCommon.target(navTargetId === this.source.id), MenuCommon.focus(),
      MenuCommon.trajectoryLine(this.source.trajectoryLineVisible), MenuCommon.duplicate(),
      { label: '削除', act: 'delete' }, MenuCommon.cancel()];
  }

  public runMenu(act: MenuAction, _selection: ControlSelection, authoring: ObjectAuthoring | null): void {
    if (act === 'delete') this.source.motion.alive = false;
    else if (act === 'toggleTrajectoryLine') this.source.trajectoryLineVisible = !this.source.trajectoryLineVisible;
    else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.source.mapKind, this.source.motion.state);
  }

  public propertyRows(
    bodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number, _displayTime: number,
  ): readonly PropertyRow[] {
    const rel = viewer ? relativeInfo(viewer, this.source, bodies.celestialMotions, simTime) : null;
    const rows: PropertyRow[] = [{ key: 'hp', label: '装甲', value: `${Math.floor(this.source.hp)} / ${this.source.maxHp}` }];
    if (rel) rows.push(
      { key: 'dist', label: '距離', value: fmtDist(rel.dist) },
      { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing) },
      { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed), collapsible: true },
    );
    rows.push(...orbitRows(this.source, bodies, simTime));
    if (rel) rows.push({ key: 'relinc', label: '相対傾斜 [AN/DN]',
      value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---', group: '軌道' });
    return rows;
  }
}

// 具象ProteinEnemyを知らずに、検査面からProtein能力だけを取得する。
export function proteinInspectionOf(entity: DynamicEntity): EnemyProteinInspection | null {
  const candidate = entity as DynamicEntity & Partial<Pick<EnemyInspectionSource, 'proteinInspection'>>;
  return candidate.proteinInspection ?? null;
}
