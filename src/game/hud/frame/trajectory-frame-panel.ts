// マップモードの「軌道フレーム」パネル。計画折れ線・予測軌道線の描画基準(中心天体・回転系)とカメラ追随設定を担当する。
import type { Ephemeris } from '../../../physics/ephemeris';
import { FrameRole, frameRoleOf } from '../../../physics/frame';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { ToggleSwitch } from '../widgets';
import { celestialBodyName, frameRoleName, rotationSourceLabel } from './frame-labels';
import type { MapPickable } from '../../pickable/map-pickable';
import type { DisplayWindowManager } from '../../display-window-manager';
import type { OverlayManager } from '../overlay-manager';
import { buildPanel } from './frame-controls';

export class TrajectoryFramePanel {
  private readonly panel: HTMLElement;
  private readonly planCenterZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  private readonly followToggle: ToggleSwitch;
  private readonly orbitSummary: HTMLElement;

  public followCamera = true;

  // panelRoot はパネル自身の設置先、popupRoot は AnchorZone のポップアップの親。
  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    ephemeris: Ephemeris,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-trajectory-frame', '軌道フレーム');

    // 描く線は必ずどこかの座標系に焼き込まれるので「どこにも固定しない」状態が無く、
    // 太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.planCenterZone = new AnchorZone(popupRoot, '基準', ephemeris, null, overlayManager);
    this.planCenterZone.element.classList.add('hud-frame-origin-zone');
    this.planCenterZone.onSelect = (id) => {
      if (id === null) return;
      this.displayWindow.frame = ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    };
    this.panel.appendChild(this.planCenterZone.element);

    this.planRotationZone = new RotationZone('回転フレーム', ephemeris);
    this.planRotationZone.element.classList.add('hud-frame-rotation-zone');
    this.planRotationZone.onSelect = (rotatingWith) => {
      this.displayWindow.frame = ephemeris.frameOf(this.displayWindow.frame.center, rotatingWith);
    };
    this.panel.appendChild(this.planRotationZone.element);

    this.followToggle = new ToggleSwitch('カメラの基準に追随', (on: boolean) => { this.followCamera = on; });
    this.followToggle.setOn(this.followCamera);
    this.panel.appendChild(this.followToggle.element);

    this.orbitSummary = document.createElement('div');
    this.orbitSummary.className = 'frame-summary';
    this.panel.appendChild(this.orbitSummary);
  }

  // パネル下部に表示するサマリ行の文字列を組み立てる。
  private orbitSummaryText(): string {
    const centerId = this.displayWindow.frame.center;
    const centerRole = frameRoleOf(centerId);
    const planCenter = centerRole !== null ? frameRoleName(centerRole) : celestialBodyName(centerId);
    const planRot = this.displayWindow.frame.rotatingWith;
    return `基準: ${planCenter}・${rotationSourceLabel(planRot)}`;
  }

  // パネルの表示と各ウィジェットの選択状態を、渡された時刻・軌道フレーム状態へ合わせる。
  public sync(
    pickables: readonly MapPickable[], members: readonly string[], displayTime: number,
    validRoles: readonly FrameRole[], isVisible: boolean,
  ): void {
    this.panel.classList.toggle('hidden', !isVisible);
    if (!isVisible) return;

    this.planCenterZone.setItems(pickables);
    this.planCenterZone.setNearby(members, pickables);
    this.planCenterZone.setSelected(this.displayWindow.frame.center);
    this.planRotationZone.setNearby(members, displayTime, validRoles);
    this.planRotationZone.setSelected(this.displayWindow.frame.rotatingWith);

    this.followToggle.setOn(this.followCamera);
    this.orbitSummary.textContent = this.orbitSummaryText();
  }

  // 保持しているゾーンとパネル要素を片付ける。
  public dispose(): void {
    this.planCenterZone.dispose();
    this.panel.remove();
  }
}
