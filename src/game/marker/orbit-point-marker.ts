// 軌道上の1点(近点・遠点・交点・再接近点)を指す、実体を持たない被選択物の共通形。
// 生成元が解いた位置と通過時刻を place 系メソッドで受け取り、マップのマーカーと右クリック
// メニューとして公開する。呼称・字形・示す値は具象が与える。
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { orbitPointLabel, type TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { fmtTime } from '../../hud/utils';
import type { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { ProjectFn } from '../../math/projection';
import { isOccluded } from '../../physics/occlusion';
import { pointPlacement } from './marker-placement';
import type { ControlSelection } from '../control-selection';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import type { PlanEditor } from '../plan/plan-editor';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';

export abstract class OrbitPointMarker implements ObjectPickable {
  public readonly orbitState = null;
  public readonly glyphSvg = null;
  public readonly listSection = null;
  public readonly pickerGenre = null;
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public readonly rename = null;
  public readonly onMapSelect = null;
  public readonly onMapFocus = null;

  // マップのマーカー・一覧・プロパティウィンドウに描く字形。
  public abstract readonly glyph: string;
  // マーカーの CSS クラス。
  protected abstract readonly markerClass: string;
  // マーカーへ添える略称。
  public abstract readonly markerLabel: string;
  // マーカーが重なったときに残す度合い。
  protected abstract readonly markerPriority: number;
  // この点の呼称。解が無いフレームでも名乗れる文字列を返す。
  public abstract readonly name: string;
  // メニュー先頭の見出しに出す表題と副題。
  protected abstract readonly headerLabel: string;
  protected abstract readonly headerSubLabel: string;

  protected pos: Vec3 | null = null;
  protected time: number | null = null;
  protected owner: string | null = null;
  // この点を出す理由が無くなったか。解が求まらないだけのフレーム(pos が null)とは別物で、
  // 一時的に位置を失った点は消滅として扱わない。
  private retired = false;

  // id はマーカーのキーで、天体・実体と同じ名前空間に置く。
  protected constructor(public readonly id: string) {}

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  protected placeSolution(pos: Vec3 | null, time: number | null, ownerName: string | null): void {
    this.pos = pos;
    this.time = time;
    this.owner = ownerName;
    this.retired = false;
  }

  // この点を出す理由が無くなったことを記録する(対象の消滅・選択からの離脱)。解を置き直せば戻る。
  public retire(): void {
    this.pos = null;
    this.time = null;
    this.retired = true;
  }

  public get gone(): boolean { return this.retired; }

  // 生成元が解いた時刻の位置。
  public posAt(): Vec3 | null { return this.pos; }
  // アイコンだけで示され、視線を通せる本体を持たない。
  public hitBodyByRay(): boolean { return false; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(this.id); }

  // 解いた位置へ置くマーカーの宣言。解けていないフレームは伏せ、天体に遮られたフレームは畳む。
  // occluders は遮蔽判定に使う天体で、occludersPivot はその位置を引く時刻。
  public declaration(
    project: ProjectFn, cameraPos: Vec3,
    occluders: readonly CelestialBody[], occludersPivot: number, occludeByBodies: boolean,
    timeLabel: TimeLabelSetting,
  ): MarkerDeclaration {
    const base = {
      id: this.id, cls: this.markerClass, sym: this.glyph, priority: this.markerPriority,
    };
    if (this.pos === null) return { ...base, x: 0, y: 0, front: false };
    if (occludeByBodies && isOccluded(cameraPos, this.pos, occluders, occludersPivot)) {
      return { ...base, x: 0, y: 0, front: false, occluded: true };
    }
    const { x, y, front, dist } = pointPlacement(this.pos, project, cameraPos);
    return {
      ...base, x, y, front, dist,
      label: orbitPointLabel(this.markerLabel, this.time, timeLabel),
    };
  }

  // メニューに出す操作項目。
  public menuItems(): readonly MenuItem<MenuAction>[] {
    return [
      { type: 'header', label: this.headerLabel, subLabel: this.headerSubLabel },
      MenuCommon.warp(),
      MenuCommon.addNode(),
      MenuCommon.focus(),
      MenuCommon.cancel(),
    ];
  }

  // 加速とノード追加は、通過時刻が求まっていて、計画を編集できるビューにいるフレームで効く。
  public runMenu(
    act: MenuAction, _controlSelection: ControlSelection, _authoring: ObjectAuthoring | null,
    planEditor: PlanEditor | null,
  ): void {
    const t = this.time;
    if (t === null || planEditor === null) return;
    if (act === 'warp') planEditor.warpTo(t);
    else if (act === 'addNode') planEditor.addNodeAt(t);
  }

  // プロパティウィンドウに出す行。示す値は具象が決める。
  public abstract propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
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
