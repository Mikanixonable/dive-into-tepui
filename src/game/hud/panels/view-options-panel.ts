// 表示パネル(マップモード左レール): マップの表示項目設定を担当する —
// 対象・ガイド・軌道ガイドの3タブに分かれ、タブの内装は TargetTab / GuideTab /
// OrbitGuideTab が担い、このパネルは器とタブ間の配線を持つ。
import { hudRail } from '../hud-root';
import {
  Button,
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  TabBar,
  type CollapseToggleLabels,
} from '../../../hud/widgets';
import type {
  MapDisplayCategory,
  MapDisplayMode,
  MapDisplayToggles,
} from '../../map/display-toggles';
import type { CelestialGridVisibility } from '../../../render/celestial-grid';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import type { OrbitGuideSettings, ZeroVelocitySettings } from '../../viewer/orbit-guide-settings';
import { OrbitGuideTab } from './orbit-guide-tab';
import { zeroVelocityJacobiAt } from './zero-velocity-section';
import { TargetTab } from './target-tab';
import { GuideTab } from './guide-tab';
import type { PanelCollapse } from '../panel-shell';
import type { OrbitGuideGroupTab, ViewOptionsTab } from '../hud-selection';
import type { RenderStyle } from '../../../render/render-style';

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

// このパネル自身の折りたたみトグルの見た目。
const VIEW_OPTIONS_COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '表示を閉じる',
  collapsedTitle: '表示を開く',
};

export class ViewOptionsPanel {
  public onBodyClassModeChange: ((key: MapDisplayCategory, mode: MapDisplayMode) => void) | null = null;
  public onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;
  // 軌道ガイドタブかゼロ速度曲線節を編集するたびに、編集後の軌道ガイド設定全体で呼ばれる。
  public onOrbitGuideChange: ((settings: OrbitGuideSettings) => void) | null = null;
  // タブが選ばれたときに、選ばれたタブで呼ばれる。
  public onTabChange: ((tab: ViewOptionsTab) => void) | null = null;
  // 軌道ガイドタブの群タブが選ばれたときに、選ばれたタブで呼ばれる。
  public onOrbitGuideGroupTabChange: ((tab: OrbitGuideGroupTab) => void) | null = null;
  public onRenderStyleChange: ((style: RenderStyle) => void) | null = null;

  private readonly tabBar: TabBar<ViewOptionsTab>;
  private readonly tabBodies: ReadonlyMap<ViewOptionsTab, HTMLElement>;
  private readonly renderStyleButtons: ReadonlyMap<RenderStyle, Button>;
  private readonly targetTab: TargetTab;
  private readonly guideTab: GuideTab;
  private readonly orbitGuideTab: OrbitGuideTab;

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

    const renderRow = document.createElement('div');
    renderRow.className = 'view-options-render-row editorial-index-row';
    renderRow.dataset['index'] = '00';
    const renderLabel = document.createElement('div');
    renderLabel.className = 'view-options-render-label';
    renderLabel.innerHTML = '<span>RENDER STYLE</span><small>DISPLAY PIPELINE</small>';
    const renderChoices = document.createElement('div');
    renderChoices.className = 'view-options-render-choices';
    renderChoices.setAttribute('role', 'group');
    renderChoices.setAttribute('aria-label', '描画方式');
    const realistic = new Button('REALISTIC', () => {
      this.onRenderStyleChange?.('realistic');
      this.setRenderStyle('realistic');
    }, undefined, 'dense');
    const schematic = new Button('SCHEMATIC', () => {
      this.onRenderStyleChange?.('schematic');
      this.setRenderStyle('schematic');
    }, undefined, 'dense');
    realistic.element.classList.add('view-options-render-choice');
    schematic.element.classList.add('view-options-render-choice');
    renderChoices.append(realistic.element, schematic.element);
    this.renderStyleButtons = new Map<RenderStyle, Button>([
      ['realistic', realistic],
      ['schematic', schematic],
    ]);
    renderRow.append(renderLabel, renderChoices);
    body.appendChild(renderRow);

    this.tabBar = new TabBar<ViewOptionsTab>(TAB_ITEMS, (tab) => this.onTabChange?.(tab));
    this.tabBar.element.setAttribute('aria-label', '表示するものの種類');
    body.appendChild(this.tabBar.element);

    // 各タブの本体を組み、内装はタブ部品へ委譲する。
    const targetBody = buildTabBody('target');
    body.appendChild(targetBody);
    this.targetTab = new TargetTab(targetBody);
    this.targetTab.onModeChange = (key, mode) => this.onBodyClassModeChange?.(key, mode);

    const guideBody = buildTabBody('guide');
    body.appendChild(guideBody);
    this.guideTab = new GuideTab(guideBody);
    this.guideTab.onGridToggle = (key, on) => this.onGridToggle?.(key, on);
    this.guideTab.onZeroVelocityChange = (change) => this.commitZeroVelocity(change);
    this.guideTab.onSnapToLagrange = (point) => this.commitZeroVelocity({
      jacobi: zeroVelocityJacobiAt(this.orbitGuideTab.settings.zeroVelocity, point),
    });

    const orbitBody = buildTabBody('orbit');
    body.appendChild(orbitBody);
    this.orbitGuideTab = new OrbitGuideTab(availableFamilies);
    this.orbitGuideTab.onSettingsChange = (settings) => this.commitOrbitGuide(settings);
    this.orbitGuideTab.onGroupTabChange = (tab) => this.onOrbitGuideGroupTabChange?.(tab);
    orbitBody.appendChild(this.orbitGuideTab.element);

    this.tabBodies = new Map([['target', targetBody], ['guide', guideBody], ['orbit', orbitBody]]);
    for (const [tab] of TAB_ITEMS) this.tabBar.buttonFor(tab)?.setAttribute('aria-controls', `hud-view-options-${tab}`);

    hudRail(root, 'left').appendChild(this.panel);
  }

  // 編集後の軌道ガイド設定を、軌道ガイドタブとゼロ速度曲線節の両方へ揃えてから通知する。
  private commitOrbitGuide(next: OrbitGuideSettings): void {
    this.setOrbitGuideSettings(next);
    this.onOrbitGuideChange?.(next);
  }

  // ゼロ速度曲線の設定を change の項目だけ書き換え、軌道ガイド設定全体として通知する。
  // 書き換え元の現在値は軌道ガイドタブが持つ正本から読む。
  private commitZeroVelocity(change: Partial<ZeroVelocitySettings>): void {
    const current = this.orbitGuideTab.settings;
    const zeroVelocity = { ...current.zeroVelocity, ...change };
    this.commitOrbitGuide({ ...current, zeroVelocity });
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

  public setRenderStyle(style: RenderStyle): void {
    for (const [candidate, button] of this.renderStyleButtons) button.setOn(candidate === style);
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
    this.targetTab.sync(toggles);
  }

  // 天球グリッドのトグル表示状態を現在値へ合わせる。
  public setGridVisibility(visibility: CelestialGridVisibility): void {
    this.guideTab.syncGrid(visibility);
  }

  // 軌道ガイドタブとゼロ速度曲線節(ガイドタブ)の表示状態を、軌道ガイド設定の現在値へ合わせる。
  public setOrbitGuideSettings(settings: OrbitGuideSettings): void {
    this.orbitGuideTab.setSettings(settings);
    this.guideTab.syncZeroVelocity(settings.zeroVelocity);
  }

  // 描いている軌道ガイド線の総数を軌道ガイドタブへ中継する。毎フレーム渡してよい。
  public setOrbitGuideLineCount(total: number): void {
    this.orbitGuideTab.setLineCount(total);
  }
}
