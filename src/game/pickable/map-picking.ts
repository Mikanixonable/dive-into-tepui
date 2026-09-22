// マップ上のクリックを候補列へヒットテストし、対象の被選択物ウィンドウや注視対象へディスパッチする。軌道物体一覧
// パネルと軌道線のプロパティウィンドウも持つ。
import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import { pickFrontmostBody, pickNearest, projectMarker, type ObjectPickable } from './object-pickable';
import type { MapPickable } from './map-pickable';
import { pickNearestLine } from './line-pickable';
import type { LinePickables } from './line-pickables';
import type { ObjectPickables } from './object-pickables';
import type { ObjectWindows } from './object-windows';
import { OrbitLineWindows } from './orbit-line-windows';
import { focusTargetId } from '../viewer/focus-target';
import { PhysicalObjectListPanel } from '../hud/panels/physical-object-list-panel';
import type { Input } from '../../input/input';
import { pickRadiusSq } from '../../input/pointer-precision';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import type { NavTargetPresenter } from '../nav-target-presenter';
import type { NavTargetCommands } from '../viewer/nav-target-commands';
import type { ControlSelectionCommands } from '../control-selection-commands';
import { rayThroughScreen } from '../../math/projection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { FocusCameraCommands } from '../viewer/camera-commands';
import type { MapCameraSource } from '../viewer/camera-selection';
import type { DisplayWindowManager } from '../display-window-manager';
import type { CameraFrame } from '../../render/camera/camera-frame';

const OBJECT_PICK_PX_SQ = 600; // 被選択物(ObjectPickable)の右クリック判定半径の2乗 [px^2]
const ORBIT_LINE_PICK_PX_SQ = 600; // 軌道線(公転軌道・船の軌道・軌道ガイド)の右クリック判定半径の2乗 [px^2]

// pointer:coarse(指先)環境で使う、同じ2つの判定半径の2乗 [px^2]。
const OBJECT_PICK_PX_SQ_COARSE = 1936;
const ORBIT_LINE_PICK_PX_SQ_COARSE = 1936;

export class MapPicking {
  private readonly listPanel: PhysicalObjectListPanel;
  private readonly orbitLineWindows: OrbitLineWindows;

  // 一覧パネルと軌道線ウィンドウを組み、一覧の行操作を注視・ターゲット・ウィンドウへ繋ぐ。
  public constructor(
    private readonly hud: HudLayers & Notifier,
    private readonly camera: MapCameraSource,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly markers: MarkerVisibility,
    private readonly navTargetPresenter: NavTargetPresenter,
    private readonly navTargetCommands: NavTargetCommands,
    private readonly mapFocusCommands: Pick<FocusCameraCommands, 'setFocus'>,
    private readonly pickables: ObjectPickables,
    private readonly linePickables: LinePickables,
    private readonly objectWindows: ObjectWindows,
    private readonly controlCommands: ControlSelectionCommands,
    private readonly displayWindowManager: Pick<DisplayWindowManager, 'current'>,
  ) {
    this.listPanel = new PhysicalObjectListPanel(hud.mapRoot, hud.panelCollapse, celestialBodies);
    this.orbitLineWindows = new OrbitLineWindows(
      hud, linePickables, pickables, (id, name) => this.focusOwner(id, name),
      (clientX, clientY, target) => this.objectWindows.open(clientX, clientY, target),
    );
    // 一覧の行は、マップ上で隠れている対象でも id で操作できる(SPEC/MAP.md「軌道物体一覧パネル」)。
    this.listPanel.onFocus = (id) => {
      this.focusTarget(id, this.pickables.listPickables.find((i) => i.id === id));
    };
    this.listPanel.onNavTarget = (id) => {
      const target = this.pickables.listPickables.find((i) => i.id === id);
      if (target && this.navTargetPresenter.canTarget(
        id, this.roster, this.celestialBodies, this.displayWindowManager.current.simTime)) {
        this.navTargetCommands.toggle(id, target.name);
      }
    };
    this.listPanel.onSelectRight = (id, clientX, clientY) => {
      const target = this.pickables.listPickables.find((i) => i.id === id);
      if (target) this.objectWindows.open(clientX, clientY, target);
    };
  }

  // 画面上の (x, y) に当たった被選択物を、マーカー段・本体段の順に探す(SPEC/MAP.md
  // 「クリックとピック」)。accept は候補を絞る述語で、どちらの段にも同じく効く。
  // どちらにも当たらなければ null。
  private pickAt(
    accept: (item: ObjectPickable) => boolean, x: number, y: number, camera: CameraFrame,
  ): ObjectPickable | null {
    const project = camera.project;
    const displayTime = this.displayWindowManager.current.displayTime;
    // マーカー段: 画面に出ているマーカーへ一定のピクセル半径で当てる。
    const marker = pickNearest(
      this.pickables.markerPickables.filter((item) => accept(item) && item.shownOnMap(this.markers)),
      (item) => projectMarker(item, displayTime, project),
      x, y, pickRadiusSq(OBJECT_PICK_PX_SQ, OBJECT_PICK_PX_SQ_COARSE),
    );
    if (marker !== null) return marker;
    // 本体段: 描かれている本体へ視線を通す。記号を消した対象もここでは当たる。
    const ray = rayThroughScreen(
      camera.viewpoint, x, y, camera.viewport.width, camera.viewport.height);
    return pickFrontmostBody(this.pickables.pickables.filter(accept), ray, displayTime);
  }

