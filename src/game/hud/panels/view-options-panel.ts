// 表示パネル(マップモード左レール): マップの表示項目設定を担当する —
// 対象・ガイド・軌道ガイドの3タブに分かれ、対象はラベル+軌道/ラベル/非表示を1ボタンで循環、
// ガイドは天球グリッド(赤道・黄道・月軌道面・月赤道面)・星空のトグルとゼロ速度曲線節を持つ。
import { DIRECTION_GLYPH } from '../../marker/marker-identity';
import { hudRail } from '../hud-root';
import {
  Button,
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  TabBar,
  type CollapseToggleLabels,
} from '../../../hud/widgets';
import {
  mapDisplayModeOf,
  nextMapDisplayMode,
  type MapDisplayCategory,
  type MapDisplayMode,
  type MapDisplayToggles,
} from '../../map/display-toggles';
import type { CelestialGridVisibility } from '../../../render/celestial-grid';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import type { OrbitGuideSettings, ZeroVelocitySettings } from '../../viewer/orbit-guide-settings';
import { DEFAULT_ORBIT_GUIDE_SETTINGS } from '../../viewer/orbit-guide-settings';
import { OrbitGuideTab } from './orbit-guide-tab';
import { ZeroVelocitySection, zeroVelocityJacobiAt } from './zero-velocity-section';
import type { PanelCollapse } from '../panel-shell';
import type { OrbitGuideGroupTab, ViewOptionsTab } from '../hud-selection';

const TAB_ITEMS: readonly (readonly [ViewOptionsTab, string])[] = [
  ['target', '対象'],
  ['guide', 'ガイド'],
  ['orbit', '軌道ガイド'],
];

// タブ1枚ぶんの本体。選択中のタブ本体だけが表示され、対応するタブボタンから aria-controls で指される。
function buildTabBody(tab: ViewOptionsTab): HTMLElement {
  const el = document.createElement('div');
  el.className = 'view-options-tab-body';
  el.id = `hud-view-options-${tab}`;
  el.setAttribute('role', 'tabpanel');
  el.tabIndex = 0;
  return el;
}

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
// このパネル自身の折りたたみトグルの見た目。
const VIEW_OPTIONS_COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '表示を閉じる',
  collapsedTitle: '表示を開く',
};

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

// 天球グリッドの1行分。面/極/網/縮尺の4列のうち、月軌道・月赤道は縮尺しか持たないため
// 該当列は null(セル自体を空にする)。categoryKey が null の行(月軌道・月赤道)は面・極・網の
// ゲートを持たず、行見出し自身が縮尺トグルを兼ねる。
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
];

interface ViewOptionColumn {
  readonly glyph: string;
  readonly label: string;
}

const GRID_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: '⌒', label: '面' },
  { glyph: DIRECTION_GLYPH.axis, label: '極' },
  { glyph: '⊞', label: '網' },
  { glyph: '十', label: '縮尺' },
];

// 列見出しの凡例を持たない、グループ間の細い区切り(天体/機体と設備のようなサブグループを
// ラベルだけで区切る)。
function appendSectionDivider(parent: HTMLElement, title: string): void {
  const divider = document.createElement('div');
  divider.className = 'view-options-section-divider editorial-divider';
  divider.textContent = title;
  parent.appendChild(divider);
}

// トグルのグリフと意味を並記する列見出し(天球グリッドの面/極/網/縮尺の凡例)。
function appendColumnLegend(parent: HTMLElement, columns: readonly ViewOptionColumn[]): void {
  const heading = document.createElement('div');
  heading.className = 'view-options-section-heading';
  const legend = document.createElement('span');
  legend.className = 'view-options-column-legend';
  // 各列のグリフとラベルを並べる。
  for (const column of columns) {
    const item = document.createElement('span');
    item.className = 'view-options-column';
    item.textContent = `${column.glyph} ${column.label}`;
    legend.appendChild(item);
  }
  // 見出し行を親へ組み込む。
  heading.appendChild(legend);
  parent.appendChild(heading);
}

export class ViewOptionsPanel {
  public onBodyClassModeChange: ((key: MapDisplayCategory, mode: MapDisplayMode) => void) | null = null;
  public onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;
  // 軌道ガイドタブかゼロ速度曲線節を編集するたびに、編集後の軌道ガイド設定全体で呼ばれる。
  public onOrbitGuideChange: ((settings: OrbitGuideSettings) => void) | null = null;
  // タブが選ばれたときに、選ばれたタブで呼ばれる。
  public onTabChange: ((tab: ViewOptionsTab) => void) | null = null;
  // 軌道ガイドタブの群タブが選ばれたときに、選ばれたタブで呼ばれる。
  public onOrbitGuideGroupTabChange: ((tab: OrbitGuideGroupTab) => void) | null = null;

