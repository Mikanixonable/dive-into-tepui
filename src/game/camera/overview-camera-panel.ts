import { IconToggleButton } from '../hud/buttons';
import { hudDock } from '../hud/dom';
import { BodyClassToggles } from '../celestial/body-visibility';

// クラス別トグルの1行分。orbitKey が null のクラス(衛星・ラグランジュ点)は軌道線ボタンを持たない
// ——衛星の参照軌道線はフォーカス中の系かどうかで別途決まり、ラグランジュ点はそもそも軌道を持たない。
type BodyClassRow = {
  readonly label: string;
  readonly iconKey: keyof BodyClassToggles;
  readonly labelKey: keyof BodyClassToggles;
  readonly orbitKey: keyof BodyClassToggles | null;
};

const BODY_CLASS_ROWS: readonly BodyClassRow[] = [
  { label: '惑星', iconKey: 'planetIcon', labelKey: 'planetLabel', orbitKey: 'planetOrbit' },
  { label: '衛星', iconKey: 'satelliteIcon', labelKey: 'satelliteLabel', orbitKey: 'satelliteOrbit' },
  { label: '準惑星', iconKey: 'dwarfIcon', labelKey: 'dwarfLabel', orbitKey: 'dwarfOrbit' },
  { label: '小天体', iconKey: 'smallBodyIcon', labelKey: 'smallBodyLabel', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', iconKey: 'lagrangeIcon', labelKey: 'lagrangeLabel', orbitKey: null },
];
const ENTITY_ROWS: readonly BodyClassRow[] = [
  { label: '宇宙船', iconKey: 'playerIcon', labelKey: 'playerLabel', orbitKey: 'playerOrbit' },
  { label: '敵', iconKey: 'shipIcon', labelKey: 'shipLabel', orbitKey: 'shipOrbit' },
  { label: '弾薬', iconKey: 'ammoIcon', labelKey: 'ammoLabel', orbitKey: 'ammoOrbit' },
  { label: '基地', iconKey: 'baseIcon', labelKey: 'baseLabel', orbitKey: 'baseOrbit' },
];

export class OverviewCameraPanel {
  onBodyClassToggle: ((key: keyof BodyClassToggles, on: boolean) => void) | null = null;
  private readonly bodyClassButtons: readonly (readonly [keyof BodyClassToggles, IconToggleButton])[];

  private readonly panel: HTMLElement;

  constructor(root: HTMLElement) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-overview-camera';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '表示';
    this.panel.appendChild(title);

    // マップに出す天体のクラスごとに、アイコン(点)・ラベル(名前)・軌道線を個別に切り替える。
    // 恒星・惑星と、フォーカス中の系の親子は常に出るので、ここで足すのは「その外まで見たい」
    // という明示の意思表示にあたる。
    const buttons: (readonly [keyof BodyClassToggles, IconToggleButton])[] = [];
    for (const row of [...BODY_CLASS_ROWS, ...ENTITY_ROWS]) {
      const rowEl = document.createElement('div');
      rowEl.className = `body-class-row${row.label === '惑星' ? ' planet-row' : ''}`;
      const titleEl = document.createElement('span');
      titleEl.className = 'body-class-title';
      titleEl.textContent = row.label;
      rowEl.appendChild(titleEl);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);

      const icon = new IconToggleButton('●', 'アイコン', (on) => this.onBodyClassToggle?.(row.iconKey, on));
      icon.setOn(false);
      btnsEl.appendChild(icon.element);
      buttons.push([row.iconKey, icon]);

      const label = new IconToggleButton('Aa', 'ラベル', (on) => this.onBodyClassToggle?.(row.labelKey, on));
      label.setOn(false);
      btnsEl.appendChild(label.element);
      buttons.push([row.labelKey, label]);

      if (row.orbitKey !== null) {
        const orbitKey = row.orbitKey;
        const orbit = new IconToggleButton('⌒', '軌道線', (on) => this.onBodyClassToggle?.(orbitKey, on));
        orbit.setOn(false);
        btnsEl.appendChild(orbit.element);
        buttons.push([orbitKey, orbit]);
      }

      this.panel.appendChild(rowEl);
    }
    this.bodyClassButtons = buttons;

    hudDock(root, 'left').appendChild(this.panel);
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // クラス別トグルの表示状態を現在値へ合わせる。
  setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [key, btn] of this.bodyClassButtons) btn.setOn(toggles[key]);
  }
}
