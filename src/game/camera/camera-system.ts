import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
import { MapCamera } from './map-camera';
import { MapViewPanel } from './map-view-panel';
import { PipCamera } from './pip-camera';
import { MapMarkers } from './map-markers';
import { FocusGizmo } from './focus-gizmo';
import { MarkerManager } from '../marker/marker-manager';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';
import { Vec3 } from '../../physics/vec3';
import { Projected } from '../../physics/projection';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';

export type ProjectFn = (worldPos: Vec3) => Projected;

// マップ視点パネルに常用のフォーカス先として並べるラベル ID。残りのラベル(ラグランジュ点など)へは
// ラベル右クリックのメニュー(FocusGizmo)からフォーカスする。
const PANEL_FOCUS_IDS = ['earth', 'moon', 'sun'] as const;

// 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する。
// マップモードのフォーカス候補(mapMarkers)とその選択 UI(focusGizmo / mapViewPanel)は
// 「どこを注視するか」= mapCamera 寄りの責務なので、ここが所有する。フォーカス選択メニューの
// ノードメニューとの排他(右クリックの取り合い)は上位(game.ts)が調停する。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly mapCamera: MapCamera;
  readonly pipCamera = new PipCamera();
  readonly mapMarkers: MapMarkers;
  private readonly focusGizmo = new FocusGizmo();
  // マップ視点の操作パネル(注視対象・視点の座標系・視点リセット)。映すのも受けるのも
  // mapCamera の状態だけなので、この HUD 配線はここに閉じる。
  private readonly mapViewPanel: MapViewPanel;
  mapMode = false;
  zoomActive = false;

  constructor(
    private readonly _hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
  ) {
    this.mapMarkers = new MapMarkers(markerManager, ephemeris);
    this.chaseCamera = new ChaseCamera(_hud, sfx);
    this.mapCamera = new MapCamera(_hud, sfx, this.mapMarkers, ephemeris);
    this.focusGizmo.onMenuFocus = (targetKey) => {
      this.mapCamera.focus = targetKey;
      const lbl = this.mapMarkers.findLabel(targetKey);
      if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
    };
    this.mapViewPanel = new MapViewPanel(_hud.root, PANEL_FOCUS_IDS.map(
      (id) => [id, this.mapMarkers.findLabel(id)?.name ?? id] as const,
    ));
    this.mapViewPanel.onFocusSelect = (focus) => {
      this.mapCamera.focus = focus;
      this.mapCamera.resetPan();
    };
    this.mapViewPanel.onViewReset = () => this.mapCamera.reset();
    this.mapViewPanel.onFrameSelect = (frame: Frame) => {
      this.mapCamera.cameraFrame = frame;
    };
  }

  // マップモードのフォーカス候補ラベル(地球・月・太陽・ラグランジュ点)の座標を更新し
  // マーカーへ反映する。displayTime は未来ゴーストスライダーを織り込んだ表示時刻で game が渡す。
  syncMapLabels(displayTime: number): void {
    this.mapMarkers.syncLabels(displayTime, this.activeCameraProjection);
  }

  mapLabelIds(): string[] {
    return this.mapMarkers.labels.map((l) => l.id);
  }

  // マップ編集中のポインタ操作。ノードに消費されずに残った右クリックだけがここへ来るので、
  // 最寄りラベルがあればフォーカス選択メニューを開いて消費する。
  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleFocusRightClick(p.x, p.y));
  }

  // マップラベル(フォーカス候補)の右クリック: 最寄りラベル(MAP_LABEL_PICK_PX 以内)が
  // あればフォーカス選択メニューを開いて true を返す。
  private handleFocusRightClick(clientX: number, clientY: number): boolean {
    const project = this.activeCameraProjection;
    let bestKey: string | null = null;
    let bestD = C.MAP_LABEL_PICK_PX * C.MAP_LABEL_PICK_PX;
    for (const lbl of this.mapMarkers.labels) {
      const p = project(lbl.pos);
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestKey = lbl.id;
      }
    }
    if (bestKey === null) return false;
    this.focusGizmo.openMenu(clientX, clientY, bestKey);
    return true;
  }

  closeFocusMenu(): void {
    this.focusGizmo.closeMenu();
  }

  get activeCamera(): THREE.PerspectiveCamera {
    return this.mapMode ? this.mapCamera.camera : this.chaseCamera.camera;
  }

  get activeCameraPos(): Vec3 {
    return this.mapMode ? this.mapCamera.position : this.chaseCamera.position;
  }

  update(
    player: Player,
    simTime: number,
    input: Input,
    dt: number,
  ): void {
    // [G] 追従基準の切替はカメラ自身の状態なので、視点更新と同じ場所で受ける。
    if (input.takeKey(K.followAttitudeToggle)) this.chaseCamera.toggleFollowAttitude();
    this.zoomActive = !this.mapMode && input.down(K.gunsightZoom);

    const keyYaw = (input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0);
    const keyPitch = (input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0);
    const mouse = input.mouse();

    if (this.mapMode) {
      this.mapCamera.update(mouse, keyYaw, keyPitch, dt, simTime);
    }
    else {
      this.chaseCamera.update(mouse, keyYaw, keyPitch, dt, player, this.zoomActive);
    }
    this.pipCamera.update(player);
  }

  // update() が算出した絶対 ECI の視点状態を、フローティングオリジン(fo)で補正して
  // 描画用のアクティブカメラへ反映する(平行移動のみ)。マーカー投影
  // (activeCameraProjection)や environment-scene がこの THREE.js カメラ姿勢を読むため、
  // game.sync() の先頭で(それらより先に)呼ぶ。
  sync(fo: FloatingOrigin): void {
    if (this.mapMode) this.mapCamera.sync(fo);
    else this.chaseCamera.sync(fo);
    this.pipCamera.sync(fo);
    // 視点パネルはマップモード中だけ表示し、点灯状態を mapCamera の現状へ揃える。フォーカスは
    // ラベル右クリックからも、座標系はリセットからも変わるので、変化点ごとの通知ではなく
    // 毎フレームここで押し出す(同値なら DOM は変わらない)。
    this.mapViewPanel.setVisible(this.mapMode);
    if (this.mapMode) {
      this.mapViewPanel.setFocus(this.mapCamera.focus);
      this.mapViewPanel.setFrame(this.mapCamera.cameraFrame);
    }
  }


  get activeCameraProjection(): ProjectFn {
    return this.mapMode ? this.mapCamera.projection : this.chaseCamera.projection;
  }
}