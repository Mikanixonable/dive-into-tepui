import { ReferenceFrame } from '../../physics/frame';
import { SegmentedControl, HudToggle } from '../hud/buttons';
import { FRAME_ITEMS } from '../hud/frame-labels';
import { hudDock } from '../hud/dom';

export class OverviewCameraPanel {
  onFrameSelect: ((frame: ReferenceFrame) => void) | null = null;
  onAmmoToggle: ((show: boolean) => void) | null = null;

  showAmmo = false;
  private readonly ammoToggle: HudToggle;

  private readonly panel: HTMLElement;
  private readonly frame: SegmentedControl<ReferenceFrame>;

  constructor(root: HTMLElement) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-overview-camera';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'MAP VIEW';
    this.panel.appendChild(title);

    // 視点座標系の選択コントロール
    this.frame = new SegmentedControl('視点', FRAME_ITEMS, (frame) => this.onFrameSelect?.(frame));
    this.panel.appendChild(this.frame.element);

    this.ammoToggle = new HudToggle('弾薬', (on) => {
      this.showAmmo = on;
      this.onAmmoToggle?.(on);
    });
    this.ammoToggle.setOn(false);
    this.panel.appendChild(this.ammoToggle.element);

    hudDock(root, 'left').appendChild(this.panel);
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // 視点座標系の選択表示を更新する。
  setFrame(frame: ReferenceFrame): void {
    this.frame.setSelected(frame);
  }
}
