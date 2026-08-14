// 表示パネル(マップモード左レール): 「マップに何を出すか」という1つの問いに答える —
// 天体クラス別のアイコン/ラベル/軌道線トグルと、天球グリッド(赤道・黄道)のトグルをまとめて持つ。
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../marker/marker-glyphs';
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  hudRail,
  type CollapseToggleLabels,
} from './hud-root';
import { Button } from './widgets';
import type { BodyClassToggles } from '../celestial/body-visibility';
import type { CelestialGridVisibility } from '../../render/celestial-grid';
import { loadPanelCollapsed, savePanelCollapsed } from './panel-shell';

// クラス別トグルの1行分。orbitKey が null のクラス(衛星・ラグランジュ点)は軌道線ボタンを持たない
// ——衛星の参照軌道線はフォーカス中の系かどうかで別途決まり、ラグランジュ点はそもそも軌道を持たない。
interface BodyClassRow {
  readonly label: string;
  readonly categoryKey: keyof BodyClassToggles;
  readonly iconKey: keyof BodyClassToggles;
  readonly labelKey: keyof BodyClassToggles;
  readonly orbitKey: keyof BodyClassToggles | null;
}

const BODY_CLASS_ROWS: readonly BodyClassRow[] = [
  { label: '惑星', categoryKey: 'planetVisible', iconKey: 'planetIcon', labelKey: 'planetLabel', orbitKey: 'planetOrbit' },
  { label: '衛星', categoryKey: 'satelliteVisible', iconKey: 'satelliteIcon', labelKey: 'satelliteLabel', orbitKey: 'satelliteOrbit' },
  { label: '準惑星', categoryKey: 'dwarfVisible', iconKey: 'dwarfIcon', labelKey: 'dwarfLabel', orbitKey: 'dwarfOrbit' },
  { label: '小天体', categoryKey: 'smallBodyVisible', iconKey: 'smallBodyIcon', labelKey: 'smallBodyLabel', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', categoryKey: 'lagrangeVisible', iconKey: 'lagrangeIcon', labelKey: 'lagrangeLabel', orbitKey: null },
];
// このパネル自身の折りたたみトグルの見た目。
const VIEW_OPTIONS_COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '太陽系を閉じる',
  collapsedTitle: '太陽系を開く',
};

const ENTITY_ROWS: readonly BodyClassRow[] = [
  { label: '自艦', categoryKey: 'playerVisible', iconKey: 'playerIcon', labelKey: 'playerLabel', orbitKey: 'playerOrbit' },
  { label: '敵', categoryKey: 'shipVisible', iconKey: 'shipIcon', labelKey: 'shipLabel', orbitKey: 'shipOrbit' },
  { label: '弾薬', categoryKey: 'ammoVisible', iconKey: 'ammoIcon', labelKey: 'ammoLabel', orbitKey: 'ammoOrbit' },
  { label: '基地', categoryKey: 'baseVisible', iconKey: 'baseIcon', labelKey: 'baseLabel', orbitKey: 'baseOrbit' },
];

// 天球グリッドのカテゴリー(黄道・赤道・月軌道)1行分。各カテゴリーは面・極・グリッドの3トグルを持つ。
interface GridToggleGroup {
  readonly categoryKey: keyof CelestialGridVisibility;
  readonly label: string;
  readonly items: readonly (readonly [keyof CelestialGridVisibility, string, string])[];
}

const GRID_TOGGLE_GROUPS: readonly GridToggleGroup[] = [
  {
    categoryKey: 'ecliptic', label: '黄道',
    items: [['eclipticPlane', '⌒', '黄道面'], ['eclipticPole', DIRECTION_GLYPH.axis, '黄道極'], ['eclipticGrid', '⊞', '黄道グリッド']],
  },
  {
    categoryKey: 'equator', label: '赤道',
    items: [['equatorPlane', '⌒', '赤道面'], ['equatorPole', DIRECTION_GLYPH.axis, '赤道極'], ['equatorGrid', '⊞', '赤道グリッド']],
  },
  {
    categoryKey: 'moonOrbit', label: '月軌道',
    items: [['moonOrbitPlane', '⌒', '月軌道面'], ['moonOrbitPole', DIRECTION_GLYPH.axis, '月軌道極'], ['moonOrbitGrid', '⊞', '月軌道グリッド']],
  },
];

interface ViewOptionColumn {
  readonly glyph: string;
  readonly label: string;
}

const OBJECT_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: ENTITY_GLYPH.body, label: '記号' },
  { glyph: 'Aa', label: '名前' },
  { glyph: '⌒', label: '軌道' },
];

const GRID_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: '⌒', label: '面' },
  { glyph: DIRECTION_GLYPH.axis, label: '極' },
  { glyph: '⊞', label: '網' },
];

