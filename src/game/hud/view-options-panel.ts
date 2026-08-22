// 表示パネル(マップモード左レール): 「マップに何を出すか」という1つの問いに答える —
// 天体クラス別のラベル/軌道線トグルと、天球グリッド(赤道・黄道)のトグルをまとめて持つ。
import { DIRECTION_GLYPH } from '../marker/marker-glyphs';
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  hudRail,
  type CollapseToggleLabels,
} from './hud-root';
import { Button, syncCollapseToggle } from './widgets';
import type { BodyClassToggles } from '../celestial/body-visibility';
import type { CelestialGridVisibility } from '../../render/celestial-grid';
import { loadPanelCollapsed, onPanelCollapsedViewChange, savePanelCollapsed } from './panel-shell';

// クラス別トグルの1行分。orbitKey が null のクラス(衛星・ラグランジュ点)は軌道線ボタンを持たない
// ——衛星の参照軌道線はフォーカス中の系かどうかで別途決まり、ラグランジュ点はそもそも軌道を持たない。
interface BodyClassRow {
  readonly label: string;
  readonly categoryKey: keyof BodyClassToggles;
  readonly nameKey: keyof BodyClassToggles;
  readonly orbitKey: keyof BodyClassToggles | null;
}

const BODY_CLASS_ROWS: readonly BodyClassRow[] = [
  { label: '惑星', categoryKey: 'planetVisible', nameKey: 'planetName', orbitKey: 'planetOrbit' },
  { label: '衛星', categoryKey: 'satelliteVisible', nameKey: 'satelliteName', orbitKey: 'satelliteOrbit' },
  { label: '準惑星', categoryKey: 'dwarfVisible', nameKey: 'dwarfName', orbitKey: 'dwarfOrbit' },
  { label: '小天体', categoryKey: 'smallBodyVisible', nameKey: 'smallBodyName', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', categoryKey: 'lagrangeVisible', nameKey: 'lagrangeName', orbitKey: null },
];
// このパネル自身の折りたたみトグルの見た目。
const VIEW_OPTIONS_COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '表示を閉じる',
  collapsedTitle: '表示を開く',
};

const ENTITY_ROWS: readonly BodyClassRow[] = [
  { label: '自艦', categoryKey: 'playerVisible', nameKey: 'playerName', orbitKey: 'playerOrbit' },
  { label: '敵', categoryKey: 'shipVisible', nameKey: 'shipName', orbitKey: 'shipOrbit' },
  { label: '弾薬', categoryKey: 'ammoVisible', nameKey: 'ammoName', orbitKey: 'ammoOrbit' },
  { label: '基地', categoryKey: 'baseVisible', nameKey: 'baseName', orbitKey: 'baseOrbit' },
];

// 天球グリッドのカテゴリー(黄道・赤道)1行分。各カテゴリーは面・極・グリッドの3トグルを持つ。
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
];

const SPATIAL_GRID_ROWS: readonly (readonly [keyof CelestialGridVisibility, string, string])[] = [
  ['eclipticScaleGrid', '黄道面', '黄道面の縮尺グリッド'],
  ['equatorScaleGrid', '赤道面', '赤道面の縮尺グリッド'],
  ['moonOrbitScaleGrid', '月軌道面', '月軌道面の縮尺グリッド'],
  ['moonEquatorScaleGrid', '月赤道面', '月赤道面の縮尺グリッド'],
];

interface ViewOptionColumn {
  readonly glyph: string;
  readonly label: string;
}

const OBJECT_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: 'Aa', label: 'ラベル' },
  { glyph: '⌒', label: '軌道' },
];

const GRID_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: '⌒', label: '面' },
  { glyph: DIRECTION_GLYPH.axis, label: '極' },
  { glyph: '⊞', label: '網' },
];

