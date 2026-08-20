// マップモードの「軌道フレーム」パネル。計画折れ線・予測軌道線の描画基準(中心天体・回転系)とカメラ追随設定を担当する。
import type { Ephemeris } from '../../physics/ephemeris';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { ToggleSwitch } from './widgets';
import { celestialBodyName } from './frame-labels';
import { hudRail } from './hud-root';
import { PanelShell } from './panel-shell';
import type { MapPickable } from '../map-pickable';
import type { DisplayWindowManager } from '../display-window-manager';
import type { OverlayManager } from './overlay-manager';

export class TrajectoryFramePanel {
  private readonly shell: PanelShell;
  private readonly planCenterZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  private readonly followToggle: ToggleSwitch;
  private readonly orbitSummary: HTMLElement;

  public followCamera: boolean;

  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    ephemeris: Ephemeris,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
    savedFollowCamera = true,
  ) {
    this.followCamera = savedFollowCamera;
    this.shell = new PanelShell(hudRail(panelRoot, 'left'), 'hud-trajectory-frame', '軌道フレーム');
    this.shell.el.classList.add('hidden', 'hud-frame-controls');
    this.shell.el.addEventListener('pointerdown', (e) => e.stopPropagation());

    // 描く線は必ずどこかの座標系に焼き込まれるので「どこにも固定しない」状態が無く、
    // 太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.planCenterZone = new AnchorZone(popupRoot, '基準にする天体', ephemeris, null, overlayManager);
    this.planCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.planCenterZone.onSelect = (id) => {
      if (id === null) return;
      this.displayWindow.frame = ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    };
    this.shell.body.appendChild(this.planCenterZone.element);

    this.planRotationZone = new RotationZone('線を一緒に回す', ephemeris);
    this.planRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
    this.planRotationZone.onSelect = (rotatingWith) => {
      this.displayWindow.frame = ephemeris.frameOf(this.displayWindow.frame.center, rotatingWith);
    };
    this.shell.body.appendChild(this.planRotationZone.element);

    this.followToggle = new ToggleSwitch('カメラの基準に追随', (on: boolean) => { this.followCamera = on; });
    this.followToggle.setOn(this.followCamera);
    this.shell.body.appendChild(this.followToggle.element);

    this.orbitSummary = document.createElement('div');
    this.orbitSummary.className = 'frame-summary';
    this.shell.body.appendChild(this.orbitSummary);
  }

  private orbitSummaryText(): string {
    const planCenter = celestialBodyName(this.displayWindow.frame.center);
    const planRot = this.displayWindow.frame.rotatingWith;
    const rotText = (id: string | null): string => (id === null ? '慣性系' : `${celestialBodyName(id)}回転系`);
    return `基準: ${planCenter}・${rotText(planRot)}`;
  }

  public sync(pickables: readonly MapPickable[], members: readonly string[], isVisible: boolean): void {
    this.shell.setHidden(!isVisible);
    if (!isVisible) return;

    this.planCenterZone.setItems(pickables);
    this.planCenterZone.setNearby(members, pickables);
    this.planCenterZone.setSelected(this.displayWindow.frame.center);
    this.planRotationZone.setNearby(members);
    this.planRotationZone.setSelected(this.displayWindow.frame.rotatingWith);

    this.followToggle.setOn(this.followCamera);
    this.orbitSummary.textContent = this.orbitSummaryText();
  }

  public dispose(): void {
    this.planCenterZone.dispose();
    this.shell.dispose();
  }
}
