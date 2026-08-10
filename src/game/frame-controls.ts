// マップモードの「座標系」パネル。OverviewCamera(カメラの注視対象・回転)と PlanDisplay
// (計画折れ線の原点・回転)という2つの所有者の状態を、1つのパネルから書き換える横断。
// 状態そのものは両クラスに置いたままにし、ここは参照を受け取って書くだけに留める。
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { Vec3 } from '../physics/vec3';
import { systemMembersAt } from './celestial/body-visibility';
import { OverviewCamera } from './camera/overview-camera';
import { AnchorZone } from './hud/anchor-zone';
import { RotationZone } from './hud/rotation-zone';
import { hudDock } from './hud/dom';
import type { MapPickable } from './map-pick';
import type { PlanDisplay } from './plan/plan-display';

export class FrameControls {
  private readonly panel: HTMLElement;
  private readonly cameraRotationZone: RotationZone;
  private readonly translationZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  // panelRoot はパネル自体(左ドック)の置き場所、popupRoot は ObjectPicker のポップアップの置き場所。
  constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly ephemeris: Ephemeris,
    private readonly overviewCamera: OverviewCamera,
    private readonly planDisplay: PlanDisplay,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-frame-controls';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '座標系';
    this.panel.appendChild(title);

    this.cameraRotationZone = new RotationZone('カメラ回転', ephemeris);
    this.cameraRotationZone.onSelect = (rotatingWith) => overviewCamera.setCameraRotation(rotatingWith);
    this.panel.appendChild(this.cameraRotationZone.element);

    // 並進ゾーンには解除を出さない: 描く線は必ずどこかの座標系に焼き込まれるので
    // 「どこにも固定しない」状態が無く、太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.translationZone = new AnchorZone(popupRoot, '並進', ephemeris, null);
    this.translationZone.onSelect = (id) => {
      if (id === null) return;
      planDisplay.planFrame = ephemeris.frameOf(id, planDisplay.planFrame.rotatingWith);
    };
    this.panel.appendChild(this.translationZone.element);

    this.planRotationZone = new RotationZone('計画軌道回転', ephemeris);
    this.planRotationZone.onSelect = (rotatingWith) => {
      planDisplay.planFrame = ephemeris.frameOf(planDisplay.planFrame.center, rotatingWith);
    };
    this.panel.appendChild(this.planRotationZone.element);

    hudDock(panelRoot, 'left').appendChild(this.panel);
  }

  // パネルの表示と3ゾーンの選択肢・選択表示を、他モジュールの状態(両座標系)へ合わせる。
  sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, attractors: readonly Attractor[],
    visible: boolean,
  ): void {
    this.panel.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const members = systemMembersAt(this.ephemeris.registry, cameraPos, attractors);

    this.cameraRotationZone.setNearby(members);
    this.cameraRotationZone.setSelected(this.overviewCamera.cameraFrame.rotatingWith);

    this.translationZone.setItems(pickables);
    this.translationZone.setNearby(members, pickables);
    this.translationZone.setSelected(this.planDisplay.planFrame.center);

    this.planRotationZone.setNearby(members);
    this.planRotationZone.setSelected(this.planDisplay.planFrame.rotatingWith);
  }
}
