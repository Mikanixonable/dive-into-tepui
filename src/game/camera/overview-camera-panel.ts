import { HudToggle } from '../hud/buttons';
import { hudDock } from '../hud/dom';
import { BodyClassToggles } from '../celestial/body-visibility';

// クラス別トグルの表示名。恒星と惑星は常時表示なのでトグルを持たない。軌道線とラベルを
// 別々に切り替えられるクラスは1クラスにつき2行になる。
const BODY_CLASS_LABELS: readonly (readonly [keyof BodyClassToggles, string])[] = [
  ['satelliteLabel', '衛星'],
  ['dwarfOrbit', '準惑星: 軌道'],
  ['dwarfLabel', '準惑星: ラベル'],
  ['smallBodyOrbit', '小天体: 軌道'],
  ['smallBodyLabel', '小天体: ラベル'],
  ['lagrange', 'ラグランジュ点'],
];

export class OverviewCameraPanel {
  onAmmoToggle: ((show: boolean) => void) | null = null;
  onBodyClassToggle: ((key: keyof BodyClassToggles, on: boolean) => void) | null = null;

  showAmmo = false;
  private readonly ammoToggle: HudToggle;
  private readonly bodyClassToggles: readonly (readonly [keyof BodyClassToggles, HudToggle])[];

  private readonly panel: HTMLElement;

  constructor(root: HTMLElement) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-overview-camera';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'MAP VIEW';
    this.panel.appendChild(title);

    this.ammoToggle = new HudToggle('弾薬', (on) => {
      this.showAmmo = on;
      this.onAmmoToggle?.(on);
    });
    this.ammoToggle.setOn(false);
    this.panel.appendChild(this.ammoToggle.element);

    // マップに出す天体のクラス。恒星・惑星と、フォーカス中の系の親子は常に出るので、
    // ここで足すのは「その外まで全部見たい」という明示の意思表示にあたる。
    this.bodyClassToggles = BODY_CLASS_LABELS.map(([key, label]) => {
      const toggle = new HudToggle(label, (on) => this.onBodyClassToggle?.(key, on));
      toggle.setOn(false);
      this.panel.appendChild(toggle.element);
      return [key, toggle] as const;
    });

    hudDock(root, 'left').appendChild(this.panel);
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // クラス別トグルの表示状態を現在値へ合わせる。
  setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [key, toggle] of this.bodyClassToggles) toggle.setOn(toggles[key]);
  }
}
