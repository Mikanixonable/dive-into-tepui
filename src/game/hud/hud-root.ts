// HUD の静的 DOM/スタイル構築。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { HudShell } from '../../hud/hud-shell';
import { createHudElement } from '../../hud/hud-element';
import { HelpPanel } from './windows/help-panel';
import { PanelShell } from './panel-shell';
import { HudEls } from './hud-els';
import { LAYOUT_TOKENS_STYLE } from './style/layout-tokens';
import { SKELETON_STYLE } from './style/skeleton-style';
import { COMBAT_PANEL_ROWS_STYLE } from './style/combat-panel-rows-style';
import { MAP_PANEL_STYLE } from './style/map-panel-style';
import { STAGE_STATUS_STYLE } from './style/stage-status-style';
import { COMBAT_VIEW_STYLE } from './style/combat-view-style';
import { MAP_VIEW_STYLE } from './style/map-view-style';
import { SHIP_CONSTRUCTION_STYLE } from './style/ship-construction-style';
import { EDITORIAL_DATA_STYLE } from './style/editorial-data-style';
import { isCompactViewport } from '../../hud/breakpoints';
import { startViewportTracking } from '../../hud/viewport';
import { injectCommonUiStyle } from '../../hud/style/common-ui-style';
import type { RenderStyle } from '../../render/render-style';
import type { ViewMode } from '../view/view-mode';
import type { CollapseToggleLabels } from '../../hud/widgets';
import type { PanelCollapse } from './panel-shell';

// 後に定義した CSS ルールが優先されるため、トークン→骨格→パネル群→ビューの順に連結する。
const STYLE =
  LAYOUT_TOKENS_STYLE + SKELETON_STYLE + EDITORIAL_DATA_STYLE
  + COMBAT_PANEL_ROWS_STYLE + MAP_PANEL_STYLE + STAGE_STATUS_STYLE
  + COMBAT_VIEW_STYLE + MAP_VIEW_STYLE + SHIP_CONSTRUCTION_STYLE;


// 組み上がった HUD の DOM への参照一式。
interface HudDomRefs {
  readonly combatRoot: HudViewRoot;
  readonly mapRoot: HudViewRoot;
  readonly helpPanel: HelpPanel;
  readonly els: HudEls;
}

/** 戦闘/マップそれぞれが所有する HUD の DOM ルート。 */
interface HudViewRoot {
  readonly element: HTMLElement;
  readonly leftRail: HTMLElement;
  readonly rightRail: HTMLElement;
}

// root の左右どちらかのレールを返す。レールが無ければ root。
export function hudRail(root: HTMLElement, side: 'left' | 'right'): HTMLElement {
  return root.querySelector<HTMLElement>(`.hud-rail-${side}`) ?? root;
}

// レール収納トグルの字形と読み上げ名を、開く向き(左右)から組む。
function railToggleLabels(side: 'left' | 'right'): CollapseToggleLabels {
  const label = side === 'left' ? '左' : '右';
  return {
    expandedGlyph: side === 'left' ? '◀' : '▶',
    collapsedGlyph: side === 'left' ? '▶' : '◀',
    expandedTitle: `${label}パネルを閉じる`,
    collapsedTitle: `${label}パネルを開く`,
  };
}

// レールの収納トグルを配線する。折りたたみ状態はビュー別に保存し、一度も操作されていなければ
// compact 幅のとき畳んで始める。
function buildRailToggle(
  root: HTMLElement, rail: HTMLElement, collapse: PanelCollapse, side: 'left' | 'right', view: ViewMode,
): void {
  collapse.wire({
    toggleRoot: root,
    toggleId: `hud-${view}-rail-toggle-${side}`,
    toggleClassName: `rail-toggle rail-toggle-${side}`,
    target: rail,
    labels: railToggleLabels(side),
    storageId: `hud-rail-${side}`,
    defaultCollapsed: () => isCompactViewport(),
  });
}

// 戦闘/マップ一方ぶんの HUD ルートを組む。
function buildViewRoot(parent: HTMLElement, collapse: PanelCollapse, id: string, view: ViewMode): HudViewRoot {
  const element = createHudElement('div', id, parent, `hud-view-root hud-${view}-root`);
  // パネルの置き場は左右のレールで、それぞれ収納トグルを持つ。
  const leftRail = createHudElement(
    'div', `${id}-rail-left`, element, 'hud-rail hud-rail-left',
  );
  const rightRail = createHudElement(
    'div', `${id}-rail-right`, element, 'hud-rail hud-rail-right',
  );
  buildRailToggle(element, leftRail, collapse, 'left', view);
  buildRailToggle(element, rightRail, collapse, 'right', view);
  trackHudRailOccupancy(element, leftRail, rightRail);
  return { element, leftRail, rightRail };
}

