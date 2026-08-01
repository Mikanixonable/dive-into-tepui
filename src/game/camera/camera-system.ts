import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
import { OverviewCamera } from './overview-camera';
import { OverviewCameraPanel } from './overview-camera-panel';
import { FocusMarkers } from './focus-markers';
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

// 広範囲視点の操作パネルに常用のフォーカス先として並べるラベル ID。残りのラベル(ラグランジュ点
// など)へはラベル右クリックのメニュー(FocusGizmo)からフォーカスする。
const PANEL_FOCUS_IDS = ['earth', 'moon', 'sun'] as const;

// 戦闘ビュー(ChaseCamera)と広範囲視点(OverviewCamera)を切り替えて駆動する。
// フォーカス候補(focusMarkers)とその選択 UI(focusGizmo / overviewCameraPanel)も所有する。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly overviewCamera: OverviewCamera;
  readonly focusMarkers: FocusMarkers;
  private readonly focusGizmo = new FocusGizmo();
  // 広範囲視点の操作パネル(注視対象・視点の座標系・視点リセット)。
  private readonly overviewCameraPanel: OverviewCameraPanel;
  // 広範囲視点に切り替わっているか(視点・描画側の判定に使う)。
  overviewMode = false;
  zoomActive = false;

  // 両カメラとフォーカス候補ラベル、フォーカス選択 UI を構築し、パネルの選択操作を配線する。
  constructor(
    private readonly _hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
  ) {
    // 両カメラとフォーカス候補ラベル
    this.focusMarkers = new FocusMarkers(markerManager, ephemeris);
    this.chaseCamera = new ChaseCamera(_hud, sfx);
    this.overviewCamera = new OverviewCamera(_hud, sfx, this.focusMarkers, ephemeris);
    // ラベル右クリックメニューでのフォーカス選択
    this.focusGizmo.onMenuFocus = (targetKey) => {
      this.overviewCamera.focus = targetKey;
      const lbl = this.focusMarkers.findLabel(targetKey);
      if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
    };
    // 広範囲視点の操作パネルと各操作のコールバック
    this.overviewCameraPanel = new OverviewCameraPanel(_hud.root, PANEL_FOCUS_IDS.map(
      (id) => [id, this.focusMarkers.findLabel(id)?.name ?? id] as const,
    ));
    this.overviewCameraPanel.onFocusSelect = (focus) => {
      this.overviewCamera.focus = focus;
      this.overviewCamera.resetPan();
    };
    this.overviewCameraPanel.onViewReset = () => this.overviewCamera.reset();
    this.overviewCameraPanel.onFrameSelect = (frame: Frame) => {
      this.overviewCamera.cameraFrame = frame;
    };

    const chaseResetBtn = _hud.root.querySelector('#hud-chase-reset') as HTMLElement | null;
    if (chaseResetBtn) {
      chaseResetBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.chaseCamera.reset();
      });
    }
  }

  // マップ編集中のポインタ操作。最寄りラベルがあればフォーカス選択メニューを開いて消費する。
  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleFocusRightClick(p.x, p.y));
  }

  // 最寄りラベル(FOCUS_LABEL_PICK_PX 以内)があればフォーカス選択メニューを開いて true を返す。
  private handleFocusRightClick(clientX: number, clientY: number): boolean {
    // 全ラベルとの画面距離を比較し最も近いものを選ぶ
    const project = this.activeCameraProjection;
    let bestKey: string | null = null;
    let bestD = C.FOCUS_LABEL_PICK_PX * C.FOCUS_LABEL_PICK_PX;
    for (const lbl of this.focusMarkers.labels) {
      const p = project(lbl.pos);
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestKey = lbl.id;
      }
    }
    // 見つかればメニューを開く
    if (bestKey === null) return false;
    this.focusGizmo.openMenu(clientX, clientY, bestKey);
    return true;
  }

  // フォーカス選択メニューを閉じる。
  closeFocusMenu(): void {
    this.focusGizmo.closeMenu();
  }

  // 現在アクティブなカメラ(広範囲視点/戦闘追従視点)を返す。
  get activeCamera(): THREE.PerspectiveCamera {
    return this.overviewMode ? this.overviewCamera.camera : this.chaseCamera.camera;
  }

  // アクティブカメラの位置を返す。
  get activeCameraPos(): Vec3 {
    return this.overviewMode ? this.overviewCamera.position : this.chaseCamera.position;
  }

  // 入力からカメラの向き・ズームを更新する。overviewMode に応じてどちらか一方のカメラだけを駆動する。
  update(
    player: Player,
    simTime: number,
    input: Input,
    dt: number,
  ): void {
    // 追従視点トグルとズーム状態
    if (input.takeKey(K.followAttitudeToggle)) this.chaseCamera.toggleFollowAttitude();
    this.zoomActive = !this.overviewMode && input.down(K.gunsightZoom);

    // 中クリックで視点リセット
    input.takeMiddleClicks(() => {
      if (this.overviewMode) this.overviewCamera.reset();
      else this.chaseCamera.reset();
      return true;
    });

    // キー/マウスによる旋回入力をまとめる
    const keyYaw = (input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0);
    const keyPitch = (input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0);
    const mouse = input.mouse();

    if (this.overviewMode) {
      this.overviewCamera.update(mouse, keyYaw, keyPitch, dt, simTime);
    }
    else {
      this.chaseCamera.update(mouse, keyYaw, keyPitch, dt, player, this.zoomActive);
    }
  }

  // 視点状態をフローティングオリジン(fo)で補正してアクティブカメラへ反映する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    if (this.overviewMode) this.overviewCamera.sync(fo);
    else this.chaseCamera.sync(fo);
    // 広範囲視点のときだけ操作パネルとフォーカスラベルを表示する
    this.overviewCameraPanel.setVisible(this.overviewMode);
    
    const ids = ['hud-chase-reset', 'hud-status', 'hud-stagestatus'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = this.overviewMode ? 'none' : '';
    }
    if (this.overviewMode) {
      this.overviewCameraPanel.setFocus(this.overviewCamera.focus);
      this.overviewCameraPanel.setFrame(this.overviewCamera.cameraFrame);
      this.focusMarkers.syncLabels(displayTime, this.activeCameraProjection);
    } else {
      this.focusMarkers.hideLabels();
    }
  }


  // アクティブカメラの画面投影関数を返す。
  get activeCameraProjection(): ProjectFn {
    return this.overviewMode ? this.overviewCamera.projection : this.chaseCamera.projection;
  }
}