  private readonly tabBar: TabBar<ViewOptionsTab>;
  private readonly tabBodies: ReadonlyMap<ViewOptionsTab, HTMLElement>;
  // 軌道ガイド設定の鏡映し。軌道ガイドタブとゼロ速度曲線節はどちらも setOrbitGuideSettings で
  // これと揃え、ゼロ速度曲線節の編集はこれへ重ねて設定全体に組み戻す。
  private orbitGuideSettings: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;
  private readonly orbitGuideTab: OrbitGuideTab;
  private readonly zeroVelocitySection: ZeroVelocitySection;

  private readonly bodyClassModeButtons: readonly (readonly [BodyClassRow, Button, HTMLElement])[];
  // 各ボタンの現在の表示モードの鏡映し。クリック時に次の状態を決めるのに使う。
  private readonly bodyClassModes = new Map<MapDisplayCategory, MapDisplayMode>();

  private readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, Button])[];
  private readonly gridCategoryButtons: readonly (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[];
  private readonly starsButton: Button;
  private readonly gridCurrent = new Map<keyof CelestialGridVisibility, boolean>();

  private readonly panel: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  // availableFamilies は軌道ガイドタブへ渡し、焼き込みカタログに実在する族だけを選ばせる。
  // collapse は折りたたみトグルの配線役。
  public constructor(
    root: HTMLElement,
    collapse: PanelCollapse,
    availableFamilies: ReadonlyMap<CatalogSystemId, readonly string[]> = new Map(),
  ) {
    // パネル本体とタイトル。
    this.panel = document.createElement('div');
    this.panel.id = 'hud-view-options';
    this.panel.className = 'panel hidden editorial-control-sheet editorial-index';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const titleRow = document.createElement('div');
    titleRow.className = 'view-options-title';
    const code = document.createElement('span');
    code.className = 'ui-section-code';
    code.setAttribute('aria-hidden', 'true');
    code.textContent = 'DSP';
    const title = document.createElement('h3');
    title.className = 'editorial-panel-title';
    title.textContent = 'DISPLAY';
    const context = document.createElement('span');
    context.className = 'ui-data-context view-options-context';
    context.textContent = 'VISIBILITY / GUIDES / ORBITS';
    titleRow.append(code, title, context);
    this.panel.appendChild(titleRow);

    const body = document.createElement('div');
    body.className = 'view-options-body';
    this.panel.appendChild(body);
    this.unsubscribeCollapsedView = collapse.wire({
      toggleRoot: titleRow,
      toggleId: 'hud-view-options-toggle',
      toggleClassName: 'view-options-collapse',
      target: body,
      labels: VIEW_OPTIONS_COLLAPSE_LABELS,
      storageId: 'hud-view-options',
      defaultCollapsed: true,
      extraHitEls: [title],
    });

    this.tabBar = new TabBar<ViewOptionsTab>(TAB_ITEMS, (tab) => this.onTabChange?.(tab));
    this.tabBar.element.setAttribute('aria-label', '表示するものの種類');
    body.appendChild(this.tabBar.element);

    const target = this.buildTargetTab(body);
    this.bodyClassModeButtons = target.buttons;
    const guide = this.buildGuideTab(body);
    this.gridButtons = guide.gridButtons;
    this.gridCategoryButtons = guide.gridCategoryButtons;
    this.starsButton = guide.starsButton;
    this.zeroVelocitySection = guide.zeroVelocitySection;
    const orbit = this.buildOrbitTab(body, availableFamilies);
    this.orbitGuideTab = orbit.tab;

    this.tabBodies = new Map([['target', target.element], ['guide', guide.element], ['orbit', orbit.element]]);
    for (const [tab] of TAB_ITEMS) this.tabBar.buttonFor(tab)?.setAttribute('aria-controls', `hud-view-options-${tab}`);

    hudRail(root, 'left').appendChild(this.panel);
  }

  // 対象タブ: マップに出す対象クラスごとに、ラベル+軌道 / ラベル / 非表示を1ボタンで循環する。
  private buildTargetTab(
    body: HTMLElement,
  ): { readonly element: HTMLElement; readonly buttons: readonly (readonly [BodyClassRow, Button, HTMLElement])[] } {
    const targetBody = buildTabBody('target');
    body.appendChild(targetBody);
    const bodyClassModeButtons: (readonly [BodyClassRow, Button, HTMLElement])[] = [];
    let itemIndex = 1;

    // 天体/機体と設備の2群を見出しで区切り、各行に循環ボタンを1つ置く。
    const rowGroups: readonly { readonly title: string; readonly rows: readonly BodyClassRow[] }[] = [
      { title: '天体', rows: BODY_CLASS_ROWS },
      { title: '機体と設備', rows: ENTITY_ROWS },
    ];
    for (const group of rowGroups) {
      appendSectionDivider(targetBody, group.title);
      const groupEl = document.createElement('div');
      groupEl.className = 'target-class-group';
      for (const row of group.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'body-class-row target-class-row editorial-index-row';
        rowEl.dataset['index'] = String(itemIndex++).padStart(2, '0');
        const modeButton = new Button(row.label, () => {
          const current = this.bodyClassModes.get(row.categoryKey) ?? 'hidden';
          const next = nextMapDisplayMode(current, row.orbitKey !== null);
          this.bodyClassModes.set(row.categoryKey, next);
          this.setBodyClassModeButton(modeButton, row.label, next, row.orbitKey !== null);
          this.onBodyClassModeChange?.(row.categoryKey, next);
        }, bodyClassDisplayIcon('hidden'));
        modeButton.element.classList.add('body-class-title', 'body-class-mode-button');
        rowEl.appendChild(modeButton.element);
        groupEl.appendChild(rowEl);
        bodyClassModeButtons.push([row, modeButton, rowEl]);
      }
      targetBody.appendChild(groupEl);
    }
    return { element: targetBody, buttons: bodyClassModeButtons };
  }

  // ガイドタブ: 天球(参照面:黄道・赤道・月軌道・月赤道、環境:星空)とゼロ速度曲線節。天体クラスと
  // 同じ行の形(見出し+トグル列)を流用し、面/極/網/縮尺を1つの表にまとめる。
  private buildGuideTab(body: HTMLElement): {
    readonly element: HTMLElement;
    readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, Button])[];
    readonly gridCategoryButtons: readonly (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[];
    readonly starsButton: Button;
    readonly zeroVelocitySection: ZeroVelocitySection;
  } {
    const guideBody = buildTabBody('guide');
    body.appendChild(guideBody);
    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const gridCategories: (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[] = [];

    // 天球グリッド各行: 見出し(面カテゴリまたは縮尺)+ 面/極/網/縮尺のアイコンボタン列。
    appendColumnLegend(guideBody, GRID_COLUMNS);
    for (const row of GRID_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row grid-class-row';
      const titleKey = row.categoryKey ?? row.scaleKey;
      const title = this.toggleButton(row.label, `${row.label}を表示`, titleKey, this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
      title.element.classList.add('body-class-title');
      rowEl.appendChild(title.element);
      if (row.categoryKey === null) gridButtons.push([row.scaleKey, title]);
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
      guideBody.appendChild(rowEl);
    }

    // 星空トグルと、ゼロ速度曲線節(独立部品として埋め込む)。
    const starsRow = document.createElement('div');
    starsRow.className = 'body-class-row grid-class-row';
    const starsTitle = document.createElement('span');
    starsTitle.className = 'body-class-title';
    starsTitle.textContent = '星空';
    starsRow.appendChild(starsTitle);
    const starsButton = this.toggleButton('✦', '星空を表示', 'stars', this.gridCurrent, (key, on) => this.onGridToggle?.(key, on));
    starsButton.element.classList.add('body-class-icon-btn');
    const starsControls = document.createElement('div');
    starsControls.className = 'body-class-btns';
    starsControls.appendChild(starsButton.element);
    starsRow.appendChild(starsControls);
    guideBody.appendChild(starsRow);

    const zeroVelocitySection = new ZeroVelocitySection(DEFAULT_ORBIT_GUIDE_SETTINGS.zeroVelocity);
    zeroVelocitySection.onChange = (change) => this.commitZeroVelocity(change);
    zeroVelocitySection.onSnapToLagrange = (point) => this.commitZeroVelocity({
      jacobi: zeroVelocityJacobiAt(this.orbitGuideSettings.zeroVelocity, point),
    });
    guideBody.appendChild(zeroVelocitySection.element);

    return { element: guideBody, gridButtons, gridCategoryButtons: gridCategories, starsButton, zeroVelocitySection };
  }

  // 軌道ガイドタブ: CR3BP の周期軌道族(約37種)を群ごとに折りたたんで選ぶ。
  private buildOrbitTab(
    body: HTMLElement, availableFamilies: ReadonlyMap<CatalogSystemId, readonly string[]>,
  ): { readonly element: HTMLElement; readonly tab: OrbitGuideTab } {
    const orbitBody = buildTabBody('orbit');
    body.appendChild(orbitBody);
    const orbitGuideTab = new OrbitGuideTab(availableFamilies);
    orbitGuideTab.onSettingsChange = (settings) => this.commitOrbitGuide(settings);
    orbitGuideTab.onGroupTabChange = (tab) => this.onOrbitGuideGroupTabChange?.(tab);
    orbitBody.appendChild(orbitGuideTab.element);
    return { element: orbitBody, tab: orbitGuideTab };
  }

  // 編集後の軌道ガイド設定を、軌道ガイドタブとゼロ速度曲線節の両方へ揃えてから通知する。
  private commitOrbitGuide(next: OrbitGuideSettings): void {
    this.setOrbitGuideSettings(next);
    this.onOrbitGuideChange?.(next);
  }

  // ゼロ速度曲線の設定を change の項目だけ書き換え、軌道ガイド設定全体として通知する。
  private commitZeroVelocity(change: Partial<ZeroVelocitySettings>): void {
    const zeroVelocity = { ...this.orbitGuideSettings.zeroVelocity, ...change };
    this.commitOrbitGuide({ ...this.orbitGuideSettings, zeroVelocity });
  }

  // タブの選択表示を tab へ合わせ、そのタブの本体だけを見せる。
  public setSelectedTab(tab: ViewOptionsTab): void {
    this.tabBar.setSelected(tab);
    for (const [candidate, el] of this.tabBodies) el.classList.toggle('hidden', candidate !== tab);
  }

  // 軌道ガイドタブの群タブの選択表示を tab へ合わせる。
  public setOrbitGuideGroupTab(tab: OrbitGuideGroupTab): void {
    this.orbitGuideTab.setGroupTab(tab);
  }

  // ボタンの点灯・アイコン・説明文を、現在のモードへ合わせる。説明文には次にクリックしたときの
  // 遷移先も含める。
  private setBodyClassModeButton(
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

  // パネルを取り除き、折りたたみ状態変化の購読を解除する。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.panel.remove();
  }

  // クラス別の表示状態を現在値へ合わせる。
  public setBodyClassToggles(toggles: MapDisplayToggles): void {
    for (const [config, button, row] of this.bodyClassModeButtons) {
      const mode = mapDisplayModeOf(toggles, config.categoryKey);
      this.bodyClassModes.set(config.categoryKey, mode);
      this.setBodyClassModeButton(button, config.label, mode, config.orbitKey !== null);
      row.classList.toggle('category-off', mode === 'hidden');
    }
  }

  // 天球グリッドのトグル表示状態を現在値へ合わせる。
  public setGridVisibility(visibility: CelestialGridVisibility): void {
    // 星空トグル。
    this.gridCurrent.set('stars', visibility.stars);
    this.starsButton.setOn(visibility.stars);
    // 面/極/網/縮尺の個別トグル。
    for (const [key, btn] of this.gridButtons) {
      const on = visibility[key];
      this.gridCurrent.set(key, on);
      btn.setOn(on);
    }
    // 行見出しの点灯と、ゲートを閉じた行のグレーアウト。
    for (const [key, category, row] of this.gridCategoryButtons) {
      const on = visibility[key];
      this.gridCurrent.set(key, on);
      category.setOn(on);
      row.classList.toggle('category-off', !on);
    }
  }

  // 軌道ガイドタブとゼロ速度曲線節(ガイドタブ)の表示状態を、軌道ガイド設定の現在値へ合わせる。
  public setOrbitGuideSettings(settings: OrbitGuideSettings): void {
    this.orbitGuideSettings = settings;
    this.orbitGuideTab.setSettings(settings);
    this.zeroVelocitySection.sync(settings.zeroVelocity);
  }

  // 描いている軌道ガイド線の総数を軌道ガイドタブへ中継する。毎フレーム渡してよい。
  public setOrbitGuideLineCount(total: number): void {
    this.orbitGuideTab.setLineCount(total);
  }
}
