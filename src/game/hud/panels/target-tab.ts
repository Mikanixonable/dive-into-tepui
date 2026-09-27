// 表示パネル(マップモード左レール)の対象タブ。マップに出す対象クラスごとに、
// ラベル+軌道 / ラベル / 非表示を1ボタンで循環させる。天体群と機体・設備群を
// 見出しで区切って並べる。
import { Button } from '../../../hud/widgets';
import {
  mapDisplayModeOf,
  nextMapDisplayMode,
  type MapDisplayCategory,
  type MapDisplayMode,
  type MapDisplayToggles,
} from '../../map/display-toggles';

// クラス別トグルの1行分。orbitKey が null のクラス(ラグランジュ点)は軌道を持たず、ラベルと
// 非表示だけを循環する。
interface BodyClassRow {
  readonly label: string;
  readonly categoryKey: MapDisplayCategory;
  readonly orbitKey: keyof MapDisplayToggles | null;
}

// 天体のクラス別トグル。
const BODY_CLASS_ROWS: readonly BodyClassRow[] = [
  { label: '惑星', categoryKey: 'planetVisible', orbitKey: 'planetOrbit' },
  { label: '衛星', categoryKey: 'satelliteVisible', orbitKey: 'satelliteOrbit' },
  { label: '準惑星', categoryKey: 'dwarfVisible', orbitKey: 'dwarfOrbit' },
  { label: '小天体', categoryKey: 'smallBodyVisible', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', categoryKey: 'lagrangeVisible', orbitKey: null },
];

// 機体と設備のクラス別トグル。
const ENTITY_ROWS: readonly BodyClassRow[] = [
  { label: '自艦', categoryKey: 'playerVisible', orbitKey: 'playerOrbit' },
  { label: '敵', categoryKey: 'enemyVisible', orbitKey: 'enemyOrbit' },
  { label: '弾薬', categoryKey: 'ammoVisible', orbitKey: 'ammoOrbit' },
  { label: 'RCS燃料', categoryKey: 'fuelVisible', orbitKey: 'fuelOrbit' },
  { label: '基地', categoryKey: 'baseVisible', orbitKey: 'baseOrbit' },
];

// 対象クラスの表示状態を文字ではなく、ラベル・軌道・非表示を連想できる SVG で示す。
// Button の共通アイコン枠へ入れるため、ここは信頼できる固定マークアップだけを返す。
const BODY_CLASS_DISPLAY_ICONS: Readonly<Record<MapDisplayMode, string>> = {
  hidden: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M5.1 5.1C3.4 6.5 2.4 8.4 2 12c.7 3.1 2.7 5.4 5.2 6.8"/><path d="M9.7 19.2c.7.2 1.5.3 2.3.3 5.4 0 9.2-4.4 10-7.5-.3-1.3-1-2.6-2.2-3.8"/></svg>',
  label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10.5L20 12l-5.5 7H4z"/><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>',
  orbit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-28 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(28 12 12)"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
};

// 表示モード mode を示すアイコンの SVG マークアップ。
function bodyClassDisplayIcon(mode: MapDisplayMode): string {
  return BODY_CLASS_DISPLAY_ICONS[mode];
}

// 列見出しの凡例を持たない、グループ間の細い区切り(天体/機体と設備のようなサブグループを
// ラベルだけで区切る)。
function appendSectionDivider(parent: HTMLElement, title: string): void {
  const divider = document.createElement('div');
  divider.className = 'view-options-section-divider editorial-divider';
  divider.textContent = title;
  parent.appendChild(divider);
}

export class TargetTab {
  // 対象クラスの表示モードが切り替わるたびに、そのクラスと次のモードで呼ばれる。
  public onModeChange: ((key: MapDisplayCategory, mode: MapDisplayMode) => void) | null = null;

  private readonly modeButtons: readonly (readonly [BodyClassRow, Button, HTMLElement])[];
  // 各ボタンの現在の表示モードの鏡映し。クリック時に次の状態を決めるのに使う。
  private readonly modes = new Map<MapDisplayCategory, MapDisplayMode>();

  // parent(対象タブの本体)の末尾へタブの内容を組み込む。
  public constructor(parent: HTMLElement) {
    // 循環の順序は常時表示しておく — ボタンのホバー説明だけに置くとタッチでは読めない。
    const modeLegend = document.createElement('p');
    modeLegend.className = 'view-options-mode-legend';
    modeLegend.textContent = '表示はクリックで ORBIT → LABEL → OFF の順に切り替わる';
    parent.appendChild(modeLegend);
    const modeButtons: (readonly [BodyClassRow, Button, HTMLElement])[] = [];
    let itemIndex = 1;

    // 天体/機体と設備の2群を見出しで区切り、各行に循環ボタンを1つ置く。
    const rowGroups: readonly { readonly title: string; readonly rows: readonly BodyClassRow[] }[] = [
      { title: '天体', rows: BODY_CLASS_ROWS },
      { title: '機体と設備', rows: ENTITY_ROWS },
    ];
    for (const group of rowGroups) {
      appendSectionDivider(parent, group.title);
      const groupEl = document.createElement('div');
      groupEl.className = 'target-class-group';
      for (const row of group.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'body-class-row target-class-row editorial-index-row';
        rowEl.dataset['index'] = String(itemIndex++).padStart(2, '0');
        const modeButton = new Button(row.label, () => {
          const current = this.modes.get(row.categoryKey) ?? 'hidden';
          const next = nextMapDisplayMode(current, row.orbitKey !== null);
          this.modes.set(row.categoryKey, next);
          this.setModeButton(modeButton, row.label, next, row.orbitKey !== null);
          this.onModeChange?.(row.categoryKey, next);
        }, bodyClassDisplayIcon('hidden'));
        modeButton.element.classList.add('body-class-title', 'body-class-mode-button');
        rowEl.appendChild(modeButton.element);
        groupEl.appendChild(rowEl);
        modeButtons.push([row, modeButton, rowEl]);
      }
      parent.appendChild(groupEl);
    }
    this.modeButtons = modeButtons;
  }

  // クラス別の表示状態を現在値へ合わせる。
  public sync(toggles: MapDisplayToggles): void {
    for (const [config, button, row] of this.modeButtons) {
      const mode = mapDisplayModeOf(toggles, config.categoryKey);
      this.modes.set(config.categoryKey, mode);
      this.setModeButton(button, config.label, mode, config.orbitKey !== null);
      row.classList.toggle('category-off', mode === 'hidden');
    }
  }

  // ボタンの点灯・アイコン・説明文を、現在のモードへ合わせる。説明文には次にクリックしたときの
  // 遷移先も含める。
  private setModeButton(
    button: Button, label: string, mode: MapDisplayMode, hasOrbit: boolean,
  ): void {
    // 現在値と、次にクリックしたときの遷移先から説明文を組む。
    const modeLabel = mode === 'orbit' ? 'ラベル＋軌道' : mode === 'label' ? 'ラベル' : '非表示';
    const next = nextMapDisplayMode(mode, hasOrbit);
    const nextLabel = next === 'orbit' ? 'ラベル＋軌道' : next === 'label' ? 'ラベル' : '非表示';
    const description = `${label}: ${modeLabel}。クリックで${nextLabel}`;
    // 点灯・アイコン・aria 属性へ反映する。
    button.setOn(mode !== 'hidden');
    button.element.dataset.displayMode = mode;
    button.element.dataset['displayLabel'] = mode === 'orbit' ? 'ORBIT' : mode === 'label' ? 'LABEL' : 'OFF';
    const icon = button.element.querySelector<HTMLElement>('.w-btn-icon');
    if (icon !== null) icon.innerHTML = bodyClassDisplayIcon(mode);
    button.element.title = description;
    button.element.setAttribute('aria-label', description);
  }
}
