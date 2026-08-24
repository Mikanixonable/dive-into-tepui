// 表示パネル(マップモード左レール): 「マップに何を出すか」という1つの問いに答える —
// 対象はラベル+軌道/ラベル/非表示を1ボタンで循環し、天球グリッド(赤道・黄道)のトグルも持つ。
import { DIRECTION_GLYPH } from '../../marker/marker-glyphs';
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  hudRail,
  type CollapseToggleLabels,
} from '../hud-root';
import { Button, syncCollapseToggle } from '../widgets';
import {
  bodyClassDisplayMode,
  nextBodyClassDisplayMode,
  type BodyClassDisplayMode,
  type BodyClassToggles,
} from '../../celestial/body-visibility';
import type { CelestialGridVisibility } from '../../../render/celestial-grid';
import { loadPanelCollapsed, onPanelCollapsedViewChange, savePanelCollapsed } from '../panel-shell';

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
  { label: 'RCS燃料', categoryKey: 'fuelVisible', nameKey: 'fuelName', orbitKey: 'fuelOrbit' },
  { label: '基地', categoryKey: 'baseVisible', nameKey: 'baseName', orbitKey: 'baseOrbit' },
];

// 対象クラスの表示状態を文字ではなく、ラベル・軌道・非表示を連想できる SVG で示す。
// Button の共通アイコン枠へ入れるため、ここは信頼できる固定マークアップだけを返す。
const BODY_CLASS_DISPLAY_ICONS: Readonly<Record<BodyClassDisplayMode, string>> = {
  hidden: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M5.1 5.1C3.4 6.5 2.4 8.4 2 12c.7 3.1 2.7 5.4 5.2 6.8"/><path d="M9.7 19.2c.7.2 1.5.3 2.3.3 5.4 0 9.2-4.4 10-7.5-.3-1.3-1-2.6-2.2-3.8"/></svg>',
  label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10.5L20 12l-5.5 7H4z"/><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>',
  orbit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-28 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(28 12 12)"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
};

function bodyClassDisplayIcon(mode: BodyClassDisplayMode): string {
  return BODY_CLASS_DISPLAY_ICONS[mode];
}

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
  { label: '月軌道面', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'moonOrbitScaleGrid' },
  { label: '月赤道面', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'moonEquatorScaleGrid' },
  { label: '静止軌道', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'geostationaryOrbit' },
  { label: 'ハロー軌道', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'haloOrbits' },
];

const HALO_PANEL_TOGGLE_GLYPH = '⚙';

interface ViewOptionColumn {
  readonly glyph: string;
  readonly label: string;
}

const GRID_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: '⌒', label: '面' },
  { glyph: DIRECTION_GLYPH.axis, label: '極' },
  { glyph: '⊞', label: '網' },
  { glyph: '十', label: '面' },
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

  if (columns.length > 0) {
    const legend = document.createElement('span');
    legend.className = 'view-options-column-legend';
    for (const column of columns) {
      const item = document.createElement('span');
      item.className = 'view-options-column';
      item.textContent = `${column.glyph} ${column.label}`;
      legend.appendChild(item);
    }
    heading.appendChild(legend);
  }
  parent.appendChild(heading);
}

export class ViewOptionsPanel {
  public onBodyClassModeChange: ((key: keyof BodyClassToggles, mode: BodyClassDisplayMode) => void) | null = null;
  public onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;
  public onHaloPanelToggle: (() => void) | null = null;

  // haloOrbits 行の縮尺列に置く、ハロー軌道パネルの開閉ボタン。
  private haloPanelToggleButton!: Button;

  private readonly bodyClassModeButtons: readonly (readonly [BodyClassRow, Button, HTMLElement])[];
  // 各ボタンの現在状態の鏡映し。正本は setBodyClassToggles が受け取る boolean 組にあり、
  // ここはクリック時に次の3状態を決めるためだけに保つ。
  private readonly bodyClassModes = new Map<keyof BodyClassToggles, BodyClassDisplayMode>();

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

