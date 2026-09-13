// HUD の静的 DOM/スタイル構築。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { injectThemeVariables } from '../../theme';
import type { HudShell } from '../../hud/hud-shell';
import { createHudElement } from '../../hud/hud-element';
import { HelpPanel } from './windows/help-panel';
import { PanelShell, wirePanelCollapse } from './panel-shell';
import { LAYOUT_TOKENS_STYLE } from './style/layout-tokens';
import { SKELETON_STYLE } from './style/skeleton-style';
import { COMBAT_PANEL_ROWS_STYLE } from './style/combat-panel-rows-style';
import { MAP_PANEL_STYLE } from './style/map-panel-style';
import { STAGE_STATUS_STYLE } from './style/stage-status-style';
import { COMBAT_VIEW_STYLE } from './style/combat-view-style';
import { MAP_VIEW_STYLE } from './style/map-view-style';
import { isCompactViewport } from '../../hud/breakpoints';
import { startViewportTracking } from '../../hud/viewport';
import { injectCommonUiStyle } from '../../hud/style/common-ui-style';
import type { RenderStyle } from '../../render/render-style';
import type { ViewMode } from '../../render/view-mode';
import type { CollapseToggleLabels } from '../../hud/widgets';

// トークン→骨格→パネル群→ビュー→ウィジェット共通の順に結合する。
const STYLE =
  LAYOUT_TOKENS_STYLE + SKELETON_STYLE
  + COMBAT_PANEL_ROWS_STYLE + MAP_PANEL_STYLE + STAGE_STATUS_STYLE
  + COMBAT_VIEW_STYLE + MAP_VIEW_STYLE;


interface HudDomRefs {
  readonly combatRoot: HudViewRoot;
  readonly mapRoot: HudViewRoot;
  readonly helpPanel: HelpPanel;
  readonly els: Map<string, HTMLElement>;
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
  root: HTMLElement, rail: HTMLElement, side: 'left' | 'right', view: ViewMode,
): void {
  wirePanelCollapse({
    toggleRoot: root,
    toggleId: `hud-${view}-rail-toggle-${side}`,
    toggleClassName: `rail-toggle rail-toggle-${side}`,
    target: rail,
    labels: railToggleLabels(side),
    storageId: `hud-rail-${side}`,
    defaultCollapsed: () => isCompactViewport(),
  });
}

// 戦闘/マップ一方ぶんの HUD ルートと、その左右レール・収納トグルを組む。
function buildViewRoot(parent: HTMLElement, id: string, view: ViewMode): HudViewRoot {
  // ビューのルート要素を作る。
  const element = createHudElement('div', id, parent, `hud-view-root hud-${view}-root`);
  // 左右のレールを子として組む。
  const leftRail = createHudElement(
    'div', `${id}-rail-left`, element, 'hud-rail hud-rail-left',
  );
  const rightRail = createHudElement(
    'div', `${id}-rail-right`, element, 'hud-rail hud-rail-right',
  );
  // 各レールの収納トグルを配線する。
  buildRailToggle(element, leftRail, 'left', view);
  buildRailToggle(element, rightRail, 'right', view);
  return { element, leftRail, rightRail };
}

