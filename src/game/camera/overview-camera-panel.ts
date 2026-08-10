import { HudToggleButton, IconToggleButton } from '../hud/buttons';
import { hudDock } from '../hud/dom';
import { BodyClassToggles } from '../celestial/body-visibility';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';

// クラス別トグルの1行分。orbitKey が null のクラス(衛星・ラグランジュ点)は軌道線ボタンを持たない
// ——衛星の参照軌道線はフォーカス中の系かどうかで別途決まり、ラグランジュ点はそもそも軌道を持たない。
type BodyClassRow = {
  readonly label: string;
  readonly categoryKey: keyof BodyClassToggles;
  readonly iconKey: keyof BodyClassToggles;
  readonly labelKey: keyof BodyClassToggles;
  readonly orbitKey: keyof BodyClassToggles | null;
};

const BODY_CLASS_ROWS: readonly BodyClassRow[] = [
  { label: '惑星', categoryKey: 'planetVisible', iconKey: 'planetIcon', labelKey: 'planetLabel', orbitKey: 'planetOrbit' },
  { label: '衛星', categoryKey: 'satelliteVisible', iconKey: 'satelliteIcon', labelKey: 'satelliteLabel', orbitKey: 'satelliteOrbit' },
  { label: '準惑星', categoryKey: 'dwarfVisible', iconKey: 'dwarfIcon', labelKey: 'dwarfLabel', orbitKey: 'dwarfOrbit' },
  { label: '小天体', categoryKey: 'smallBodyVisible', iconKey: 'smallBodyIcon', labelKey: 'smallBodyLabel', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', categoryKey: 'lagrangeVisible', iconKey: 'lagrangeIcon', labelKey: 'lagrangeLabel', orbitKey: null },
];
const ENTITY_ROWS: readonly BodyClassRow[] = [
  { label: '自艦', categoryKey: 'playerVisible', iconKey: 'playerIcon', labelKey: 'playerLabel', orbitKey: 'playerOrbit' },
  { label: '敵', categoryKey: 'shipVisible', iconKey: 'shipIcon', labelKey: 'shipLabel', orbitKey: 'shipOrbit' },
  { label: '弾薬', categoryKey: 'ammoVisible', iconKey: 'ammoIcon', labelKey: 'ammoLabel', orbitKey: 'ammoOrbit' },
  { label: '基地', categoryKey: 'baseVisible', iconKey: 'baseIcon', labelKey: 'baseLabel', orbitKey: 'baseOrbit' },
];

export class OverviewCameraPanel {
  onBodyClassToggle: ((key: keyof BodyClassToggles, on: boolean) => void) | null = null;
  private readonly bodyClassButtons: readonly (readonly [keyof BodyClassToggles, IconToggleButton])[];
  private readonly categoryButtons: readonly (readonly [keyof BodyClassToggles, HudToggleButton, HTMLElement, readonly IconToggleButton[]])[];

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
    const categories: (readonly [keyof BodyClassToggles, HudToggleButton, HTMLElement, readonly IconToggleButton[]])[] = [];
    for (const row of [...BODY_CLASS_ROWS, ...ENTITY_ROWS]) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row';
      const category = new HudToggleButton(row.label, `${row.label}を表示`, (on) => this.onBodyClassToggle?.(row.categoryKey, on));
      category.element.classList.add('body-class-title');
      rowEl.appendChild(category.element);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);
      const individualButtons: IconToggleButton[] = [];

      const icon = new IconToggleButton(ENTITY_GLYPH.body, 'アイコン', (on) => this.onBodyClassToggle?.(row.iconKey, on));
      icon.setOn(false);
      individualButtons.push(icon);
      btnsEl.appendChild(icon.element);
      buttons.push([row.iconKey, icon]);

      const label = new IconToggleButton('Aa', 'ラベル', (on) => this.onBodyClassToggle?.(row.labelKey, on));
      label.setOn(false);
      individualButtons.push(label);
      btnsEl.appendChild(label.element);
      buttons.push([row.labelKey, label]);

      if (row.orbitKey !== null) {
        const orbitKey = row.orbitKey;
        const orbit = new IconToggleButton('⌒', '軌道線', (on) => this.onBodyClassToggle?.(orbitKey, on));
        orbit.setOn(false);
        individualButtons.push(orbit);
        btnsEl.appendChild(orbit.element);
        buttons.push([orbitKey, orbit]);
      }

      this.panel.appendChild(rowEl);
      categories.push([row.categoryKey, category, rowEl, individualButtons]);
    }
    this.bodyClassButtons = buttons;
    this.categoryButtons = categories;

    hudDock(root, 'left').appendChild(this.panel);
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // クラス別トグルの表示状態を現在値へ合わせる。
  setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [key, btn] of this.bodyClassButtons) btn.setOn(toggles[key]);
    for (const [key, category, row, buttons] of this.categoryButtons) {
      const enabled = Boolean(toggles[key]);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
      for (const btn of buttons) btn.setEnabled(enabled);
    }
  }
}
