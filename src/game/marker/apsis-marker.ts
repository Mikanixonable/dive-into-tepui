// 計画軌道の近点・遠点を指す、実体を持たない被選択物。生成元が解いた時刻の位置と通過時刻を
// 持ち、中心天体に応じた呼称(近地点/近月点…)とマーカー用の略称を答える。
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { getApsisLabelSpec, type OrbitLabelSpec } from '../hud/orbit/orbit-labels';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { fmtDist, fmtTime } from '../hud/utils';
import { len, sub, type Vec3 } from '../../math/vec3';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapCommands } from '../pickable/map-commands';
import type { MapPickable } from '../pickable/map-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../hud/windows/property-window';
import type { MarkerManager } from './marker-manager';

export class ApsisMarker implements MapPickable {
  public readonly kind = 'apsis';
  public readonly id: string;
  public readonly mapState = null;

  private pos: Vec3 | null = null;
  private time: number | null = null;
  private centerId: string | null = null;
  private owner: string | null = null;

  // apsis はこのマーカーが指す極値。近点・遠点それぞれに1つずつ作る。
  public constructor(private readonly apsis: 'pe' | 'ap') {
    this.id = apsis === 'pe' ? 'apsisPe' : 'apsisAp';
  }

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  public place(pos: Vec3 | null, time: number | null, centerId: string | null, ownerName: string | null): void {
    this.pos = pos;
    this.time = time;
    this.centerId = centerId;
    this.owner = ownerName;
  }

  public get gone(): boolean { return this.pos === null; }
  public get name(): string { return this.spec.nameJa; }
  public get markerLabel(): string { return this.spec.short; }
  public get ownerName(): string | null { return this.owner; }
  public get mapTime(): number | null { return this.time; }

  // 中心天体に応じた呼称。中心が定まらないフレームは総称(近点/遠点)になる。
  private get spec(): OrbitLabelSpec { return getApsisLabelSpec(this.apsis, this.centerId ?? ''); }

  // 生成元が解いた時刻の位置。
  public mapPosAt(): Vec3 | null { return this.pos; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // メニューに出す操作項目。ヘッダーには中心天体に応じた呼称を出す。
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

  // 所属軌道・中心天体の表面からの高度・通過までの残り時間。位置が解けていなければ行は無く、
  // 中心天体が引けないフレームは高度が落ちる。
  public mapPropertyRows(
    _commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const pos = this.mapPosAt();
    if (pos === null) return [];
    const rows: PropertyRow[] = [];
    if (this.owner !== null) rows.push({ key: 'owner', label: '所属軌道', value: this.owner });
    // 高度の基準は、place で受け取った中心天体の表面。
    const center = this.centerId === null ? null : (celestialSystem.find(this.centerId)?.motion ?? null);
    if (center !== null) {
      const alt = len(sub(pos, center.positionAt(simTime))) - center.def.radius;
      rows.push({ key: 'alt', label: '高度', value: fmtDist(alt) });
    }
    if (this.time !== null) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(this.time - simTime)}` });
    return rows;
  }

  public readonly mapRename = null;

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
