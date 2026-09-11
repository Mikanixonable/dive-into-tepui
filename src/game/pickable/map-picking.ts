// マップ上のクリックを候補列へ当て、当たった被選択物のウィンドウ・注視へ配る。軌道物体一覧
// パネルと軌道線のプロパティウィンドウは、どちらもマップにしか出ないのでここが持つ。
import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import { pickFrontmostBody, pickNearest, projectMarker } from './object-pickable';
import type { MapPickable } from './map-pickable';
import { pickNearestLine } from './line-pickable';
import type { LinePickables } from './line-pickables';
import type { ObjectPickables } from './object-pickables';
import type { ObjectWindows } from './object-windows';
import { OrbitLineWindows } from './orbit-line-windows';
import { focusTargetId } from '../camera/focus-target';
import { PhysicalObjectListPanel } from '../hud/panels/physical-object-list-panel';
import type { Input } from '../../input/input';
import { pickRadiusSq } from '../../input/pointer-precision';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { MarkerSlots } from '../marker/marker-slots';
import type { NavTarget } from '../nav-target';
import type { CameraSystem } from '../camera/camera-system';
import type { Viewport } from '../../render/viewport';
import type { ControlSelection } from '../control-selection';
import { rayThroughScreen } from '../../math/projection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { FocusSink } from '../camera/focus-target';

const OBJECT_PICK_PX_SQ = 600; // 被選択物(ObjectPickable)の右クリック判定半径の2乗 [px^2]
const ORBIT_LINE_PICK_PX_SQ = 600; // 軌道線(公転軌道・船の軌道・軌道ガイド)の右クリック判定半径の2乗 [px^2]

// pointer:coarse(指先)環境で使う、同じ2つの判定半径の2乗 [px^2]。
const OBJECT_PICK_PX_SQ_COARSE = 1936;
const ORBIT_LINE_PICK_PX_SQ_COARSE = 1936;

export class MapPicking {
  private readonly listPanel: PhysicalObjectListPanel;
  // 軌道線のプロパティウィンドウ。線が出るのはマップだけなので、ここが持つ。
  private readonly orbitLineWindows: OrbitLineWindows;

