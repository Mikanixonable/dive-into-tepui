// マップモードの「座標系」パネル。OverviewCamera(カメラの注視対象・回転)と PlanDisplay
// (計画折れ線の原点・回転)という2つの所有者の状態を、1つのパネルから書き換える横断。
// 状態そのものは両クラスに置いたままにし、ここは参照を受け取って書くだけに留める。
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { Vec3 } from '../physics/vec3';
import { systemMembersAt } from './celestial/body-visibility';
import { OverviewCamera } from './camera/overview-camera';
import { focusPoint, focusTargetId } from './camera/focus-target';
import { AnchorZone } from './hud/anchor-zone';
import { RotationZone } from './hud/rotation-zone';
import { hudDock } from './hud/dom';
import type { MapPickable } from './map-pick';
import type { PlanDisplay } from './plan/plan-display';

export class FrameControls {
  private readonly panel: HTMLElement;
  private readonly cameraZone: AnchorZone;
  private readonly cameraRotationZone: RotationZone;
  private readonly translationZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  // DOMイベントから呼ばれる選択処理が、注視点を固定点へ焼き込む時刻。
  private lastTime = 0;
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

    this.cameraZone = new AnchorZone(popupRoot, 'カメラ', ephemeris, '固定を解除');
    this.cameraZone.onSelect = (id) => this.selectCameraAnchor(id);
    this.panel.appendChild(this.cameraZone.element);

    // 並進ゾーンには解除を出さない: 描く線は必ずどこかの座標系に焼き込まれるので
    // 「どこにも固定しない」状態が無く、太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.translationZone = new AnchorZone(popupRoot, '原点', ephemeris, null);
    this.translationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.translationZone.onSelect = (id) => {
      if (id === null) return;
      planDisplay.planFrame = ephemeris.frameOf(id, planDisplay.planFrame.rotatingWith);
    };
    this.panel.appendChild(this.translationZone.element);

    this.cameraRotationZone = new RotationZone('回転', ephemeris);
    this.cameraRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-camera-rotation-zone');
    this.cameraRotationZone.onSelect = (rotatingWith) => overviewCamera.setCameraRotation(rotatingWith);
    this.panel.appendChild(this.cameraRotationZone.element);

    this.planRotationZone = new RotationZone('計画軌道回転', ephemeris);
    this.planRotationZone.onSelect = (rotatingWith) => {
      planDisplay.planFrame = ephemeris.frameOf(planDisplay.planFrame.center, rotatingWith);
    };
    this.panel.appendChild(this.planRotationZone.element);

    hudDock(panelRoot, 'left').appendChild(this.panel);
  }

  // カメラの固定を解除する: いまの注視点を、恒星中心の慣性系へその場に置き去りにする
  // (恒星が無いレジストリでは焼き込み先が無いので ephemeris.inertialFrame に倒す)。
  private selectCameraAnchor(id: string | null): void {
    if (id !== null) {
      this.overviewCamera.setFocusTarget({ kind: 'object', id });
      return;
    }
    const frame = this.ephemeris.starId !== null
      ? this.ephemeris.frameOf(this.ephemeris.starId, null)
      : this.ephemeris.inertialFrame;
    this.overviewCamera.setFocusTarget(focusPoint(this.ephemeris, frame, this.overviewCamera.resolvedFocus, this.lastTime));
  }

  // パネルの表示と4ゾーンの選択肢・選択表示を、他モジュールの状態(注視対象・両座標系)へ合わせる。
  sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, attractors: readonly Attractor[],
    simTime: number, visible: boolean,
  ): void {
    this.lastTime = simTime;
    this.panel.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const members = systemMembersAt(this.ephemeris.registry, cameraPos, attractors);

    this.cameraZone.setItems(pickables);
    this.cameraZone.setNearby(members, pickables);
    this.cameraZone.setSelected(focusTargetId(this.overviewCamera.focus) ?? null);

    this.cameraRotationZone.setNearby(members);
    this.cameraRotationZone.setSelected(this.overviewCamera.cameraFrame.rotatingWith);

    this.translationZone.setItems(pickables);
    this.translationZone.setNearby(members, pickables);
    this.translationZone.setSelected(this.planDisplay.planFrame.center);

    this.planRotationZone.setNearby(members);
    this.planRotationZone.setSelected(this.planDisplay.planFrame.rotatingWith);
  }
}
