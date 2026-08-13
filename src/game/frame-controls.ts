// マップモードの「座標系」パネル。マップカメラの視点と未来表示(計画折れ線・予測軌道線・
// 交点マーカー)の描画基準という、別々の持ち主にある2つの座標系を1つのパネルから書き換える
// 横断。状態そのものは両クラスに置いたままにし、ここは参照を受け取って書くだけに留める。
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { Vec3 } from '../physics/vec3';
import { systemMembersAt } from './celestial/body-visibility';
import { OverviewCamera } from './camera/overview-camera';
import { focusPoint, focusTargetId, FocusTarget } from './camera/focus-target';
import { AnchorZone } from './hud/anchor-zone';
import { RotationZone } from './hud/rotation-zone';
import { ToggleSwitch } from './hud/widgets';
import { celestialBodyName } from './hud/frame-labels';
import { hudDock } from './hud/dom';
import { TEXT_DIM } from './theme';
import type { MapPickable } from './map-pick';
import type { DisplayWindowManager } from './display-window-manager';
import type { OverlayManager } from './hud/overlay-manager';

const STYLE = `
#hud .frame-section { margin-top: 8px; }
#hud .frame-section:first-of-type { margin-top: 0; }
#hud .frame-section-title { font-size: 10px; color: ${TEXT_DIM}; letter-spacing: 0.08em; margin-bottom: 3px; }
#hud .frame-summary { font-size: 10px; color: ${TEXT_DIM}; margin-top: 6px; }
`;

let styleInjected = false;
// パネルのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 見出し付きの区画を組み、中身を入れる箱を返す。
function buildSection(parent: HTMLElement, title: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'frame-section';
  const heading = document.createElement('div');
  heading.className = 'frame-section-title';
  heading.textContent = title;
  section.appendChild(heading);
  parent.appendChild(section);
  return section;
}

export class FrameControls {
  private readonly panel: HTMLElement;
  private readonly cameraCenterZone: AnchorZone;
  private readonly cameraRotationZone: RotationZone;
  private readonly planCenterZone: AnchorZone;
  private readonly planRotationZone: RotationZone;
  private readonly followToggle: ToggleSwitch;
  private readonly summary: HTMLElement;
  // 計画折れ線の中心をカメラの注視対象へ追随させるか。表示を変えるだけの操作(フォーカス移動)が
  // 描画基準まで動かすと、線の形が変わった理由が操作から読めなくなるので、明示の選択にする。
  private followCamera = true;
  // 固定解除は DOM イベント(フレームの外)から起きるので、直近の sync が見た時刻を控える。
  private lastTime = 0;

