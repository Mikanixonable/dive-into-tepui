// 広範囲視点の操作パネル(注視対象・カメラを固定する座標系・視点リセット)。
import { Frame } from '../../physics/frame';
import { SegmentedControl, hudButton } from '../hud/buttons';
import { FRAME_ITEMS } from '../hud/frame-labels';

export class OverviewCameraPanel {
  onFocusSelect: ((focus: string) => void) | null = null;
  onFrameSelect: ((frame: Frame) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly focus: SegmentedControl<string>;
  private readonly frame: SegmentedControl<Frame>;

  // focusItems は [ラベル ID, 表示名] の並び。常用の数個だけを渡す。
  constructor(root: HTMLElement, focusItems: readonly (readonly [string, string])[]) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-overview-camera';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'MAP VIEW';
    this.panel.appendChild(title);

    // 注視対象と視点座標系の選択コントロール
    this.focus = new SegmentedControl('注視', focusItems, (id) => this.onFocusSelect?.(id));
    this.frame = new SegmentedControl('視点', FRAME_ITEMS, (frame) => this.onFrameSelect?.(frame));
    this.panel.appendChild(this.focus.element);
    this.panel.appendChild(this.frame.element);



    root.appendChild(this.panel);
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // 注視対象の選択表示を更新する。
  setFocus(focus: string): void {
    this.focus.setSelected(focus);
  }

  // 視点座標系の選択表示を更新する。
  setFrame(frame: Frame): void {
    this.frame.setSelected(frame);
  }
}