  // 候補列と、当たった対象の落とし先(ObjectWindows)を参照として受け取る。
  public constructor(
    private readonly hud: HudLayers & Notifier,
    private readonly cameraSystem: CameraSystem,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly markers: MarkerSlots,
    private readonly navTarget: NavTarget,
    private readonly focusSink: FocusSink,
    private readonly pickables: ObjectPickables,
    private readonly linePickables: LinePickables,
    private readonly objectWindows: ObjectWindows,
    private readonly controlSelection: ControlSelection,
  ) {
    this.listPanel = new PhysicalObjectListPanel(hud.mapRoot, celestialBodies);
    this.orbitLineWindows = new OrbitLineWindows(
      hud, linePickables, pickables, (id, name) => this.focusOwner(id, name),
      (clientX, clientY, target) => this.objectWindows.open(
        clientX, clientY, target, this.pickables.lastSimTime),
    );
    // 一覧の行は隠れている対象でも操作できる(SPEC/MAP.md §10) — pickable によるマップ上の
    // 衝突判定はマーカーのヒットテストにだけ適用され、一覧からの id 一致には適用しない。
    this.listPanel.onFocus = (id) => {
      this.focusTarget(id, this.pickables.pickables.find((i) => i.id === id));
    };
    this.listPanel.onNavTarget = (id) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target && this.navTarget.canTarget(id, this.roster, this.celestialBodies, this.pickables.lastSimTime)) {
        this.navTarget.toggleTarget(id, target.name);
      }
    };
    this.listPanel.onSelectRight = (id, clientX, clientY) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target) this.objectWindows.open(clientX, clientY, target, this.pickables.lastSimTime);
    };
  }

  // 画面上の (x, y) に当たった被選択物。マーカーへ一定のピクセル半径で当て、外れたら
  // 描かれている本体へ視線を通す(SPEC/MAP.md §11)。マーカー段はラベル衝突で非表示に
  // なった対象を外すが、本体段は外さない — 円盤が見えているのに掴めないのは嘘になる。
  private pickAt<T extends MapPickable>(
    candidates: readonly T[], x: number, y: number, viewport: Viewport,
  ): T | null {
    const project = this.cameraSystem.activeProjection(viewport);
    const displayTime = this.pickables.lastDisplayTime;
    const marker = pickNearest(
      candidates.filter((item) => item.shownOnMap(this.markers)),
      (item) => projectMarker(item, displayTime, project),
      x, y, pickRadiusSq(OBJECT_PICK_PX_SQ, OBJECT_PICK_PX_SQ_COARSE),
    );
    if (marker !== null) return marker;
    const ray = rayThroughScreen(
      this.cameraSystem.activeViewpoint, x, y, viewport.width, viewport.height);
    return pickFrontmostBody(candidates, ray, displayTime);
  }

  // 右クリック位置の被選択物(天体・自艦・他艦・ノード等)のプロパティウィンドウを開く。
  // 当たらなければ消費せず、handleEmptySpaceRightClick へ読み進める。
  public handleRightClick(input: Input, simTime: number, viewport: Viewport): void {
    input.takeRightClicks((p) => {
      const target = this.pickAt(this.pickables.pickables, p.x, p.y, viewport);
      if (!target) return false;
      this.objectWindows.open(p.x, p.y, target, simTime);
      return true;
    });
  }

  // 被選択物・ノードハンドルのどちらにも当たらなかった右クリックに対し、表示中の軌道線
  // (公転軌道・船の軌道・軌道ガイド)への当たり判定を試みる。当たれば軌道のプロパティ
  // ウィンドウを開いて消費する。handleEmptySpaceRightClick より前、editor.handleMapPointer
  // より後に呼ぶ(11節の判定順序)。
  public handleLineRightClick(input: Input, viewport: Viewport): void {
    input.takeRightClicks((p) => {
      const orbit = pickNearestLine(
        this.linePickables.pickables, p.x, p.y,
        this.cameraSystem.activeProjection(viewport),
        pickRadiusSq(ORBIT_LINE_PICK_PX_SQ, ORBIT_LINE_PICK_PX_SQ_COARSE),
        this.cameraSystem.activeCameraPos, this.celestialBodies.celestialMotions,
        this.pickables.lastDisplayTime,
      );
      if (!orbit) return false;
      this.orbitLineWindows.open(p.x, p.y, orbit);
      return true;
    });
  }

  // 左クリック位置の、選択に応じる被選択物を選ぶ。当たらなければ消費せず、PlanEditor の
  // ノード配置/選択解除に読み進める(呼び出し側が editor.handleMapPointer より先に呼ぶことで、
  // マーカーへの命中をノード配置より優先する)。
  public handleLeftClick(input: Input, viewport: Viewport): void {
    input.takeClicks((p) => {
      const target = this.pickAt(
        this.pickables.pickables.filter((i) => i.onMapSelect !== null), p.x, p.y, viewport);
      if (!target) return false;
      target.onMapSelect?.(this.objectWindows, p.x, p.y);
      return true;
    });
  }

  // ダブルクリック位置の被選択物へフォーカスを移し、自艦であれば操作対象にも切り替える。
  // 種別を問わず候補列全体から探す。
  public handleDoubleClick(input: Input, viewport: Viewport): void {
    input.takeDoubleClicks((p) => {
      const target = this.pickAt(this.pickables.pickables, p.x, p.y, viewport);
      if (!target) return false;
      this.focusTarget(target.id, target);
      return true;
    });
  }

  // 何も当たらなかった右クリックを「空域」として扱う(他のハンドラの後に呼ぶ)。
  public handleEmptySpaceRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      this.objectWindows.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  // 軌道線ウィンドウの「所属」欄から、その持ち主へ注視を移す。
  private focusOwner(id: string, name: string): void {
    this.focusSink.setFocus({ kind: 'object', id });
    this.hud.hint(`${name} にフォーカス`);
  }

  // マップ視点のフォーカスを対象へ移す。対象が自艦なら操作対象にもなる(SPEC/MAP.md §10)。
  // ダブルクリックと一覧パネルのフォーカス行はどちらもここを通す。id は一覧側が候補列に
  // 頼らず持っている値、target は見つかっていれば名前・種別の解決に使う。
  private focusTarget(id: string, target: MapPickable | undefined): void {
    this.focusSink.setFocus({ kind: 'object', id });
    this.hud.hint(`${target?.name ?? id} にフォーカス`);
    target?.onMapFocus?.(this.controlSelection);
  }

  // 軌道物体一覧を、このフレームの候補列で組み直す。
  public sync(displayTime: number, viewer: OrbitingObject | null): void {
    // 親が無ければ(恒星、もしくは主天体が未登録)載せず、根として扱う。
    const parentOf = new Map<string, string>();
    for (const item of this.celestialMarkers.allItems) {
      const parent = this.celestialBodies.bodyParentId(item.id);
      if (parent !== undefined && parent !== null) parentOf.set(item.id, parent);
    }
    this.listPanel.setVisible(true);
    this.listPanel.sync(
      this.pickables.pickables, focusTargetId(this.cameraSystem.mapCamera.focus),
      parentOf, viewer, displayTime);
    this.orbitLineWindows.sync();
  }

  // 一覧と軌道線のウィンドウを畳む。マップビューを離れるときに呼ぶ。
  public close(): void {
    this.listPanel.setVisible(false);
    this.orbitLineWindows.close();
  }

  public dispose(): void {
    this.listPanel.dispose();
  }
}
