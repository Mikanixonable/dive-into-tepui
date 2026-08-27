// マップモードの「カメラ」「軌道フレーム」パネル オーケストレーター。
// マップカメラの視点 (CameraFramePanel) と未来表示の描画基準 (TrajectoryFramePanel) を所有し、
// カメラフォーカス変更時の軌道フレーム自動追随などの連動を疎結合に調停する。
import { bodyAnchorSource, CelestialBody } from '../../../physics/celestial-body';
import type { Ephemeris } from '../../../physics/ephemeris';
import { FRAME_ROLES, FrameRole, FrameRotationSource, frameRoleOf } from '../../../physics/frame';
import type { FrameAnchorSource } from '../../../physics/frame';
import { Vec3 } from '../../../physics/vec3';
import { systemMembersAt } from '../../celestial/body-visibility';
import { MapCamera } from '../../camera/map-camera';
import { focusPoint, focusTargetId, FocusTarget } from '../../camera/focus-target';
import type { MapPickable } from '../../map-pickable';
import type { DisplayWindowManager } from '../../display-window-manager';
import type { OverlayManager } from '../overlay-manager';
import { hudRail } from '../hud-root';
import { CameraFramePanel } from './camera-frame-panel';
import { TrajectoryFramePanel } from './trajectory-frame-panel';

// カメラ・軌道フレーム両パネル共通の枠組みを組み立てる(id/クラス付与・pointerdown 抑止・
// タイトル生成・hudRail への追加)。中身の子要素は各パネル側が追加する。
export function buildPanel(root: HTMLElement, id: string, titleText: string): HTMLElement {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = 'panel hidden hud-frame-controls';
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  const title = document.createElement('h3');
  title.textContent = titleText;
  panel.appendChild(title);
  hudRail(root, 'left').appendChild(panel);
  return panel;
}

export class FrameControls {
  private readonly cameraPanel: CameraFramePanel;
  private readonly trajectoryPanel: TrajectoryFramePanel;
  // 固定解除は DOM イベント(フレームの外)から起きるので、直近の sync が見た時刻を控える。
  private lastTime = 0;

  // panelRoot・popupRoot はカメラ/軌道フレーム両パネルへそのまま渡す設置先。
  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly ephemeris: Ephemeris,
    private readonly mapCamera: MapCamera,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
    private readonly frameAnchors: FrameAnchorSource,
  ) {
    this.cameraPanel = new CameraFramePanel(panelRoot, popupRoot, ephemeris, mapCamera, overlayManager);
    this.trajectoryPanel = new TrajectoryFramePanel(panelRoot, popupRoot, ephemeris, displayWindow, overlayManager);

    this.cameraPanel.onSelectCenter = (id) => this.selectCameraCenter(id);
  }

  // 離心率1未満の周回軌道にある役割だけを、回転ゾーンの「役割の公転」選択肢として返す
  // (RotationZone は Ephemeris しか知らないため、判定はここで行う)。
  private validRevolutionRoles(t: number): readonly FrameRole[] {
    return FRAME_ROLES.filter((role) => this.frameAnchors.attractorOf(`@${role}`, t) !== null);
  }

  // いま選ばれている回転が、もう周回していない役割の公転を指しているか。天体を指す回転と
  // 慣性系は対象外(条件で消えることがない)。
  private isStaleRole(rotatingWith: FrameRotationSource | null, validRoles: readonly FrameRole[]): boolean {
    if (rotatingWith === null || rotatingWith.kind !== 'revolution') return false;
    const role = frameRoleOf(rotatingWith.id);
    return role !== null && !validRoles.includes(role);
  }

  // カメラの基準を選び直す。解除は、いま見ている位置を恒星中心の慣性系へ焼き込んだ
  // 固定点にする — どの天体にも追随しないが、視線はその場に留まる。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const starId = this.ephemeris.starId;
    const frame = starId !== null ? this.ephemeris.frameOf(starId, null) : this.ephemeris.inertialFrame;
    // 回さない(rotatingWith: null)ので基準は必ず登録天体 — 機体・役割トークンの解決は要らない。
    this.setFocus(focusPoint(this.ephemeris, frame, this.mapCamera.resolvedFocus, this.lastTime, bodyAnchorSource([])));
  }

  // マップカメラのフォーカスを target へ移す。追随が有効で target が登録天体を指しているときは
  // 計画折れ線の中心も同じ天体へ合わせる(回転側は現状を保つ)。
  public setFocus(target: FocusTarget): void {
    this.mapCamera.setFocusTarget(target);
    if (!this.trajectoryPanel.followCamera) return;
    const id = focusTargetId(target);
    if (id !== undefined && id in this.ephemeris.registry) {
      this.displayWindow.frame = this.ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    }
  }

  // パネルの表示と選択肢・選択表示を、他モジュールの状態へ合わせる。
  public sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
    simTime: number, displayTime: number, visible: boolean,
  ): void {
    this.lastTime = simTime;
    const members = visible ? systemMembersAt(this.ephemeris.registry, cameraPos, celestialBodies) : [];
    // 役割が周回しているかどうかはパネルが見えているかと関係がないので、非表示でも判定する
    // — 見えていないあいだ空扱いにすると、パネルを畳んだだけで下の巻き戻しが走り、選択が消える。
    const validRoles = this.validRevolutionRoles(displayTime);

    // 選択中の役割の公転が条件を崩したら、既存の onSelect と同じ経路(カメラは
    // setCameraRotation、軌道フレームは frame の差し替え)で慣性系へ落とす。
    if (this.isStaleRole(this.mapCamera.cameraFrame.rotatingWith, validRoles)) {
      this.mapCamera.setCameraRotation(null);
    }
    if (this.isStaleRole(this.displayWindow.frame.rotatingWith, validRoles)) {
      this.displayWindow.frame = this.ephemeris.frameOf(this.displayWindow.frame.center, null);
    }

    this.cameraPanel.sync(pickables, members, displayTime, validRoles, visible);
    this.trajectoryPanel.sync(pickables, members, displayTime, validRoles, visible);
  }

  // 両パネルと、保持している座標系選択ゾーンを片付ける。
  public dispose(): void {
    this.cameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
