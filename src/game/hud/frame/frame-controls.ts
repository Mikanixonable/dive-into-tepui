// マップビューの「カメラ」「軌道フレーム」2パネルを所有し、カメラの視点と未来表示の描画基準を
// 選ばせる。カメラのフォーカス変更への軌道フレームの追随など、2パネル間の連動もここが持つ。
import { bodyAnchorSource } from '../../../physics/attractor';
import type { ListedObject } from '../../pickable/listed-object';

import { FRAME_ROLES, FrameRole, FrameRotationSource, frameRoleOf } from '../../../physics/frame';
import type { FrameAnchorSource } from '../../../physics/frame';
import { Vec3 } from '../../../math/vec3';
import type { CelestialSystem } from '../../celestial/celestial-system';
import { FocusCamera } from '../../camera/focus-camera';
import { focusPoint, focusTargetId, FocusTarget } from '../../camera/focus-target';

import type { DisplayWindowManager } from '../../display-window-manager';
import type { OverlayManager } from '../../../hud/overlay-manager';
import { hudRail } from '../hud-root';
import { CameraFramePanel } from './camera-frame-panel';
import { TrajectoryFramePanel } from './trajectory-frame-panel';

// 見出しだけを持つ空のパネルを左レールへ足して返す。中身は返り値へ足す。
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

  // 2パネルを panelRoot へ組む。各パネルのポップアップは popupRoot へ出る。
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

  // 時刻 t に周回軌道を描いている役割を、回転の基準の選択肢として返す。
  private validRevolutionRoles(t: number): readonly FrameRole[] {
    return FRAME_ROLES.filter((role) => this.frameAnchors.attractorOf(`@${role}`, t) !== null);
  }

  // いま選ばれている回転が、もう周回していない役割の公転を指しているか。
  private isStaleRole(rotatingWith: FrameRotationSource | null, validRoles: readonly FrameRole[]): boolean {
    if (rotatingWith === null || rotatingWith.kind !== 'revolution') return false;
    const role = frameRoleOf(rotatingWith.id);
    return role !== null && !validRoles.includes(role);
  }

  // カメラの基準を選び直す。id が null なら、いま見ている位置を恒星中心の慣性系へ
  // 焼き込んだ固定点にする。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const frames = this.celestialSystem.frames;
    const star = this.celestialSystem.star;
    const frame = star !== null ? frames.frameOf(star.id, null) : frames.inertialFrame;
    // 回さないので基準は必ず登録天体で、機体・役割トークンを解く材料が要らない。
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

  // 軌道フレームが選んでいる役割の公転が成立しなくなったら、慣性系へ落とす。
  public update(displayTime: number): void {
    if (this.isStaleRole(this.displayWindow.frame.rotatingWith, this.validRevolutionRoles(displayTime))) {
      this.displayWindow.frame = this.celestialSystem.frames.frameOf(this.displayWindow.frame.center, null);
    }
  }

  // 両パネルの選択肢と選択表示を、いまの天体系とカメラ位置へ合わせる。
  public sync(
    pickables: readonly ListedObject[], cameraPos: Vec3,
    simTime: number, displayTime: number,
  ): void {
    this.lastTime = simTime;
    const members = this.celestialSystem.systemMembersAt(cameraPos, displayTime);
    this.cameraPanel.sync(pickables, members, displayTime);
    this.trajectoryPanel.sync(pickables, members, displayTime, this.validRevolutionRoles(displayTime));
  }

  // 両パネルを片付ける。
  public dispose(): void {
    this.cameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