// トグルのグリフと意味をカラム見出しで常に並記し、色だけに識別を委ねない。
function appendSectionHeading(
  parent: HTMLElement,
  title: string,
  columns: readonly ViewOptionColumn[],
): void {
  const heading = document.createElement('div');
  heading.className = 'view-options-section-heading';

  const label = document.createElement('span');
  label.className = 'view-options-section-title';
  label.textContent = title;
  heading.appendChild(label);

  const legend = document.createElement('span');
  legend.className = 'view-options-column-legend';
  for (const column of columns) {
    const item = document.createElement('span');
    item.className = 'view-options-column';
    item.textContent = `${column.glyph} ${column.label}`;
    legend.appendChild(item);
  }
  heading.appendChild(legend);
  parent.appendChild(heading);
}

export class ViewOptionsPanel {
  public onBodyClassToggle: ((key: keyof BodyClassToggles, on: boolean) => void) | null = null;
  public onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;

  private readonly bodyClassButtons: readonly (readonly [keyof BodyClassToggles, Button])[];
  private readonly bodyClassCategoryButtons: readonly (readonly [keyof BodyClassToggles, Button, HTMLElement, readonly Button[]])[];
  // 各トグルの現在値の鏡映し。正本は setBodyClassToggles/setGridVisibility が毎フレーム受け取る
  // 値側にあり、ここはクリック時に反転元として読むためだけに保つ。
  private readonly bodyClassCurrent = new Map<keyof BodyClassToggles, boolean>();