  // panelRoot はパネル自体(左ドック)の置き場所、popupRoot は ObjectPicker のポップアップの置き場所。
  constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly ephemeris: Ephemeris,
    private readonly overviewCamera: OverviewCamera,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
  ) {
    ensureStyle();
    this.panel = document.createElement('div');
    this.panel.id = 'hud-frame-controls';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '座標系';
    this.panel.appendChild(title);

    const cameraSection = buildSection(this.panel, 'カメラ(視点)');
    this.cameraCenterZone = new AnchorZone(popupRoot, '基準にする天体', ephemeris, '固定を解除', overlayManager);
    this.cameraCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.cameraCenterZone.onSelect = (id) => this.selectCameraCenter(id);
    cameraSection.appendChild(this.cameraCenterZone.element);

    this.cameraRotationZone = new RotationZone('視点を一緒に回す', ephemeris);
    this.cameraRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
    this.cameraRotationZone.onSelect = (rotatingWith) => overviewCamera.setCameraRotation(rotatingWith);
    cameraSection.appendChild(this.cameraRotationZone.element);

    const planSection = buildSection(this.panel, '軌道計画(描画基準)');
    // 描く線は必ずどこかの座標系に焼き込まれるので「どこにも固定しない」状態が無く、
    // 太陽系空間への固定はプルダウンの恒星そのものにあたる。
    this.planCenterZone = new AnchorZone(popupRoot, '基準にする天体', ephemeris, null, overlayManager);
    this.planCenterZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-origin-zone');
    this.planCenterZone.onSelect = (id) => {
      if (id === null) return;
      displayWindow.frame = ephemeris.frameOf(id, displayWindow.frame.rotatingWith);
    };
    planSection.appendChild(this.planCenterZone.element);

    this.planRotationZone = new RotationZone('線を一緒に回す', ephemeris);
    this.planRotationZone.element.classList.add('hud-frame-scroll-zone', 'hud-frame-rotation-zone');
    this.planRotationZone.onSelect = (rotatingWith) => {
      displayWindow.frame = ephemeris.frameOf(displayWindow.frame.center, rotatingWith);
    };
    planSection.appendChild(this.planRotationZone.element);

    this.followToggle = new ToggleSwitch('カメラの基準に追随', (on: boolean) => { this.followCamera = on; });
    this.followToggle.setOn(this.followCamera);
    planSection.appendChild(this.followToggle.element);

    this.summary = document.createElement('div');
    this.summary.className = 'frame-summary';
    this.panel.appendChild(this.summary);

    hudDock(panelRoot, 'left').appendChild(this.panel);
  }

  // カメラの基準天体を選び直す。解除は、いま見ている位置を恒星中心の慣性系へ焼き込んだ
  // 固定点にする — どの天体にも追随しないが、視線はその場に留まる。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const starId = this.ephemeris.starId;
    const frame = starId !== null ? this.ephemeris.frameOf(starId, null) : this.ephemeris.inertialFrame;
    this.setFocus(focusPoint(this.ephemeris, frame, this.overviewCamera.resolvedFocus, this.lastTime));
  }

  // マップカメラのフォーカスを target へ移す。追随が有効で target が登録天体を指しているときは
  // 計画折れ線の中心も同じ天体へ合わせる(回転側は現状を保つ)。
  setFocus(target: FocusTarget): void {
    this.overviewCamera.setFocusTarget(target);
    if (!this.followCamera) return;
    const id = focusTargetId(target);
    if (id !== undefined && id in this.ephemeris.registry) {
      this.displayWindow.frame = this.ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    }
  }

  // いま選ばれている2つの座標系を1行で述べる。
  private summaryText(): string {
    const camId = focusTargetId(this.overviewCamera.focus);
    const camCenter = camId === undefined ? '固定なし' : celestialBodyName(camId);
    const camRot = this.overviewCamera.cameraFrame.rotatingWith;
    const planCenter = celestialBodyName(this.displayWindow.frame.center);
    const planRot = this.displayWindow.frame.rotatingWith;
    const rotText = (id: string | null): string => (id === null ? '慣性系' : `${celestialBodyName(id)}回転系`);
    return `カメラ: ${camCenter}・${rotText(camRot)} / 計画: ${planCenter}・${rotText(planRot)}`;
  }

  // パネルの表示と4ゾーンの選択肢・選択表示を、他モジュールの状態へ合わせる。
  sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, attractors: readonly Attractor[],
    simTime: number, visible: boolean,
  ): void {
    this.lastTime = simTime;
    this.panel.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const members = systemMembersAt(this.ephemeris.registry, cameraPos, attractors);

    this.cameraCenterZone.setItems(pickables);
    this.cameraCenterZone.setNearby(members, pickables);
    this.cameraCenterZone.setSelected(focusTargetId(this.overviewCamera.focus) ?? null);
    this.cameraRotationZone.setNearby(members);
    this.cameraRotationZone.setSelected(this.overviewCamera.cameraFrame.rotatingWith);

    this.planCenterZone.setItems(pickables);
    this.planCenterZone.setNearby(members, pickables);
    this.planCenterZone.setSelected(this.displayWindow.frame.center);
    this.planRotationZone.setNearby(members);
    this.planRotationZone.setSelected(this.displayWindow.frame.rotatingWith);

    this.followToggle.setOn(this.followCamera);
    this.summary.textContent = this.summaryText();
  }
}
