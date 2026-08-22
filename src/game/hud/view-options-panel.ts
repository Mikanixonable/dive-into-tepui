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

// 天球グリッドの1行分。面/極/網/縮尺の4列のうち、月軌道・月赤道は縮尺しか持たないため
// 該当列は null(セル自体を空にする)。categoryKey が null の行(月軌道・月赤道)は面・極・網の
// ゲートを持たず、行見出し自身が縮尺トグルを兼ねる(celestial-grid.ts の GRID_CATEGORIES 参照)。
interface GridRow {
  readonly label: string;
  readonly categoryKey: keyof CelestialGridVisibility | null;
  readonly planeKey: keyof CelestialGridVisibility | null;
  readonly poleKey: keyof CelestialGridVisibility | null;
  readonly gridKey: keyof CelestialGridVisibility | null;
  readonly scaleKey: keyof CelestialGridVisibility;
}

const GRID_ROWS: readonly GridRow[] = [
  { label: '黄道', categoryKey: 'ecliptic', planeKey: 'eclipticPlane', poleKey: 'eclipticPole', gridKey: 'eclipticGrid', scaleKey: 'eclipticScaleGrid' },
  { label: '赤道', categoryKey: 'equator', planeKey: 'equatorPlane', poleKey: 'equatorPole', gridKey: 'equatorGrid', scaleKey: 'equatorScaleGrid' },
  { label: '月軌道', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'moonOrbitScaleGrid' },
  { label: '月赤道', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'moonEquatorScaleGrid' },
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
  { glyph: '十', label: '縮尺' },
];

// 列見出しの凡例を持たない、グループ間の細い区切り(節見出しの凡例はセクション先頭で1回だけ
// 出せば足りるため、天体/機体と設備のようなサブグループはラベルだけの区切りにする)。
function appendSectionDivider(parent: HTMLElement, title: string): void {
  const divider = document.createElement('div');
  divider.className = 'view-options-section-divider';
  divider.textContent = title;
  parent.appendChild(divider);
}

// トグルのグリフと意味をカラム見出しで常に並記し、色だけに識別を委ねない。extraClass は列数が
// 異なる見出し(天球の4列)を CSS 側で区別するためのモディファイア。
function appendSectionHeading(
  parent: HTMLElement,
  title: string,
  columns: readonly ViewOptionColumn[],
  extraClass?: string,
): void {
  const heading = document.createElement('div');
  heading.className = extraClass === undefined ? 'view-options-section-heading' : `view-options-section-heading ${extraClass}`;

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
    appendSectionHeading(body, '対象', OBJECT_COLUMNS);
    for (const group of rowGroups) {
      appendSectionDivider(body, group.title);
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

    // 天球(参照面:黄道・赤道・月軌道・月赤道、環境:星空)。天体クラスと同じ行の形
    // (見出し+トグル列)を流用し、面/極/網/縮尺を1つの表にまとめる。
    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const gridCategories: (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[] = [];
    appendSectionHeading(body, '天球', GRID_COLUMNS, 'view-options-heading-grid');
    for (const row of GRID_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row grid-class-row';
      const titleKey = row.categoryKey ?? row.scaleKey;
      const title = this.toggleButton(row.label, `${row.label}を表示`, titleKey, this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
      title.element.classList.add('body-class-title');
      rowEl.appendChild(title.element);
      if (row.categoryKey === null) gridButtons.push([titleKey, title]);
      else gridCategories.push([row.categoryKey, title, rowEl]);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);
      for (const [key, glyph, itemTitle] of [
        [row.planeKey, '⌒', `${row.label}面`],
        [row.poleKey, DIRECTION_GLYPH.axis, `${row.label}極`],
        [row.gridKey, '⊞', `${row.label}グリッド`],
        [row.scaleKey, '十', `${row.label}の縮尺グリッド`],
      ] as const) {
        if (key === null || (row.categoryKey === null && key === row.scaleKey)) {
          btnsEl.appendChild(document.createElement('span')).className = 'body-class-icon-btn-empty';
          continue;
        }
        const button = this.toggleButton(glyph, itemTitle, key, this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
        button.element.classList.add('body-class-icon-btn');
        btnsEl.appendChild(button.element);
        gridButtons.push([key, button]);
      }
      body.appendChild(rowEl);
    }
    this.gridButtons = gridButtons;
    this.gridCategoryButtons = gridCategories;

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