// PanelShell が組んだ見出し・本文・開閉ボタンを、アクセシブルな一領域として関連付ける。
function configureCombatPanel(panel: PanelShell): void {
  // 見出しと本文を id で結び、region として関連付ける。
  const titleId = `${panel.el.id}-title`;
  const bodyId = `${panel.el.id}-body`;
  panel.el.classList.add('combat-panel');
  panel.el.setAttribute('role', 'region');
  panel.el.setAttribute('aria-labelledby', titleId);
  panel.titleEl.id = titleId;
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
function buildVesselStatusPanel(rightRail: HTMLElement): void {
  const status = new PanelShell(rightRail, 'hud-vessel-status', 'Vessel');
  configureCombatPanel(status);
  // 計器の行(燃料・RCS・出力・動圧・各モード・弾薬)と、展開・スロットル・主要操作の置き場。
  status.body.innerHTML = `
    <dl class="metric-list">
      <div class="row metric">
        <dt class="k">RCS燃料</dt>
        <dd class="v vessel-meter-readout">
          <span class="vessel-meter w-meter-track" data-id="rcs-fuel-meter" role="progressbar"
            aria-label="RCS燃料" aria-valuemin="0">
            <span class="w-meter-fill" data-id="rcs-fuel-fill"></span>
          </span>
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

// 常設 ORBIT パネルを左レールへ組む。マップビューと compact 幅では畳んで始める。
function buildOrbitInfoPanel(leftRail: HTMLElement): void {
  const orbit = new PanelShell(
    leftRail, 'hud-orbit', 'Orbit', (view) => view === 'map' || isCompactViewport(),
  );
  configureCombatPanel(orbit);
  // 基準天体・高度・速度・軌道要素・動圧・機体温度の行と、軌道の操作の置き場。
  orbit.body.innerHTML = `
    <div class="row" data-id="reference-row"></div>
    <dl class="metric-list">
      <div class="row metric">
        <dt class="k">基準</dt><dd class="v"><output data-id="center">—</output></dd>
      </div>
      <div class="row metric"><dt class="k">高度</dt><dd class="v"><output data-id="alt">—</output></dd></div>
      <div class="row metric"><dt class="k">速度</dt><dd class="v"><output data-id="spd">—</output></dd></div>
      <div class="row metric"><dt class="k" data-id="ap-label">遠地点 Ap</dt><dd class="v"><output data-id="ap">—</output></dd></div>
      <div class="row metric"><dt class="k" data-id="pe-label">近地点 Pe</dt><dd class="v"><output data-id="pe">—</output></dd></div>
      <div class="row metric"><dt class="k">傾斜角</dt><dd class="v"><output data-id="inc">—</output></dd></div>
      <div class="row metric"><dt class="k">周期</dt><dd class="v"><output data-id="prd">—</output></dd></div>
      <div class="row metric"><dt class="k">動圧 q</dt><dd class="v"><output data-id="qdyn">—</output></dd></div>
      <div class="row metric">
        <dt class="k">機体温度</dt><dd class="v"><output data-id="temp">—</output></dd>
      </div>
    </dl>
    <div class="panel-actions" data-id="orbit-actions" role="group" aria-label="軌道の操作"></div>`;
}

// ブースター燃焼管理パネルを左レールへ組む。
function buildBurnManagementPanel(leftRail: HTMLElement): void {
  const burnManagement = new PanelShell(
    leftRail, 'burn-management-panel', '燃焼管理',
  );
  configureCombatPanel(burnManagement);
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
          <span class="burn-fuel-meter w-meter-track" data-id="burn-active-fuel-meter" role="progressbar"
            aria-label="最後尾ブースター燃料" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
            <span class="w-meter-fill" data-id="burn-active-fuel-fill"></span>
          </span>
          <output class="burn-fuel-value" data-id="burn-active-fuel-value">—</output>
        </dd>
      </div>
      <div class="row metric">
        <dt class="k">燃焼状態</dt><dd class="v"><output data-id="burn-state" aria-live="polite">—</output></dd>
      </div>
    </dl>
    <div class="panel-actions burn-actions" data-id="burn-actions" role="group" aria-label="ブースター操作"></div>`;
}

// 常設 TARGET パネルを右レールへ組む。ロック対象が無い間は隠す。
function buildTargetPanel(rightRail: HTMLElement): void {
  const target = new PanelShell(rightRail, 'hud-target', 'Target');
  configureCombatPanel(target);
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
          <span class="armor-meter w-meter-track" data-id="tgt-armor-meter" role="progressbar"
            aria-label="ターゲットの装甲" aria-valuemin="0">
            <span class="w-meter-fill" data-id="tgt-armor-fill"></span>
          </span>
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
function buildEnemiesPanel(rightRail: HTMLElement): void {
  const enemies = new PanelShell(rightRail, 'hud-enemies', 'Enemies', isCompactViewport());
  configureCombatPanel(enemies);
  const count = document.createElement('span');
  count.className = 'panel-count';
  count.dataset['id'] = 'count';
  count.textContent = '—';
  enemies.titleEl.append(' ', count);
  enemies.body.innerHTML = `<ol class="contact-list" data-id="elist" aria-label="距離順の戦闘対象"></ol>`;
}

// 常設の情報パネル群を左右のドックへ組む。
function buildInfoPanels(leftRail: HTMLElement, rightRail: HTMLElement): void {
  buildVesselStatusPanel(rightRail);
  buildOrbitInfoPanel(leftRail);
  buildBurnManagementPanel(leftRail);
  buildTargetPanel(rightRail);
  buildEnemiesPanel(rightRail);
}

// マップビューの縮尺バー(数値と目盛りルーラー)を組む。
function buildMapScale(root: HTMLElement): void {
  // 縮尺表示の要素を作る。
  const mapScale = createHudElement('div', 'hud-map-scale', root, 'ui-surface-quiet');
  mapScale.dataset.id = 'map-scale';
  mapScale.setAttribute('aria-label', 'マップ縮尺');
  // 数値表示と目盛りルーラーを組む。
  mapScale.innerHTML = `
    <div><span class="map-scale-value" data-id="map-scale-value"></span></div>
    <div class="map-scale-ruler" data-id="map-scale-ruler">
      <span class="map-scale-tick start"></span><span class="map-scale-tick q1"></span>
      <span class="map-scale-tick mid"></span><span class="map-scale-tick q3"></span>
      <span class="map-scale-tick end"></span>
    </div>`;
}

// 画面全体のトップバーを組む。1行目はビュー切替と現在の対象バッジの置き場、2行目は MET・
// 時間加速・NODE WARP。
function buildTopBar(root: HTMLElement): void {
  // トップバー本体の section 要素を作る。
  const bar = createHudElement('section', 'hud-topbar', root, 'ui-surface-quiet');
  bar.setAttribute('aria-label', 'Mission status');
  // ビュー切替行と、MET・時間加速・NODE WARP の行を組み立てる。
  bar.innerHTML = `
    <div class="gs-row" id="hud-viewbadge" data-id="gs-viewrow"></div>
    <div class="gs-row">
      <span class="k">Mission time</span><output class="v" data-id="met">—</output>
      <span class="gs-sep" aria-hidden="true">·</span>
      <span class="k">時間加速</span><select class="v gs-speed-select" data-id="sim-speed" aria-label="時間加速"></select>
      <span class="gs-sep" aria-hidden="true">·</span>
      <span class="k">Node warp</span><output class="v" data-id="node-warp-remain">—</output>
    </div>`;
}

// 視点リセットボタンを組む。id の chase は「動く実体を追っている視点」の意味。
function buildChaseReset(root: HTMLElement): void {
  // リセットボタン本体を作る。
  const chaseReset = createHudElement('button', 'hud-chase-reset', root, 'ui-surface-quiet');
  chaseReset.setAttribute('type', 'button');
  chaseReset.setAttribute('aria-label', '視点をリセット');
  chaseReset.setAttribute('title', '視点をリセット');
  chaseReset.dataset.id = 'chase-reset';
  // リセットを示す矢印アイコンを描く。
  chaseReset.innerHTML = `
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
  badge.textContent = '?';
  badge.addEventListener('click', () => helpPanel.open());
}

// data-id 属性を持つ要素を、その id をキーにした Map にまとめて返す。
function collectDataIdElements(root: HTMLElement): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-id]'))) {
    els.set(element.dataset['id']!, element);
  }
  return els;
}

// HUD のスタイル・レイヤ・各パネルを構築し、DOM 参照をまとめて返す。
export function buildHudDom(shell: HudShell, renderStyle: RenderStyle): HudDomRefs {
  injectThemeVariables();
  injectStyle();
  startViewportTracking();
  const { root, layers } = shell;
  // 模式図では白背景になるため、マーカー配色をそれに合わせて切り替える手掛かりとして
  // 現在のスタイルをルート要素の属性で公開する。
  root.dataset['renderStyle'] = renderStyle;
  const combatRoot = buildViewRoot(layers.panel, 'hud-combat-root', 'combat');
  const mapRoot = buildViewRoot(layers.panel, 'hud-map-root', 'map');

  // 常設パネル群を組む。
  buildInfoPanels(combatRoot.leftRail, combatRoot.rightRail);
  buildTopBar(layers.panel);
  buildChaseReset(layers.panel);
  buildMapScale(mapRoot.element);
  createHudElement('div', 'hud-toast', layers.notify, 'ui-surface-focus');

  const helpPanel = new HelpPanel(layers.system, shell.overlayManager);
  buildHelpBadge(layers.panel, helpPanel);

  const els = collectDataIdElements(root);
  return { combatRoot, mapRoot, helpPanel, els };
}
