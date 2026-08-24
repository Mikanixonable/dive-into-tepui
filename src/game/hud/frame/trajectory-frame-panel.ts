// マップモードの「軌道フレーム」パネル。計画折れ線・予測軌道線の描画基準(中心天体・回転系)とカメラ追随設定を担当する。
import type { Ephemeris } from '../../../physics/ephemeris';
import { FrameRole, frameRoleOf } from '../../../physics/frame';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { ToggleSwitch } from '../widgets';
import { celestialBodyName, frameRoleName, rotationSourceLabel } from './frame-labels';
import { hudRail } from '../hud-root';
import type { MapPickable } from '../../map-pickable';
import type { DisplayWindowManager } from '../../display-window-manager';
import type { OverlayManager } from '../overlay-manager';

function buildPanel(root: HTMLElement, id: string, titleText: string): HTMLElement {
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

export class TrajectoryFramePanel {
  private readonly panel: HTMLElement;
  private readonly planCenterZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  private readonly followToggle: ToggleSwitch;
  private readonly orbitSummary: HTMLElement;

  public followCamera = true;

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
    this.planCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.planCenterZone.onSelect = (id) => {
      if (id === null) return;
      this.displayWindow.frame = ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    };
    this.panel.appendChild(this.planCenterZone.element);

    this.planRotationZone = new RotationZone('回転フレーム', ephemeris);
    this.planRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
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

  private orbitSummaryText(): string {
    const centerId = this.displayWindow.frame.center;
    const centerRole = frameRoleOf(centerId);
    const planCenter = centerRole !== null ? frameRoleName(centerRole) : celestialBodyName(centerId);
    const planRot = this.displayWindow.frame.rotatingWith;
    return `基準: ${planCenter}・${rotationSourceLabel(planRot)}`;
  }

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

  public dispose(): void {
    this.planCenterZone.dispose();
    this.panel.remove();
  }
}