const SPATIAL_GRID_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: '十', label: '縮尺' },
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
  private readonly bodyClassCategoryButtons: readonly (readonly [keyof BodyClassToggles, Button, HTMLElement])[];
  // 各トグルの現在値の鏡映し。正本は setBodyClassToggles/setGridVisibility が状態変化のたびに
  // 受け取る値側にあり、ここはクリック時に反転元として読むためだけに保つ。
  private readonly bodyClassCurrent = new Map<keyof BodyClassToggles, boolean>();

  private readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, Button])[];
  private readonly gridCategoryButtons: readonly (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[];
  private readonly starsButton: Button;
  private readonly gridCurrent = new Map<keyof CelestialGridVisibility, boolean>();

  private readonly panel: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  public constructor(root: HTMLElement) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-view-options';
    this.panel.className = 'panel hidden';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const titleRow = document.createElement('div');
    titleRow.className = 'view-options-title';
    const title = document.createElement('h3');
    title.textContent = '表示';
    titleRow.appendChild(title);
    this.panel.appendChild(titleRow);

    const body = document.createElement('div');
    body.className = 'view-options-body';
    this.panel.appendChild(body);
    const collapseToggle = buildCollapseToggle(titleRow, 'hud-view-options-toggle', 'view-options-collapse', body, VIEW_OPTIONS_COLLAPSE_LABELS);
    const applyCollapsedState = (): void => {
      const collapsed = loadPanelCollapsed('hud-view-options') ?? true;
      body.classList.toggle('collapsed', collapsed);
      syncCollapseToggle(collapseToggle, body, VIEW_OPTIONS_COLLAPSE_LABELS);
    };
    applyCollapsedState();
    this.unsubscribeCollapsedView = onPanelCollapsedViewChange(applyCollapsedState);
    collapseToggle.addEventListener('click', () => savePanelCollapsed('hud-view-options', body.classList.contains('collapsed')));

    // マップに出す天体のクラスごとに、ラベル(位置の点+名前)・軌道線を切り替える。
    // 恒星・惑星と、フォーカス中の系の親子は常に出るので、ここで足すのは「その外まで見たい」
    // という明示の意思表示にあたる。
    const bodyClassButtons: (readonly [keyof BodyClassToggles, Button])[] = [];
    const bodyClassCategories: (readonly [keyof BodyClassToggles, Button, HTMLElement])[] = [];
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

        const name = this.toggleButton(
          'Aa',
          'ラベル',
          row.nameKey,
          this.bodyClassCurrent,
          (key, on) => this.onBodyClassToggle?.(key, on),
        );
        name.element.classList.add('body-class-icon-btn');
        btnsEl.appendChild(name.element);
        bodyClassButtons.push([row.nameKey, name]);

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
          btnsEl.appendChild(orbit.element);
          bodyClassButtons.push([orbitKey, orbit]);
        }

        body.appendChild(rowEl);
        bodyClassCategories.push([row.categoryKey, category, rowEl]);
      }
    }
    this.bodyClassButtons = bodyClassButtons;
    this.bodyClassCategoryButtons = bodyClassCategories;

    // 天球(参照面:黄道・赤道、環境:星空)。天体クラスと同じ行の形(見出し+トグル列)を流用する。
    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const gridCategories: (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[] = [];
    appendSectionHeading(body, '天球', GRID_COLUMNS);
    for (const group of GRID_TOGGLE_GROUPS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row grid-class-row';
      const category = this.toggleButton(group.label, `${group.label}を表示`, group.categoryKey, this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
      category.element.classList.add('body-class-title');
      rowEl.appendChild(category.element);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);
      for (const [key, glyph, itemTitle] of group.items) {
        const button = this.toggleButton(glyph, itemTitle, key, this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
        button.element.classList.add('body-class-icon-btn');
        btnsEl.appendChild(button.element);
        gridButtons.push([key, button]);
      }
      body.appendChild(rowEl);
      gridCategories.push([group.categoryKey, category, rowEl]);
    }
    this.gridButtons = gridButtons;
    this.gridCategoryButtons = gridCategories;

    const starsRow = document.createElement('div');
    starsRow.className = 'body-class-row grid-class-row';
    this.starsButton = this.toggleButton('星空', '星空を表示', 'stars', this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
    this.starsButton.element.classList.add('body-class-title');
    starsRow.appendChild(this.starsButton.element);
    body.appendChild(starsRow);

    appendSectionHeading(body, '軌道面グリッド', SPATIAL_GRID_COLUMNS);
    for (const [key, label, description] of SPATIAL_GRID_ROWS) {
      const row = document.createElement('div');
      row.className = 'body-class-row grid-class-row';
      const titleButton = this.toggleButton(label, description, key, this.gridCurrent, (k, on) => this.onGridToggle?.(k, on));
      titleButton.element.classList.add('body-class-title');
      row.appendChild(titleButton.element);
      const buttons = document.createElement('div');
      buttons.className = 'body-class-btns';
      const gridButton = this.toggleButton('⊞', description, key, this.gridCurrent, (k, on) => this.onGridToggle?.(k, on));
      gridButton.element.classList.add('body-class-icon-btn');
      buttons.appendChild(gridButton.element);
      row.appendChild(buttons);
      body.appendChild(row);
      gridButtons.push([key, titleButton], [key, gridButton]);
    }

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

  // パネルを取り除き、折りたたみ状態変化の購読を解く。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.panel.remove();
  }

  // クラス別トグルの表示状態を現在値へ合わせる。
  public setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [key, btn] of this.bodyClassButtons) {
      const on = toggles[key];
      this.bodyClassCurrent.set(key, on);
      btn.setOn(on);
    }
    for (const [key, category, row] of this.bodyClassCategoryButtons) {
      const enabled = Boolean(toggles[key]);
      this.bodyClassCurrent.set(key, enabled);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
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
    for (const [key, category, row] of this.gridCategoryButtons) {
      const enabled = Boolean(visibility[key]);
      this.gridCurrent.set(key, enabled);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
    }
  }
}
