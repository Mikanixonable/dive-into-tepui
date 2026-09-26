// マップビューの「軌道フレーム」パネル。計画折れ線・予測軌道線の描画基準(中心天体・回転系)とカメラ追随設定を担当する。
import { FrameRole, frameRoleOf } from '../../../physics/frame';
import { AnchorZone } from './anchor-zone';
import { RotationZone } from './rotation-zone';
import { ToggleSwitch } from '../../../hud/widgets';
import { frameRoleName, rotationSourceLabel } from './frame-labels';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { PredictPanelSource } from '../../viewer/predict-panel-selection';
import type { PredictPanelCommands } from '../../viewer/predict-panel-commands';
import type { OverlayManager } from '../../../hud/overlay-manager';
import { buildPanel } from './frame-panel';
import type { ListedObject } from '../../pickable/listed-object';

export class TrajectoryFramePanel {
  private readonly panel: HTMLElement;
  private readonly planCenterZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  private readonly followToggle: ToggleSwitch;
  private readonly stateCenter: HTMLElement;
  private readonly stateRotation: HTMLElement;

  // panelRoot はパネル自身の設置先。
  public constructor(
    panelRoot: HTMLElement,
    private readonly celestialBodies: CelestialBodies,
    private readonly predictPanel: Pick<PredictPanelSource, 'frame' | 'followCamera'>,
    private readonly commands: Pick<
      PredictPanelCommands,
      'setFrameCenter' | 'setFrameRotation' | 'setFollowCamera'
    >,
    overlayManager: OverlayManager,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-trajectory-frame', 'TRAJECTORY FRAME', 'FRM');

    const state = document.createElement('section');
    state.className = 'editorial-state trajectory-frame-state';
    state.innerHTML = `
      <div class="editorial-state-hero">
        <span class="ui-data-label">FRAME</span>
        <strong data-frame-state="hero">—</strong>
      </div>
      <div class="editorial-state-grid">
        <div class="editorial-state-cell"><span class="ui-data-label">CENTER</span><span data-frame-state="center">—</span></div>
        <div class="editorial-state-cell"><span class="ui-data-label">ROTATION</span><span data-frame-state="rotation">—</span></div>
      </div>`;
    this.panel.appendChild(state);
    const hero = state.querySelector<HTMLElement>('[data-frame-state="hero"]')!;
    this.stateCenter = state.querySelector<HTMLElement>('[data-frame-state="center"]')!;
    this.stateRotation = state.querySelector<HTMLElement>('[data-frame-state="rotation"]')!;
    hero.dataset['frameHero'] = 'true';

    const controls = document.createElement('div');
    controls.className = 'editorial-control-zone trajectory-frame-controls';
    this.panel.appendChild(controls);

    // 描く線は必ずどこかの座標系に焼き込まれるので「どこにも固定しない」状態が無く、
    // 太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.planCenterZone = new AnchorZone('基準', celestialBodies, null, overlayManager);
    this.planCenterZone.element.classList.add('hud-frame-origin-zone');
    this.planCenterZone.onSelect = (id) => {
      if (id === null) return;
      this.commands.setFrameCenter(id);
    };
    controls.appendChild(this.planCenterZone.element);

    this.planRotationZone = new RotationZone('回転フレーム', celestialBodies);
    this.planRotationZone.element.classList.add('hud-frame-rotation-zone');
    this.planRotationZone.onSelect = (rotatingWith) => {
      this.commands.setFrameRotation(rotatingWith);
    };
    controls.appendChild(this.planRotationZone.element);

    this.followToggle = new ToggleSwitch('カメラの基準に追随', (on: boolean) => commands.setFollowCamera(on));
    this.followToggle.setOn(predictPanel.followCamera);
    controls.appendChild(this.followToggle.element);

  }

  private frameLabels(): { readonly center: string; readonly rotation: string } {
    const centerId = this.predictPanel.frame.center;
    const centerRole = frameRoleOf(centerId);
    const center = centerRole !== null ? frameRoleName(centerRole) : this.celestialBodies.nameOf(centerId);
    return { center, rotation: rotationSourceLabel(this.celestialBodies, this.predictPanel.frame.rotatingWith) };
  }

  // 各ウィジェットの選択状態を、渡された時刻・軌道フレーム状態へ合わせる。
  public sync(
    pickables: readonly ListedObject[], members: readonly string[], displayTime: number,
    validRoles: readonly FrameRole[],
  ): void {
    this.planCenterZone.setItems(pickables);
    this.planCenterZone.setNearby(members, pickables);
    this.planCenterZone.setSelected(this.predictPanel.frame.center);
    this.planRotationZone.setNearby(members, displayTime, validRoles);
    this.planRotationZone.setSelected(this.predictPanel.frame.rotatingWith);

    this.followToggle.setOn(this.predictPanel.followCamera);
    const labels = this.frameLabels();
    this.stateCenter.textContent = labels.center;
    this.stateRotation.textContent = labels.rotation;
    const hero = this.panel.querySelector<HTMLElement>('[data-frame-hero="true"]');
    if (hero) hero.textContent = `${labels.center} / ${labels.rotation}`;
  }

  // 保持しているゾーンとパネル要素を片付ける。
  public dispose(): void {
    this.planCenterZone.dispose();
    this.panel.remove();
  }
}
