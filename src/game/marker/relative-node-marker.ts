// 自機軌道上の、ターゲットの軌道面に対する昇交点・降交点と、ターゲットへの再接近点を指す、
// 実体を持たない被選択物。生成元が解いた時刻の位置と通過時刻を持つ。
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { ORBIT_ELEMENT_LABELS, type OrbitLabelSpec } from '../hud/orbit/orbit-labels';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { fmtTime } from '../hud/utils';
import { ORBIT_POINT_GLYPH } from './marker-identity';
import type { Vec3 } from '../../math/vec3';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapCommands } from '../pickable/map-commands';
import type { MapPickable } from '../pickable/map-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../hud/windows/property-window';
import type { MarkerManager } from './marker-manager';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { ProjectFn } from '../camera/camera-system';
import { orbitPointLabel, type TimeLabelSetting } from '../hud/orbit/calendar-ticks';

// 交点種別ごとの、一覧やマーカーで名乗る呼称と、軌道要素としてのラベル。
const RELATIVE_NODE_LABELS = {
  an: { name: 'AN', spec: ORBIT_ELEMENT_LABELS.an, glyph: ORBIT_POINT_GLYPH.ascendingNode },
  dn: { name: 'DN', spec: ORBIT_ELEMENT_LABELS.dn, glyph: ORBIT_POINT_GLYPH.descendingNode },
  ca: { name: '再接近点', spec: ORBIT_ELEMENT_LABELS.ca, glyph: ORBIT_POINT_GLYPH.closestApproach },
} as const;

export class RelativeNodeMarker implements MapPickable {
  public readonly id: string;
  public readonly name: string;
  public readonly markerLabel: string;
  // マップのマーカーへ描く字形。一覧の記号(mapGlyph)とは別で、交点の昇降を描き分ける。
  private readonly markerGlyph: string;
  public readonly mapState = null;
  public readonly mapGlyph = ORBIT_POINT_GLYPH.ascendingNode;
  public readonly mapGlyphSvg = null;
  public readonly listSection = null;
  public readonly pickerGenre = null;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;

  private readonly spec: OrbitLabelSpec;
  private pos: Vec3 | null = null;
  private time: number | null = null;
  private owner: string | null = null;
  // 交点を定める相手(航法ターゲット)の表示名。
  private targetName: string | null = null;

  // node はこのマーカーが指す交点。昇交点・降交点・再接近点それぞれに1つずつ作る。
  public constructor(node: 'an' | 'dn' | 'ca') {
    this.id = `nav-${node}`;
    this.name = RELATIVE_NODE_LABELS[node].name;
    this.spec = RELATIVE_NODE_LABELS[node].spec;
    this.markerLabel = this.spec.short;
    this.markerGlyph = RELATIVE_NODE_LABELS[node].glyph;
  }

  // △▽✧ マーカーを解いた位置へ置く。解けていないフレームと、天体に遮られたフレームは隠す。
  public sync(
    markers: MarkerManager, project: ProjectFn, cameraPos: Vec3,
    celestialBodies: readonly CelestialMotion[], pivot: number, overviewMode: boolean,
    timeLabel: TimeLabelSetting,
  ): void {
    if (this.pos === null) { markers.hide(this.id); return; }
    markers.setNodePosition(
      this.id, 'mk-node', this.markerGlyph, this.pos, project, cameraPos, celestialBodies, pivot,
      overviewMode, orbitPointLabel(this.markerLabel, this.time, timeLabel),
    );
  }

  // 今フレームの解を記録する。求まらなかったフレームは位置と時刻に null を渡す。
  public place(pos: Vec3 | null, time: number | null, ownerName: string | null, targetName: string | null): void {
    this.pos = pos;
    this.time = time;
    this.owner = ownerName;
    this.targetName = targetName;
  }

  public get gone(): boolean { return this.pos === null; }
  public get ownerName(): string | null { return this.owner; }
  public get mapTime(): number | null { return this.time; }

  // 生成元が解いた時刻の位置。
  public mapPosAt(): Vec3 | null { return this.pos; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // メニューに出す操作項目。ヘッダーには交点の正式な呼称を出す。
  public mapMenuItems(): readonly MenuItem<MenuAction>[] {
    return [
      { type: 'header', label: this.spec.nameJa, subLabel: this.spec.nameEn },
      MenuCommon.warp(),
      MenuCommon.addNode(),
      MenuCommon.focus(),
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。加速とノード追加は、通過時刻が求まっているフレームで効く。
  public runMapMenu(act: MenuAction, commands: MapCommands): void {
    const t = this.mapTime;
    if (act === 'warp') {
      if (t !== null) commands.warpTo(t);
    } else if (act === 'addNode') {
      if (t !== null) commands.addNodeAt(t);
    } else if (act === 'focus') {
      commands.focus(this.id, this.name);
    } else if (act === 'target') {
      commands.toggleNavTarget(this.id, this.name);
    }
  }

  // 所属軌道・交点を定める相手の名前・通過までの残り時間。
  public mapPropertyRows(
    _commands: MapCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const rows: PropertyRow[] = [];
    if (this.owner !== null) rows.push({ key: 'owner', label: '所属軌道', value: this.owner });
    rows.push({ key: 'target', label: '対象', value: this.targetName ?? '対象' });
    if (this.time !== null) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(this.time - simTime)}` });
    return rows;
  }

  public readonly mapRename = null;

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
