// マップモードの「座標系」パネル。OverviewCamera(カメラの注視対象・回転)と PlanDisplay
// (計画折れ線の原点・回転)という2つの所有者の状態を、1つのパネルから書き換える横断。
// 状態そのものは両クラスに置いたままにし、ここは参照を受け取って書くだけに留める。
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { Vec3 } from '../physics/vec3';
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
  // sync が最後に渡した Attractor[]。onSelect は DOM イベント経由でフレーム外から呼ばれるので、
  // 解除操作が焼き込み先の時刻を求めるのに使う(要素はすべて同一時刻の状態を持つ)。
  private lastAttractors: readonly Attractor[] = [];

  constructor(
    hudRoot: HTMLElement,
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

    this.cameraZone = new AnchorZone(hudRoot, 'カメラ', ephemeris, '固定を解除');
    this.cameraZone.onSelect = (id) => this.selectCameraAnchor(id);
    this.panel.appendChild(this.cameraZone.element);

    this.cameraRotationZone = new RotationZone('カメラ回転', ephemeris);
    this.cameraRotationZone.onSelect = (rotatingWith) => overviewCamera.setCameraRotation(rotatingWith);
    this.panel.appendChild(this.cameraRotationZone.element);

    // 並進ゾーンには解除を出さない: 描く線は必ずどこかの座標系に焼き込まれるので
    // 「どこにも固定しない」状態が無く、太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.translationZone = new AnchorZone(hudRoot, '並進', ephemeris, null);
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

    hudDock(hudRoot, 'left').appendChild(this.panel);
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
    const t = this.lastAttractors[0]?.state.t ?? 0;
    this.overviewCamera.setFocusTarget(focusPoint(this.ephemeris, frame, this.overviewCamera.resolvedFocus, t));
  }

  // パネルの表示と4ゾーンの選択肢・選択表示を、他モジュールの状態(注視対象・両座標系)へ合わせる。
  sync(pickables: readonly MapPickable[], cameraPos: Vec3, attractors: readonly Attractor[], visible: boolean): void {
    this.lastAttractors = attractors;
    this.panel.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    this.cameraZone.setItems(pickables);
    this.cameraZone.setNearby(cameraPos, attractors, pickables);
    this.cameraZone.setSelected(focusTargetId(this.overviewCamera.focus) ?? null);

    this.cameraRotationZone.setNearby(cameraPos, attractors);
    this.cameraRotationZone.setSelected(this.overviewCamera.cameraFrame.rotatingWith);

    this.translationZone.setItems(pickables);
    this.translationZone.setNearby(cameraPos, attractors, pickables);
    this.translationZone.setSelected(this.planDisplay.planFrame.center);

    this.planRotationZone.setNearby(cameraPos, attractors);
    this.planRotationZone.setSelected(this.planDisplay.planFrame.rotatingWith);
  }
}
