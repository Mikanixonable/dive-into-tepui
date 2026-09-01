// 軌道上の1点(近点・遠点・交点・再接近点)を指す、実体を持たない被選択物の共通形。
// 生成元が解いた位置と通過時刻を place 系メソッドで受け取り、マップのマーカーと右クリック
// メニューとして公開する。呼称・字形・示す値は具象が与える。
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { orbitPointLabel, type TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { fmtTime } from '../hud/utils';
import type { Vec3 } from '../../math/vec3';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { ProjectFn } from '../camera/camera-system';
import type { MapCommands } from '../pickable/map-commands';
import type { MapPickable } from '../pickable/map-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../hud/windows/property-window';
import type { MarkerManager } from './marker-manager';

export abstract class OrbitPointMarker implements MapPickable {
  public readonly mapState = null;
  public readonly mapGlyphSvg = null;
  public readonly listSection = null;
  public readonly pickerGenre = null;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public readonly mapRename = null;
  public readonly selectOnMap = null;
  public readonly onMapFocus = null;

  // 一覧・プロパティウィンドウに添える記号。
  public abstract readonly mapGlyph: string;
  // マップのマーカーへ描く字形。交点の昇降を描き分けるので mapGlyph とは別に持つ。
  protected abstract readonly markerGlyph: string;
  // マーカーの CSS クラス。
  protected abstract readonly markerClass: string;
  // マーカーへ添える略称。
  public abstract readonly markerLabel: string;
  // この点の呼称。解が無いフレームでも名乗れる文字列を返す。
  public abstract readonly name: string;
  // メニュー先頭の見出しに出す表題と副題。
  protected abstract readonly headerLabel: string;
  protected abstract readonly headerSubLabel: string;

  protected pos: Vec3 | null = null;
  protected time: number | null = null;
  protected owner: string | null = null;

  // id はマーカーのキーで、天体・実体と同じ名前空間に置く。
  protected constructor(public readonly id: string) {}

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  protected placeSolution(pos: Vec3 | null, time: number | null, ownerName: string | null): void {
    this.pos = pos;
    this.time = time;
    this.owner = ownerName;
  }

  public get gone(): boolean { return this.pos === null; }
  public get ownerName(): string | null { return this.owner; }
  public get mapTime(): number | null { return this.time; }

  // 生成元が解いた時刻の位置。
  public mapPosAt(): Vec3 | null { return this.pos; }
  // アイコンだけで示され、視線を通せる本体を持たない。
  public hitBodyByRay(): boolean { return false; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // マーカーを解いた位置へ置く。解けていないフレームと、天体に遮られたフレームは隠す。
  public sync(
    markers: MarkerManager, project: ProjectFn, cameraPos: Vec3,
    celestialBodies: readonly CelestialMotion[], pivot: number, overviewMode: boolean,
    timeLabel: TimeLabelSetting,
  ): void {
    if (this.pos === null) { markers.hide(this.id); return; }
    markers.setNodePosition(
      this.id, this.markerClass, this.markerGlyph, this.pos, project, cameraPos, celestialBodies, pivot,
      overviewMode, orbitPointLabel(this.markerLabel, this.time, timeLabel),
    );
  }

  // メニューに出す操作項目。
  public mapMenuItems(): readonly MenuItem<MenuAction>[] {
    return [
      { type: 'header', label: this.headerLabel, subLabel: this.headerSubLabel },
      MenuCommon.warp(),
      MenuCommon.addNode(),
      MenuCommon.focus(),
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。加速とノード追加は、通過時刻が求まっているフレームで効く。
  public runMapMenu(act: MenuAction, commands: MapCommands): void {
    const t = this.time;
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

  // プロパティウィンドウに出す行。示す値は具象が決める。
  public abstract mapPropertyRows(
    commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[];

  // 所属軌道の行。持ち主が分からないフレームは行を作らない。
  protected ownerRows(): PropertyRow[] {
    return this.owner === null ? [] : [{ key: 'owner', label: '所属軌道', value: this.owner }];
  }

  // 通過までの残り時間の行。通過時刻が解けていないフレームは行を作らない。
  protected passTimeRows(simTime: number): PropertyRow[] {
    return this.time === null
      ? []
      : [{ key: 'time', label: '通過まで', value: `T+${fmtTime(this.time - simTime)}` }];
  }

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
