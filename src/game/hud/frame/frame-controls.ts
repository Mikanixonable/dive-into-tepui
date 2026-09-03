// マップビューの「カメラ」「軌道フレーム」パネル オーケストレーター。
// マップカメラの視点 (CameraFramePanel) と未来表示の描画基準 (TrajectoryFramePanel) を所有し、
// カメラフォーカス変更時の軌道フレーム自動追随などの連動を疎結合に調停する。
import { bodyAnchorSource } from '../../../physics/attractor';
import { FRAME_ROLES, FrameRole, FrameRotationSource, frameRoleOf } from '../../../physics/frame';
import type { FrameAnchorSource } from '../../../physics/frame';
import { Vec3 } from '../../../math/vec3';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { FocusCamera } from '../../camera/focus-camera';
import { focusPoint, focusTargetId, FocusTarget } from '../../camera/focus-target';
import type { ObjectPickable } from '../../pickable/object-pickable';
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
  panel.className = 'panel hud-frame-controls';
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
    private readonly celestialSystem: CelestialSystem,
    private readonly mapCamera: FocusCamera,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
    private readonly frameAnchors: FrameAnchorSource,
  ) {
    this.cameraPanel = new CameraFramePanel(panelRoot, popupRoot, celestialSystem, mapCamera, overlayManager);
    this.trajectoryPanel = new TrajectoryFramePanel(
      panelRoot, popupRoot, celestialSystem, displayWindow, overlayManager,
    );

    this.cameraPanel.onSelectCenter = (id) => this.selectCameraCenter(id);
  }

  // 離心率1未満の周回軌道にある役割だけを、回転ゾーンの「役割の公転」選択肢として返す。
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
    const frames = this.celestialSystem.frames;
    const star = this.celestialSystem.star;
    const frame = star !== null ? frames.frameOf(star.id, null) : frames.inertialFrame;
    // 回さない(rotatingWith: null)ので基準は必ず登録天体 — 機体・役割トークンの解決は要らない。
    this.setFocus(focusPoint(
      this.celestialSystem.frames, frame, this.mapCamera.resolvedFocus, this.lastTime, bodyAnchorSource([], this.lastTime),
    ));
  }

  // マップカメラのフォーカスを target へ移す。追随が有効で target が登録天体を指しているときは
  // 計画折れ線の中心も同じ天体へ合わせる(回転側は現状を保つ)。
  public setFocus(target: FocusTarget): void {
    this.mapCamera.setFocusTarget(target);
    if (!this.trajectoryPanel.followCamera) return;
    const id = focusTargetId(target);
    if (id !== undefined && this.celestialSystem.has(id)) {
      this.displayWindow.frame = this.celestialSystem.frames.frameOf(id, this.displayWindow.frame.rotatingWith);
    }
  }

  // 両パネルの選択肢と選択表示を、他モジュールの状態へ合わせる。
  public sync(
    pickables: readonly ObjectPickable[], cameraPos: Vec3,
    simTime: number, displayTime: number,
  ): void {
    this.lastTime = simTime;
    const members = this.celestialSystem.systemMembersAt(cameraPos, displayTime);
    const validRoles = this.validRevolutionRoles(displayTime);

    // 軌道フレームで選択中の役割の公転が条件を崩したら、既存の onSelect と同じ経路
    // (frame の差し替え)で慣性系へ落とす。カメラ側の同種の検査はカメラ自身が持つ。
    if (this.isStaleRole(this.displayWindow.frame.rotatingWith, validRoles)) {
      this.displayWindow.frame = this.celestialSystem.frames.frameOf(this.displayWindow.frame.center, null);
    }

    this.cameraPanel.sync(pickables, members, displayTime);
    this.trajectoryPanel.sync(pickables, members, displayTime, validRoles);
  }

  // 両パネルと、保持している座標系選択ゾーンを片付ける。
  public dispose(): void {
    this.cameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