  private readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, Button])[];
  private readonly gridCategoryButtons: readonly (readonly [keyof CelestialGridVisibility, Button, HTMLElement, readonly Button[]])[];
  private readonly starsButton: Button;
  private readonly gridCurrent = new Map<keyof CelestialGridVisibility, boolean>();

  private readonly panel: HTMLElement;

  public constructor(root: HTMLElement) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-view-options';
    this.panel.className = 'panel hidden';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const titleRow = document.createElement('div');
    titleRow.className = 'view-options-title';
    const title = document.createElement('h3');
    title.textContent = '太陽系';
    titleRow.appendChild(title);
    this.panel.appendChild(titleRow);

    const body = document.createElement('div');
    body.className = 'view-options-body';
    this.panel.appendChild(body);
    body.classList.toggle('collapsed', loadPanelCollapsed('hud-view-options') ?? true);
    const collapseToggle = buildCollapseToggle(titleRow, 'hud-view-options-toggle', 'view-options-collapse', body, VIEW_OPTIONS_COLLAPSE_LABELS);
    collapseToggle.addEventListener('click', () => savePanelCollapsed('hud-view-options', body.classList.contains('collapsed')));

    // マップに出す天体のクラスごとに、アイコン(点)・ラベル(名前)・軌道線を個別に切り替える。
    // 恒星・惑星と、フォーカス中の系の親子は常に出るので、ここで足すのは「その外まで見たい」
    // という明示の意思表示にあたる。
    const bodyClassButtons: (readonly [keyof BodyClassToggles, Button])[] = [];
    const bodyClassCategories: (readonly [keyof BodyClassToggles, Button, HTMLElement, readonly Button[]])[] = [];
    const rowGroups: readonly { readonly title: string; readonly rows: readonly BodyClassRow[] }[] = [
      { title: '天体', rows: BODY_CLASS_ROWS },
      { title: '機体と設備', rows: ENTITY_ROWS },
    ];
    for (const group of rowGroups) {
      appendSectionHeading(body, group.title, OBJECT_COLUMNS);
      for (const row of group.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'body-class-row';
        const category = this.toggleButton(
          row.label,
          `${row.label}を表示`,
          row.categoryKey,
          this.bodyClassCurrent,
          (key, on) => this.onBodyClassToggle?.(key, on),
        );
        category.element.classList.add('body-class-title');
        rowEl.appendChild(category.element);

        const btnsEl = document.createElement('div');
        btnsEl.className = 'body-class-btns';
        rowEl.appendChild(btnsEl);
        const individualButtons: Button[] = [];

        const icon = this.toggleButton(
          ENTITY_GLYPH.body,
          'アイコン',
          row.iconKey,
          this.bodyClassCurrent,
          (key, on) => this.onBodyClassToggle?.(key, on),
        );
        icon.element.classList.add('body-class-icon-btn');
        individualButtons.push(icon);
        btnsEl.appendChild(icon.element);
        bodyClassButtons.push([row.iconKey, icon]);

        const label = this.toggleButton(
          'Aa',
          'ラベル',
          row.labelKey,
          this.bodyClassCurrent,
          (key, on) => this.onBodyClassToggle?.(key, on),
        );
        label.element.classList.add('body-class-icon-btn');
        individualButtons.push(label);
        btnsEl.appendChild(label.element);
        bodyClassButtons.push([row.labelKey, label]);

        if (row.orbitKey !== null) {
          const orbitKey = row.orbitKey;
          const orbit = this.toggleButton(
            '⌒',
            '軌道線',
            orbitKey,
            this.bodyClassCurrent,
            (key, on) => this.onBodyClassToggle?.(key, on),
          );
          orbit.element.classList.add('body-class-icon-btn');
          individualButtons.push(orbit);
          btnsEl.appendChild(orbit.element);
          bodyClassButtons.push([orbitKey, orbit]);
        }

        body.appendChild(rowEl);
        bodyClassCategories.push([row.categoryKey, category, rowEl, individualButtons]);
      }
    }
    this.bodyClassButtons = bodyClassButtons;
    this.bodyClassCategoryButtons = bodyClassCategories;

    // 天球グリッド(黄道・赤道・月軌道)。天体クラスと同じ行の形(見出し+アイコン列)を流用する。
    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const gridCategories: (readonly [keyof CelestialGridVisibility, Button, HTMLElement, readonly Button[]])[] = [];
    appendSectionHeading(body, '参照面', GRID_COLUMNS);
    for (const group of GRID_TOGGLE_GROUPS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row grid-class-row';
      const category = this.toggleButton(group.label, `${group.label}を表示`, group.categoryKey, this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
      category.element.classList.add('body-class-title');
      rowEl.appendChild(category.element);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);
      const individualButtons: Button[] = [];
      for (const [key, glyph, itemTitle] of group.items) {
        const button = this.toggleButton(glyph, itemTitle, key, this.gridCurrent, (k, on) => this.onGridToggle?.(k, on));
        button.element.classList.add('body-class-icon-btn');
        btnsEl.appendChild(button.element);
        gridButtons.push([key, button]);
        individualButtons.push(button);
      }
      body.appendChild(rowEl);
      gridCategories.push([group.categoryKey, category, rowEl, individualButtons]);
    }
    this.gridButtons = gridButtons;
    this.gridCategoryButtons = gridCategories;

    const environmentHeading = document.createElement('div');
    environmentHeading.className = 'view-options-section-heading';
    const environmentTitle = document.createElement('span');
    environmentTitle.className = 'view-options-section-title';
    environmentTitle.textContent = '環境';
    environmentHeading.appendChild(environmentTitle);
    body.appendChild(environmentHeading);
    const starsRow = document.createElement('div');
    starsRow.className = 'body-class-row grid-class-row';
    this.starsButton = this.toggleButton('星空', '星空を表示', 'stars', this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
    this.starsButton.element.classList.add('body-class-title');
    starsRow.appendChild(this.starsButton.element);
    body.appendChild(starsRow);

    hudRail(root, 'left').appendChild(this.panel);
  }

  // クリックのたびに点灯を反転する小型トグルボタンを組む。description はホバー説明とタッチ向け
  // aria-label の両方に使う。current は反転元として読む鏡映しで、呼び出し側の Map を直接更新する。
  private toggleButton<K extends string>(
    glyph: string, description: string, key: K, current: Map<K, boolean>, onToggle: (key: K, on: boolean) => void,
  ): Button {
    const btn = new Button(glyph, () => {
      const next = !(current.get(key) ?? false);
      current.set(key, next);
      btn.setOn(next);
      onToggle(key, next);
    });
    btn.element.title = description;
    btn.element.setAttribute('aria-label', description);
    return btn;
  }

  // パネルの表示/非表示を切り替える。
  public setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // クラス別トグルの表示状態を現在値へ合わせる。
  public setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [key, btn] of this.bodyClassButtons) {
      const on = toggles[key];
      this.bodyClassCurrent.set(key, on);
      btn.setOn(on);
    }
    for (const [key, category, row, buttons] of this.bodyClassCategoryButtons) {
      const enabled = Boolean(toggles[key]);
      this.bodyClassCurrent.set(key, enabled);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
      for (const btn of buttons) btn.setEnabled(enabled);
    }
  }

  // 天球グリッドのトグル表示状態を現在値へ合わせる。
  public setGridVisibility(visibility: CelestialGridVisibility): void {
    this.gridCurrent.set('stars', visibility.stars);
    this.starsButton.setOn(visibility.stars);
    for (const [key, btn] of this.gridButtons) {
      const on = visibility[key];
      this.gridCurrent.set(key, on);
      btn.setOn(on);
    }
    for (const [key, category, row, buttons] of this.gridCategoryButtons) {
      const enabled = Boolean(visibility[key]);
      this.gridCurrent.set(key, enabled);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
      for (const btn of buttons) btn.setEnabled(enabled);
    }
  }
}
