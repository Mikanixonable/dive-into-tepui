// マップモードの「座標系」パネル。計画折れ線の原点とマップカメラの回転を、
// 1つのパネルから書き換える横断。状態そのものは両クラスに置いたままにし、
// ここは参照を受け取って書くだけに留める。
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
  private readonly originZone: AnchorZone;
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

    // 原点ゾーンには解除を出さない: 描く線は必ずどこかの座標系に焼き込まれるので
    // 「どこにも固定しない」状態が無く、太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.originZone = new AnchorZone(popupRoot, '原点', ephemeris, null);
    this.originZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.originZone.onSelect = (id) => {
      if (id === null) return;
      planDisplay.planFrame = ephemeris.frameOf(id, planDisplay.planFrame.rotatingWith);
    };
    this.panel.appendChild(this.originZone.element);

    this.cameraRotationZone = new RotationZone('回転', ephemeris);
    this.cameraRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
    this.cameraRotationZone.onSelect = (rotatingWith) => overviewCamera.setCameraRotation(rotatingWith);
    this.panel.appendChild(this.cameraRotationZone.element);

    hudDock(panelRoot, 'left').appendChild(this.panel);
  }

  // パネルの表示と2ゾーンの選択肢・選択表示を、他モジュールの状態へ合わせる。
  sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, attractors: readonly Attractor[],
    visible: boolean,
  ): void {
    this.panel.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const members = systemMembersAt(this.ephemeris.registry, cameraPos, attractors);

    this.cameraRotationZone.setNearby(members);
    this.cameraRotationZone.setSelected(this.overviewCamera.cameraFrame.rotatingWith);

    this.originZone.setItems(pickables);
    this.originZone.setNearby(members, pickables);
    this.originZone.setSelected(this.planDisplay.planFrame.center);
  }
}