    // マップに出す対象クラスごとに、ラベル+軌道 / ラベル / 非表示を1ボタンで循環する。
    // 恒星・惑星と、フォーカス中の系の親子は常に出るので、ここで足すのは「その外まで見たい」
    // という明示の意思表示にあたる。
    const bodyClassModeButtons: (readonly [BodyClassRow, Button, HTMLElement])[] = [];
    const rowGroups: readonly { readonly title: string; readonly rows: readonly BodyClassRow[] }[] = [
      { title: '天体', rows: BODY_CLASS_ROWS },
      { title: '機体と設備', rows: ENTITY_ROWS },
    ];
    appendSectionHeading(body, '対象', [], 'view-options-heading-target');
    for (const group of rowGroups) {
      appendSectionDivider(body, group.title);
      const groupEl = document.createElement('div');
      groupEl.className = 'target-class-group';
      for (const row of group.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'body-class-row target-class-row';
        const modeButton = new Button(row.label, () => {
          const current = this.bodyClassModes.get(row.categoryKey) ?? 'hidden';
          const next = nextBodyClassDisplayMode(current, row.orbitKey !== null);
          this.bodyClassModes.set(row.categoryKey, next);
          this.setBodyClassModeButton(modeButton, row.label, next, row.orbitKey !== null);
          this.onBodyClassModeChange?.(row.categoryKey, next);
        }, bodyClassDisplayIcon('hidden'));
        modeButton.element.classList.add('body-class-title', 'body-class-mode-button');
        rowEl.appendChild(modeButton.element);
        groupEl.appendChild(rowEl);
        bodyClassModeButtons.push([row, modeButton, rowEl]);
      }
      body.appendChild(groupEl);
    }
    this.bodyClassModeButtons = bodyClassModeButtons;

    // 天球(参照面:黄道・赤道・月軌道・月赤道、環境:星空)。天体クラスと同じ行の形
    // (見出し+トグル列)を流用し、面/極/網/縮尺を1つの表にまとめる。
    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const gridCategories: (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[] = [];
    appendSectionHeading(body, 'ガイド', GRID_COLUMNS, 'view-options-heading-grid');
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
        if (key === row.scaleKey && row.scaleKey === 'haloOrbits') {
          this.haloPanelToggleButton = new Button(HALO_PANEL_TOGGLE_GLYPH, () => this.onHaloPanelToggle?.());
          this.haloPanelToggleButton.element.classList.add('body-class-icon-btn');
          this.haloPanelToggleButton.element.title = 'ハロー軌道パネルを開閉';
          this.haloPanelToggleButton.element.setAttribute('aria-label', 'ハロー軌道パネルを開閉');
          btnsEl.appendChild(this.haloPanelToggleButton.element);
          continue;
        }
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

  private setBodyClassModeButton(
    button: Button, label: string, mode: BodyClassDisplayMode, hasOrbit: boolean,
  ): void {
    const modeLabel = mode === 'orbit' ? 'ラベル＋軌道' : mode === 'label' ? 'ラベル' : '非表示';
    const next = nextBodyClassDisplayMode(mode, hasOrbit);
    const nextLabel = next === 'orbit' ? 'ラベル＋軌道' : next === 'label' ? 'ラベル' : '非表示';
    const description = `${label}: ${modeLabel}。クリックで${nextLabel}`;
    button.setOn(mode !== 'hidden');
    button.element.dataset.displayMode = mode;
    const icon = button.element.querySelector<HTMLElement>('.w-btn-icon');
    if (icon !== null) icon.innerHTML = bodyClassDisplayIcon(mode);
    button.element.title = description;
    button.element.setAttribute('aria-label', description);
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

  // ハロー軌道パネルの開閉ボタンの点灯状態を外部から与える。
  public setHaloPanelOpen(open: boolean): void {
    this.haloPanelToggleButton.setOn(open);
  }

  // パネルを取り除き、折りたたみ状態変化の購読を解く。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.panel.remove();
  }

  // クラス別の表示状態を現在値へ合わせる。
  public setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [config, button, row] of this.bodyClassModeButtons) {
      const mode = bodyClassDisplayMode(toggles, config.categoryKey);
      this.bodyClassModes.set(config.categoryKey, mode);
      this.setBodyClassModeButton(button, config.label, mode, config.orbitKey !== null);
      row.classList.toggle('category-off', mode === 'hidden');
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
