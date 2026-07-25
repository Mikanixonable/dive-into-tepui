// マップ視点の操作パネル(注視対象・カメラを固定する座標系・視点リセット)。CameraSystem が
// 所有し、映すのも受けるのも mapCamera の状態だけに閉じる。注視対象の表示名は MapMarkers の
// ラベル名をそのまま受け取るので、名前の定義はここに重複しない。
// CSS(#hud-mapview)は hud/dom.ts の STYLE に一元管理されている。
import { Frame } from '../../physics/frame';
import { SegmentedControl, hudButton } from '../hud/buttons';

const FRAMES: readonly (readonly [Frame, string])[] = [
  ['inertial', '慣性系'],
  ['sunRotating', '太陽回転系'],
];

export class MapViewPanel {
  onFocusSelect: ((focus: string) => void) | null = null;
  onFrameSelect: ((frame: Frame) => void) | null = null;
  onViewReset: (() => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly focus: SegmentedControl<string>;
  private readonly frame: SegmentedControl<Frame>;

  // focusItems は [ラベル ID, 表示名] の並び。全ラベルへのフォーカスは右クリックメニュー
  // (FocusGizmo)が担うので、ここには常用の数個だけを渡す。
  constructor(root: HTMLElement, focusItems: readonly (readonly [string, string])[]) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-mapview';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'MAP VIEW';
    this.panel.appendChild(title);

    this.focus = new SegmentedControl('注視', focusItems, (id) => this.onFocusSelect?.(id));
    this.frame = new SegmentedControl('視点', FRAMES, (frame) => this.onFrameSelect?.(frame));
    this.panel.appendChild(this.focus.element);
    this.panel.appendChild(this.frame.element);

    const resetRow = document.createElement('div');
    resetRow.className = 'hud-seg';
    resetRow.appendChild(hudButton('視点リセット', () => this.onViewReset?.()));
    this.panel.appendChild(resetRow);

    root.appendChild(this.panel);
  }

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  setFocus(focus: string): void {
    this.focus.setSelected(focus);
  }

  setFrame(frame: Frame): void {
    this.frame.setSelected(frame);
  }
}