// PanelShell が組んだ見出し・本文・開閉ボタンを、アクセシブルな一領域として関連付ける。
function configureCombatPanel(panel: PanelShell, code?: string): void {
  const titleId = `${panel.el.id}-title`;
  const bodyId = `${panel.el.id}-body`;
  panel.el.classList.add('combat-panel');
  panel.el.setAttribute('role', 'region');
  panel.el.setAttribute('aria-labelledby', titleId);
  panel.titleEl.id = titleId;
  if (code !== undefined) {
    const codeEl = document.createElement('span');
    codeEl.className = 'ui-section-code';
    codeEl.setAttribute('aria-hidden', 'true');
    codeEl.textContent = code;
    panel.titleEl.prepend(codeEl);
  }
  panel.body.id = bodyId;

  // 開閉ボタンへ aria 属性を与え、開閉状態が変わるたびに読み上げ名を更新する。
  const toggle = panel.el.querySelector<HTMLElement>('.panel-shell-collapse');
  if (!toggle) return;
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-controls', bodyId);
  const syncAccessibleName = (): void => toggle.setAttribute('aria-label', toggle.title);
  syncAccessibleName();
  toggle.addEventListener('click', syncAccessibleName);
}

// STYLE の CSS を <head> に注入する。
function injectStyle(): void {
  injectCommonUiStyle();
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 常設 VESSEL パネルを右レールへ組む。
function buildVesselStatusPanel(rightRail: HTMLElement, collapse: PanelCollapse): void {
  const status = new PanelShell(rightRail, collapse, 'hud-vessel-status', 'Vessel');
  configureCombatPanel(status, 'VSL');
  // 計器の行(燃料・RCS・出力・動圧・各モード・弾薬)と、展開・スロットル・主要操作の置き場。
  status.body.innerHTML = `
    <dl class="metric-list">
      <div class="row metric">
        <dt class="k">RCS燃料</dt>
        <dd class="v vessel-meter-readout">
          <span class="vessel-meter" data-id="rcs-fuel-meter"></span>
          <output class="vessel-meter-value" data-id="rcs-fuel-value">—</output>
        </dd>
      </div>
      <div class="row metric">
        <dt class="k">RCS制動 <kbd>${K.rcsDampToggle.label}</kbd></dt>
        <dd class="v"><output data-id="rcs">—</output></dd>
      </div>
      <div class="row metric">
        <dt class="k">並進出力 <kbd>${K.throttleLow.label}–${K.throttleMax.label}</kbd></dt>
        <dd class="v vessel-meter-readout" data-id="throttle-readout"></dd>
      </div>
      <div class="row metric" data-id="qdyn-row">
        <dt class="k">動圧</dt>
        <dd class="v vessel-meter-readout" data-id="qdyn-readout"></dd>
      </div>
      <div class="row metric">
        <dt class="k">微調整 <kbd>${K.fineAttitudeToggle.label}</kbd></dt>
        <dd class="v"><output data-id="fine">—</output></dd>
      </div>
      <div class="row metric">
        <dt class="k">進行方向ホールド <kbd>${K.progradeHoldToggle.label}</kbd></dt>
        <dd class="v"><output data-id="prohold">—</output></dd>
      </div>
      <div class="row metric">
        <dt class="k">視点RCS追従 <kbd>${K.followAttitudeToggle.label}</kbd></dt>
        <dd class="v"><output data-id="camfollow">—</output></dd>
      </div>
      <div class="row metric"><dt class="k">弾薬</dt><dd class="v"><output data-id="ammo">—</output></dd></div>
    </dl>
    <div class="vessel-deploy-controls" data-id="vessel-deploy-controls" role="group" aria-label="太陽電池パドル・放熱板の収納展開"></div>
    <div class="status-throttle-touch" data-id="status-throttle-touch"></div>
    <div class="panel-actions" data-id="status-actions" role="group" aria-label="機体の主要操作"></div>`;
}

// 常設 ORBIT パネルを左レールへ組む。軌道は map の主情報なので、compact 以外では開いて始める。
function buildOrbitInfoPanel(leftRail: HTMLElement, collapse: PanelCollapse): void {
  const orbit = new PanelShell(
    leftRail, collapse, 'hud-orbit', 'Orbit', () => isCompactViewport(),
  );
  configureCombatPanel(orbit, 'ORB');
  // Editorial な読み順: 文脈 → 高度/速度 → Ap/Pe → INC/PRD → 環境負荷 → 操作。
  orbit.body.innerHTML = `
    <div class="orbit-context-row">
      <span class="ui-data-context" data-id="orbit-context">—</span>
      <output class="orbit-center-name" data-id="center">—</output>
    </div>
    <div class="orbit-primary-grid">
      <div class="orbit-primary orbit-altitude">
        <output class="ui-data-hero" data-id="alt">—</output>
        <span class="ui-data-label">Altitude</span>
      </div>
      <div class="orbit-primary orbit-speed">
        <output class="ui-data-major" data-id="spd">—</output>
        <span class="ui-data-label">Velocity</span>
      </div>
    </div>
    <div class="orbit-apsides">
      <div class="orbit-apsis">
        <span class="ui-data-label" data-id="ap-label">Ap</span>
        <output class="ui-data-major" data-id="ap">—</output>
      </div>
      <div class="orbit-apsis">
        <span class="ui-data-label" data-id="pe-label">Pe</span>
        <output class="ui-data-major" data-id="pe">—</output>
      </div>
    </div>
    <dl class="orbit-secondary-grid">
      <div><dt class="ui-data-label">INC</dt><dd><output data-id="inc">—</output></dd></div>
      <div><dt class="ui-data-label">PRD</dt><dd><output data-id="prd">—</output></dd></div>
    </dl>
    <div class="orbit-environment" aria-label="飛行環境">
      <div class="orbit-env-row" data-id="orbit-qdyn-row">
        <div class="orbit-env-head"><span class="ui-data-label">q · DYNAMIC PRESSURE</span><output data-id="qdyn">—</output></div>
        <span class="orbit-env-meter" data-id="qdyn-meter"></span>
      </div>
      <div class="orbit-env-row" data-id="temp-row">
        <div class="orbit-env-head"><span class="ui-data-label">T · HULL TEMP</span><output data-id="temp">—</output></div>
        <span class="orbit-env-meter" data-id="temp-meter"></span>
      </div>
    </div>
    <div class="orbit-controls">
      <div data-id="reference-row"></div>
      <div class="panel-actions" data-id="orbit-actions" role="group" aria-label="軌道の操作"></div>
    </div>`;
}

// ブースター燃焼管理パネルを左レールへ組む。
function buildBurnManagementPanel(leftRail: HTMLElement, collapse: PanelCollapse): void {
  const burnManagement = new PanelShell(
    leftRail, collapse, 'burn-management-panel', '燃焼管理',
  );
  configureCombatPanel(burnManagement, 'BRN');
  // 段数・総質量・最後尾燃料・燃焼状態の行と、ブースター操作の置き場。
  burnManagement.body.innerHTML = `
    <dl class="metric-list burn-management-metrics">
      <div class="row metric">
        <dt class="k">接続段数</dt><dd class="v"><output data-id="burn-stage-count">—</output></dd>
      </div>
      <div class="row metric">
        <dt class="k">総質量</dt><dd class="v"><output data-id="burn-total-mass">—</output></dd>
      </div>
      <div class="row metric">
        <dt class="k">最後尾燃料</dt>
        <dd class="v burn-fuel-readout">
          <span class="burn-fuel-meter" data-id="burn-active-fuel-meter"></span>
          <output class="burn-fuel-value" data-id="burn-active-fuel-value">—</output>
        </dd>
      </div>
      <div class="row metric">
        <dt class="k">燃焼状態</dt><dd class="v"><output data-id="burn-state" aria-live="polite">—</output></dd>
      </div>
    </dl>
    <div class="metric-list burn-module-list" data-id="burn-module-list" aria-label="ブースターとデカプラー"></div>`;
}

// 建造は右レールの一パネルではなく、中央3Dを空けた独立 Workspace として組む。
function buildShipConstructionWorkspace(parent: HTMLElement): void {
  const construction = createHudElement(
    'section', 'ship-construction-panel', parent, 'construction-workspace hidden',
  );
  construction.dataset.id = 'ship-construction-panel';
  construction.dataset['mobilePane'] = 'catalog';
  construction.setAttribute('aria-label', '船体建造');

  construction.innerHTML = `
    <nav class="construction-mobile-tabs" data-id="construction-mobile-tabs" aria-label="建造表示切替"></nav>
    <aside class="construction-pane construction-pane-left ui-surface-focus" aria-label="モジュールカタログ">
      <header class="construction-target">
        <span class="ui-section-code">BLD</span>
        <span class="ui-data-context">CONSTRUCTION WORKSPACE</span>
        <strong data-id="construction-ship-name">—</strong>
        <span class="construction-target-dock" data-id="construction-dock-name">—</span>
      </header>
      <section class="construction-catalog" aria-label="モジュールカタログ">
        <div data-id="construction-category-tabs"></div>
        <div class="construction-module-cards" data-id="construction-module-cards"></div>
      </section>
    </aside>

    <div class="construction-center" aria-hidden="true">
      <span class="ui-section-code">ASM</span>
      <span class="ui-data-context">3D ASSEMBLY / SELECT A MOUNT POINT</span>
      <span class="construction-center-note">リングを選択 · 同じリングを再度選択して配置</span>
    </div>

    <aside class="construction-pane construction-pane-right ui-surface-focus" aria-label="建造結果">
      <section class="construction-selection" aria-label="建造選択">
        <div class="construction-selection-row"><span>部品</span><strong data-id="construction-selected-module">—</strong></div>
        <div class="construction-selection-row"><span>接続先</span><strong data-id="construction-selected-slot">—</strong></div>
        <div class="construction-slots" data-id="construction-slots" aria-label="接続候補"></div>
      </section>
      <div class="construction-metrics">
        <div class="construction-metric">
          <span class="ui-data-label">MODULES</span><output data-id="construction-count">0</output>
        </div>
        <div class="construction-metric">
          <span class="ui-data-label">MASS</span><output data-id="construction-mass">0 kg</output>
          <small class="ui-delta" data-id="construction-mass-preview"></small>
        </div>
        <div class="construction-metric construction-hp-row">
          <span class="ui-data-label">HP</span><div data-id="construction-hp-meter"></div>
          <output data-id="construction-hp">0 / 0</output><small class="ui-delta" data-id="construction-hp-preview"></small>
        </div>
        <div class="construction-metric"><span class="ui-data-label">THRUST</span><output data-id="construction-thrust">0</output><small class="ui-delta" data-id="construction-thrust-preview"></small></div>
        <div class="construction-metric"><span class="ui-data-label">MAIN FUEL CAPACITY</span><output data-id="construction-main-fuel">0</output><small class="ui-delta" data-id="construction-main-fuel-preview"></small></div>
        <div class="construction-metric"><span class="ui-data-label">RCS FUEL CAPACITY</span><output data-id="construction-rcs-fuel">0</output><small class="ui-delta" data-id="construction-rcs-fuel-preview"></small></div>
        <div class="construction-metric"><span class="ui-data-label">POWER GENERATION</span><output data-id="construction-power">0</output><small class="ui-delta" data-id="construction-power-preview"></small></div>
        <div class="construction-metric"><span class="ui-data-label">RADIATOR AREA</span><output data-id="construction-radiation">0</output><small class="ui-delta" data-id="construction-radiation-preview"></small></div>
        <div class="construction-metric"><span class="ui-data-label">ROLE</span><output data-id="construction-role">物資</output></div>
        <div class="construction-metric"><span class="ui-data-label">COMPLETION</span><output data-id="construction-completion">部品を1個以上配置</output></div>
      </div>
      <p class="construction-warning ui-status-note ui-status-note--warning hidden" data-id="construction-warning"></p>
      <div class="construction-actions" data-id="construction-actions" role="group" aria-label="船体建造操作"></div>
    </aside>`;
}

// 常設 TARGET パネルを右レールへ組む。ロック対象が無い間は隠す。
function buildTargetPanel(rightRail: HTMLElement, collapse: PanelCollapse): void {
  const target = new PanelShell(rightRail, collapse, 'hud-target', 'Target');
  configureCombatPanel(target, 'TGT');
  target.setHidden(true);
  // 名前・距離・速度・装甲の行と、タンパク質標的の詳細欄。
  target.body.innerHTML = `
    <div data-id="tgtbody">
      <div class="target-identity">
        <span class="target-lock-glyph" aria-hidden="true">⌖</span>
        <strong class="target-name" data-id="tgtname" aria-live="polite">—</strong>
        <span class="target-role">ターゲット</span>
      </div>
      <dl class="metric-list">
        <div class="row metric">
          <dt class="k">距離</dt>
          <dd class="v"><output class="target-primary-value" data-id="tgt-dist">—</output></dd>
        </div>
        <div class="row metric">
          <dt class="k">接近速度</dt><dd class="v"><output data-id="tgt-closing">—</output></dd>
        </div>
        <div class="row metric">
          <dt class="k">相対速度</dt><dd class="v"><output data-id="tgt-relative-speed">—</output></dd>
        </div>
        <div class="row metric" data-id="tgt-armor-row"><dt class="k">装甲</dt><dd class="v armor-readout">
          <span class="armor-meter" data-id="tgt-armor-meter"></span>
          <output class="armor-value" data-id="tgt-armor-value">—</output>
        </dd></div>
      </dl>
      <section id="tgt-protein" data-id="tgt-protein" class="protein-target-details hidden" aria-label="タンパク質構造">
        <div class="protein-target-heading"><span>タンパク質</span><output data-id="tgt-protein-phase">INTACT</output></div>
        <div class="row metric"><dt class="k">構造安定性</dt><dd class="v"><output data-id="tgt-integrity-value">—</output></dd></div>
        <div data-id="tgt-protein-sites"></div>
      </section>
      <p class="target-help">軌道要素は右クリックで表示</p>
    </div>`;
}

// 常設 ENEMIES パネルを右レールへ組む。件数バッジを見出しへ添える。
function buildEnemiesPanel(rightRail: HTMLElement, collapse: PanelCollapse): void {
  const enemies = new PanelShell(rightRail, collapse, 'hud-enemies', 'CONTACTS', isCompactViewport());
  configureCombatPanel(enemies, 'CNT');
  const count = document.createElement('span');
  count.className = 'panel-count';
  count.dataset['id'] = 'count';
  count.textContent = '—';
  enemies.titleEl.append(' ', count);
  enemies.body.innerHTML = `<ol class="contact-list" data-id="elist" aria-label="距離順の戦闘対象"></ol>`;
}

// 常設の情報パネル群を左右のドックへ組む。
function buildInfoPanels(leftRail: HTMLElement, rightRail: HTMLElement, collapse: PanelCollapse): void {
  buildVesselStatusPanel(rightRail, collapse);
  buildOrbitInfoPanel(leftRail, collapse);
  buildBurnManagementPanel(leftRail, collapse);
  buildTargetPanel(rightRail, collapse);
  buildEnemiesPanel(rightRail, collapse);
}

// マップビューの縮尺バーを組む。
function buildMapScale(root: HTMLElement): void {
  const mapScale = createHudElement('div', 'hud-map-scale', root, 'ui-surface-quiet');
  mapScale.dataset.id = 'map-scale';
  mapScale.setAttribute('aria-label', 'マップ縮尺');
  // 数値表示と、その下の目盛りルーラー。
  mapScale.innerHTML = `
    <div><span class="map-scale-value" data-id="map-scale-value"></span></div>
    <div class="map-scale-ruler" data-id="map-scale-ruler">
      <span class="map-scale-tick start"></span><span class="map-scale-tick q1"></span>
      <span class="map-scale-tick mid"></span><span class="map-scale-tick q3"></span>
      <span class="map-scale-tick end"></span>
    </div>`;
}

// 画面全体のトップバーを組む。
function buildTopBar(root: HTMLElement): void {
  const bar = createHudElement('section', 'hud-topbar', root, 'ui-surface-quiet');
  bar.setAttribute('aria-label', 'Mission status');
  // タイトル画面の status block と同じ語彙で、workspace → context → mission time の順に読む。
  bar.classList.add('editorial-instrument');
  bar.innerHTML = `
    <div class="gs-status-head">
      <span class="ui-section-code" aria-hidden="true">MIS</span>
      <span class="ui-data-context">MISSION STATUS</span>
      <span class="gs-workspace ui-data-context" aria-label="現在のHUDワークスペース"></span>
    </div>
    <div class="gs-row" id="hud-viewbadge" data-id="gs-viewrow"></div>
    <div class="gs-metrics">
      <div class="gs-metric gs-metric-time">
        <span class="ui-data-label">MISSION TIME</span>
        <output class="v" data-id="met">—</output>
      </div>
      <div class="gs-metric">
        <span class="ui-data-label">SIM RATE</span>
        <div class="gs-speed-holder" data-id="sim-speed"></div>
      </div>
      <div class="gs-metric">
        <span class="ui-data-label">NODE WARP</span>
        <output class="v" data-id="node-warp-remain">—</output>
      </div>
    </div>`;
}

// 視点リセットボタンを組む。id の chase は「動く実体を追っている視点」の意味。
function buildChaseReset(root: HTMLElement): void {
  const chaseReset = createHudElement('button', 'hud-chase-reset', root, 'ui-surface-quiet');
  chaseReset.setAttribute('type', 'button');
  chaseReset.setAttribute('aria-label', '視点をリセット');
  chaseReset.setAttribute('title', '視点をリセット');
  chaseReset.dataset.id = 'chase-reset';
  // リセットを示す矢印アイコンを描く。
  chaseReset.innerHTML = `
    <span class="hud-mini-code" aria-hidden="true">CAM</span>
    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2"
      fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
      <path d="M3 3v5h5"></path>
    </svg>`;
  // キーボード操作でもポインタ操作と同じ経路で処理されるよう、Enter/Space を pointerdown へ変換する。
  chaseReset.addEventListener('keydown', (event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    chaseReset.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

// H キーを知らないマウス/タッチ操作者向けの、ヘルプパネルを開く常設バッジ。
function buildHelpBadge(root: HTMLElement, helpPanel: HelpPanel): void {
  const badge = createHudElement('button', 'hud-help-badge', root, 'ui-surface-quiet');
  badge.setAttribute('type', 'button');
  badge.setAttribute('aria-label', '操作ガイドを開く');
  badge.setAttribute('title', '操作ガイドを開く');
  badge.innerHTML = '<span class="hud-mini-code" aria-hidden="true">HLP</span><span>?</span>';
  badge.addEventListener('click', () => helpPanel.open());
}

/* 上部クロームの実寸を HUD の配置トークンへ反映する。トップバーの行数が変わっても
   レール・通知が固定px前提で重ならないよう、ResizeObserverで追従する。 */
function trackHudChromeInset(root: HTMLElement, chrome: HTMLElement): void {
  const sync = (): void => {
    const height = Math.ceil(chrome.getBoundingClientRect().height);
    if (height > 0) root.style.setProperty('--hud-chrome-h', `${height}px`);
  };
  sync();
  requestAnimationFrame(sync);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(sync);
    observer.observe(chrome);
  }
}

/* 左右レールが実際に占めている幅をビュー自身の CSS 変数へ反映する。
   収納・幅変更・viewport変更を中央HUDが rail-w の手計算なしで追従できる。 */
function trackHudRailOccupancy(root: HTMLElement, leftRail: HTMLElement, rightRail: HTMLElement): void {
  const sync = (): void => {
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0) return;
    const leftRect = leftRail.getBoundingClientRect();
    const rightRect = rightRail.getBoundingClientRect();
    root.style.setProperty('--hud-left-rail-occupied', `${Math.max(0, Math.ceil(leftRect.right - rootRect.left))}px`);
    root.style.setProperty('--hud-right-rail-occupied', `${Math.max(0, Math.ceil(rootRect.right - rightRect.left))}px`);
  };
  sync();
  requestAnimationFrame(sync);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    observer.observe(leftRail);
    observer.observe(rightRail);
  }
}

// HUD のスタイル・レイヤ・各パネルを構築し、DOM 参照をまとめて返す。
export function buildHudDom(shell: HudShell, collapse: PanelCollapse, renderStyle: RenderStyle): HudDomRefs {
  injectStyle();
  startViewportTracking();
  const { root, layers } = shell;
  // 模式図では白背景になるので、配色を切り替えられるよう現在のスタイルを属性で公開する。
  root.dataset['renderStyle'] = renderStyle;
  const combatRoot = buildViewRoot(layers.panel, collapse, 'hud-combat-root', 'combat');
  const mapRoot = buildViewRoot(layers.panel, collapse, 'hud-map-root', 'map');

  // 常設パネル群を組む。
  buildInfoPanels(combatRoot.leftRail, combatRoot.rightRail, collapse);
  buildShipConstructionWorkspace(layers.panel);

  // 画面上端の状態・カメラ操作・ヘルプを一つのクロームへまとめる。各要素が独立した
  // top 値を持たないため、トップバーが折り返しても互いに重ならない。
  const helpPanel = new HelpPanel(shell.overlayManager);
  const chrome = createHudElement('div', 'hud-chrome', layers.panel, 'hud-chrome');
  buildTopBar(chrome);
  buildChaseReset(chrome);
  buildHelpBadge(chrome, helpPanel);
  trackHudChromeInset(root, chrome);

  buildMapScale(mapRoot.element);
  createHudElement('div', 'hud-toast', layers.notify, 'ui-surface-focus');

  const els = new HudEls(root);
  return { combatRoot, mapRoot, helpPanel, els };
}
