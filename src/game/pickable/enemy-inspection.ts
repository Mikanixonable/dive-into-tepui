import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { ViewMode } from '../view/view-mode';
import type { MarkerVisibility } from '../../marker/marker-visibility';
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
import { ENTITY_GLYPH } from '../marker/marker-identity';
import { shipMarkerSvg } from '../marker/marker-shapes';
import { MenuCommon } from '../hud/windows/menu-actions';

// 一覧で「接近」として数える、viewer からの距離 [m]。
const ENEMY_APPROACH_DIST = 2e5;

// タンパク質の敵が差し出す、戦闘状態の読み出しと部位マーカー。
export interface EnemyProteinInspection {
  combatReadout(): ProteinCombatReadout;
  siteMarkers(displayPos: Vec3, attitude: Quat): readonly ProteinSiteMarker[];
}

// 敵の表示・一覧・検査に必要なインターフェース。
export interface EnemyInspectionSource extends OrbitingObject {
  readonly name: string;
  readonly mapKind: DynamicEntityKind;
  readonly motion: DynamicMotion;
  readonly hp: number;
  readonly maxHp: number;
  readonly pickable: boolean;
  readonly proteinInspection: EnemyProteinInspection | null;
  markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3, view: ViewMode): GroupedMarkerItem;
  hitBodyByRay(ray: Ray, pos: Vec3): boolean;
  mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility;
}

// Enemy の表示・一覧・検査面を戦闘 AI と分離する adapter。
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

  // 表示位置 pos・速度 vel に置く敵のマーカー項目。
  public markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3, view: ViewMode, _isActive: boolean): GroupedMarkerItem {
    return this.source.markerItem(viewerPos, pos, vel, view);
  }

  // 表示時刻の敵の位置。運動が求まらない時刻は null。
  public posAt(displayTime: number): Vec3 | null {
    return this.source.motion.stateAt(displayTime)?.r ?? null;
  }

  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(`enemy-${this.source.id}`); }
  public hitBodyByRay(ray: Ray, pos: Vec3): boolean { return this.source.hitBodyByRay(ray, pos); }
  // 表示トグル policy による敵の表示可否。
  public mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility {
    return this.source.mapVisibility(policy, viewer);
  }
  public listPriority(): number { return 0; }

  // viewer から ENEMY_APPROACH_DIST 未満にいれば接近として数える。viewer が無ければ false。
  public listCounted(viewer: OrbitingObject | null, displayTime: number): boolean {
    if (viewer === null) return false;
    return len(sub(this.posAt(displayTime) ?? this.source.motion.state.r, viewer.motion.state.r)) < ENEMY_APPROACH_DIST;
  }

  // viewer からの距離(接近中は「接近」と冠する)と相対速度。viewer が無ければ空文字。
  public listDetail(_bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    if (viewer === null) return '';
    const distance = len(sub(this.posAt(displayTime) ?? this.source.motion.state.r, viewer.motion.state.r));
    const label = this.listCounted(viewer, displayTime) ? '接近' : '距離';
    return `${label} ${fmtDist(distance)} · ${fmtSpeed(len(sub(this.source.motion.state.v, viewer.motion.state.v)))}`;
  }

  // 検索は行の補助表示と同じ文字列に照合する。
  public listSearchText(bodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string {
    return this.listDetail(bodies, viewer, displayTime);
  }

  // 敵の操作項目(ターゲット・フォーカス・線表示・複製・削除)。
  public menuItems(
    _bodies: CelestialBodies, _viewer: OrbitingObject | null, navTargetId: string | null,
    trajectoryLineShown: boolean,
  ): readonly MenuItem<MenuAction>[] {
    return [MenuCommon.target(navTargetId === this.source.id), MenuCommon.focus(),
      MenuCommon.trajectoryLine(trajectoryLineShown), MenuCommon.duplicate(),
      { label: '削除', act: 'delete' }, MenuCommon.cancel()];
  }

  // 削除または複製を行う。
  public runMenu(act: MenuAction, _selection: ControlSelection, authoring: ObjectAuthoring | null): void {
    if (act === 'delete') this.source.motion.kill();
    else if (act === 'duplicate') authoring?.openObjectPlacerForDuplicate(this.source.mapKind, this.source.motion.state);
  }

  // 装甲・viewer との相対距離と速度・軌道・相対傾斜の行。viewer が無ければ相対の行を省く。
  public propertyRows(
    bodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number, _displayTime: number,
  ): readonly PropertyRow[] {
    const rel = viewer ? relativeInfo(viewer, this.source, bodies.celestialMotions, simTime) : null;
    const rows: PropertyRow[] = [];
    // 戦闘判断で最初に読む距離・接近速度を主状態へ上げる。
    if (rel) rows.push(
      { key: 'dist', label: '距離', value: fmtDist(rel.dist), presentation: 'hero' },
      { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing), presentation: 'major' },
    );
    rows.push({
      key: 'hp', label: '装甲', value: `${Math.floor(this.source.hp)} / ${this.source.maxHp}`,
      presentation: 'major',
    });
    if (rel) rows.push(
      { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed), presentation: 'detail' },
    );
    rows.push(...orbitRows(this.source, bodies, simTime));
    if (rel) rows.push({ key: 'relinc', label: '相対傾斜 [AN/DN]',
      value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---', group: '軌道' });
    return rows;
  }
}

// entity がタンパク質の検査面を持てばそれを返す。持たなければ null。
export function proteinInspectionOf(entity: DynamicEntity): EnemyProteinInspection | null {
  const candidate = entity as DynamicEntity & Partial<Pick<EnemyInspectionSource, 'proteinInspection'>>;
  return candidate.proteinInspection ?? null;
}