  // 右クリック位置の被選択物(天体・自艦・他艦・ノード等)のプロパティウィンドウを開く。
  // 当たらなければ消費せず、handleEmptySpaceRightClick へ読み進める。
  public handleRightClick(input: Input, camera: CameraFrame): void {
    input.takeRightClicks((p) => {
      const target = this.pickAt(() => true, p.x, p.y, camera);
      if (!target) return false;
      this.objectWindows.open(p.x, p.y, target);
      return true;
    });
  }

  // 右クリックを表示中の軌道線(公転軌道・船の軌道・軌道ガイド)へ当て、当たれば軌道の
  // プロパティウィンドウを開いて消費する。SPEC/MAP.md「クリックとピック」の判定順に従い、ノードハンドルの
  // 判定(PlanEditor.handleMapPointer)より後、handleEmptySpaceRightClick より前に呼ぶ。
  public handleLineRightClick(input: Input, camera: CameraFrame): void {
    input.takeRightClicks((p) => {
      // 候補の点列を求めた表示時刻で遮蔽を引き、判定半径内で最も近い線を探す。
      const orbit = pickNearestLine(
        this.linePickables.pickables, p.x, p.y,
        camera.project,
        pickRadiusSq(ORBIT_LINE_PICK_PX_SQ, ORBIT_LINE_PICK_PX_SQ_COARSE),
        camera.position, this.celestialBodies.celestialMotions,
        this.displayWindowManager.current.displayTime,
      );
      if (!orbit) return false;
      this.orbitLineWindows.open(p.x, p.y, orbit);
      return true;
    });
  }

  // 左クリック位置の、選択に応じる被選択物を選ぶ。当たらなければ消費せず、PlanEditor の
  // ノード配置/選択解除へ読み進める。マーカーへの命中をノード配置より優先するため、
  // PlanEditor.handleMapPointer より先に呼ぶ。
  public handleLeftClick(input: Input, camera: CameraFrame): void {
    input.takeClicks((p) => {
      const target = this.pickAt((i) => i.onMapSelect !== null, p.x, p.y, camera);
      if (!target) return false;
      target.onMapSelect?.(this.objectWindows, p.x, p.y);
      return true;
    });
  }

  // ダブルクリック位置の被選択物へフォーカスを移し、自艦であれば操作対象にも切り替える。
  // 種別を問わず候補列全体から探す。
  public handleDoubleClick(input: Input, camera: CameraFrame): void {
    input.takeDoubleClicks((p) => {
      const target = this.pickAt(() => true, p.x, p.y, camera);
      if (!target) return false;
      this.focusTarget(target.id, target);
      return true;
    });
  }

  // 何も当たらなかった右クリックを「空域」として扱う(他のハンドラの後に呼ぶ)。
  public handleEmptySpaceRightClick(input: Input): void {
    input.takeRightClicks((p) => {
      this.objectWindows.openEmptySpaceMenu(p.x, p.y);
      return true;
    });
  }

  // 軌道線ウィンドウの「所属」欄から、その持ち主へ注視を移す。
  private focusOwner(id: string, name: string): void {
    this.mapFocusCommands.setFocus({ kind: 'object', id });
    this.hud.hint(`${name} にフォーカス`);
  }

  // マップ視点のフォーカスを id の対象へ移す。対象が自艦なら操作対象にもなる(SPEC/MAP.md「軌道物体一覧パネル」)。
  // target は候補列で見つかっていれば渡し、表示名と操作対象の切り替えに使う。
  private focusTarget(id: string, target: MapPickable | undefined): void {
    this.mapFocusCommands.setFocus({ kind: 'object', id });
    this.hud.hint(`${target?.name ?? id} にフォーカス`);
    target?.onMapFocus?.(this.controlCommands);
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
      this.pickables.listPickables, focusTargetId(this.camera.map.focus),
      parentOf, viewer, displayTime);
    this.orbitLineWindows.sync();
  }

  // 一覧と軌道線のウィンドウを畳む。マップビューを離れるときに呼ぶ。
  public close(): void {
    this.listPanel.setVisible(false);
    this.orbitLineWindows.close();
  }

  // 一覧パネルを取り除く。
  public dispose(): void {
    this.listPanel.dispose();
  }
}
