// HUD の静的 DOM/スタイル構築。
import type { RenderStyleSetting } from '../../render/render-style';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { injectThemeVariables } from '../theme';
import { buildOverlayLayers } from './overlay-layer';
import { OverlayManager } from './overlay-manager';
import { HelpPanel } from './windows/help-panel';
import {
  PanelShell,
  type HudWorldView,
  loadPanelCollapsed,
  onPanelCollapsedViewChange,
  savePanelCollapsed,
} from './panel-shell';
import { LAYOUT_TOKENS_STYLE } from './style/layout-tokens';
import { SKELETON_STYLE } from './style/skeleton-style';
import { PANEL_CONTENT_STYLE } from './style/panel-content-style';
import { COMBAT_VIEW_STYLE } from './style/combat-view-style';
import { MAP_VIEW_STYLE } from './style/map-view-style';
import { isCompactViewport } from './breakpoints';
import { startViewportTracking } from './viewport';
import {
  buildCollapseToggle, syncCollapseToggle, WIDGET_STYLE,
} from './widgets';
import type { OverlayLayers } from './overlay-layer';
import type { CollapseToggleLabels } from './widgets';
export {
  buildCollapseToggle,
  type CollapseToggleLabels,
  COLLAPSE_EXPANDED_GLYPH,
  COLLAPSE_COLLAPSED_GLYPH,
  PREDICT_TOGGLE_LABELS,
} from './widgets';

// 置き場4種(層・レール・シェルフ / トークン / パネル個別 / ウィジェット共通)ごとに
// 分割したスタイルを結合する。定義順はレイヤ→骨格→パネル→ビュー→ウィジェットで、
// カスケードの後勝ちを利用する箇所（同一セレクタの再定義）は各ファイル内で完結させてある。
const STYLE =
  LAYOUT_TOKENS_STYLE + SKELETON_STYLE + PANEL_CONTENT_STYLE + COMBAT_VIEW_STYLE + MAP_VIEW_STYLE;


// 指定タグ・id・class の要素を作り、parent に追加して返す。
function createHudElement(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const element = document.createElement(tag);
  element.id = id;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

export interface HudDomRefs {
  readonly root: HTMLElement;
  readonly layers: OverlayLayers;
  readonly combatRoot: HudWorldRoot;
  readonly mapRoot: HudWorldRoot;
  readonly svgOverlay: SVGSVGElement;
  readonly overlayManager: OverlayManager;
  readonly helpPanel: HelpPanel;
  readonly els: Map<string, HTMLElement>;
}

/** 戦闘/マップそれぞれが所有する HUD の DOM ルート。 */
export interface HudWorldRoot {
  readonly element: HTMLElement;
  readonly leftRail: HTMLElement;
  readonly rightRail: HTMLElement;
}

/** 動的に生成されるマップ系パネルの配置先を返す。 */
export function hudRail(root: HTMLElement, side: 'left' | 'right'): HTMLElement {
  return root.querySelector<HTMLElement>(`.hud-rail-${side}`) ?? root;
}

function railToggleLabels(side: 'left' | 'right'): CollapseToggleLabels {
  const label = side === 'left' ? '左' : '右';
  return {
    expandedGlyph: side === 'left' ? '◀' : '▶',
    collapsedGlyph: side === 'left' ? '▶' : '◀',
    expandedTitle: `${label}パネルを閉じる`,
    collapsedTitle: `${label}パネルを開く`,
  };
}

// レールの折りたたみ状態は PanelShell と同じビュー別 localStorage を共有する。一度も操作
// されていなければ、初回表示の既定として compact 幅でだけ畳んでおく。
function buildRailToggle(
  root: HTMLElement, rail: HTMLElement, side: 'left' | 'right', view: HudWorldView,
): void {
  const railId = `hud-rail-${side}`;
  const toggle = buildCollapseToggle(
    root, `hud-${view}-rail-toggle-${side}`, `rail-toggle rail-toggle-${side}`, rail, railToggleLabels(side),
  );
  const applyCollapsedState = (): void => {
    const collapsed = loadPanelCollapsed(railId) ?? isCompactViewport();
    rail.classList.toggle('collapsed', collapsed);
    syncCollapseToggle(toggle, rail, railToggleLabels(side));
  };
  applyCollapsedState();
  onPanelCollapsedViewChange(applyCollapsedState);
  toggle.addEventListener('click', () => savePanelCollapsed(railId, rail.classList.contains('collapsed')));
}

function buildWorldRoot(parent: HTMLElement, id: string, view: HudWorldView): HudWorldRoot {
  const element = createHudElement('div', id, parent, `hud-world-root hud-${view}-root`);
  const leftRail = createHudElement(
    'div', `${id}-rail-left`, element, 'hud-rail hud-rail-left',
  );
  const rightRail = createHudElement(
    'div', `${id}-rail-right`, element, 'hud-rail hud-rail-right',
  );
  buildRailToggle(element, leftRail, 'left', view);
  buildRailToggle(element, rightRail, 'right', view);
  return { element, leftRail, rightRail };
}

// PanelShell が組んだ見出し・本文・開閉ボタンを、アクセシブルな一領域として関連付ける。
function configureCombatPanel(panel: PanelShell): void {
  const titleId = `${panel.el.id}-title`;
  const bodyId = `${panel.el.id}-body`;
  panel.el.classList.add('combat-panel');
  panel.el.setAttribute('role', 'region');
  panel.el.setAttribute('aria-labelledby', titleId);
  panel.titleEl.id = titleId;
  panel.body.id = bodyId;

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
  const style = document.createElement('style');
  style.textContent = STYLE + WIDGET_STYLE;
  document.head.appendChild(style);
}

// マーカーのリード線を描く SVG オーバーレイを作る。
function buildSvgOverlay(root: HTMLElement): SVGSVGElement {
  const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgOverlay.setAttribute('aria-hidden', 'true');
  svgOverlay.style.position = 'absolute';
  svgOverlay.style.inset = '0';
  svgOverlay.style.width = '100%';
  svgOverlay.style.height = '100%';
  svgOverlay.style.pointerEvents = 'none';
  svgOverlay.style.zIndex = '0';
  root.appendChild(svgOverlay);
  return svgOverlay;
}

// 常設の情報パネル(VESSEL/ORBIT/TARGET/CONTACTS)を左右のドックへ組む。左右レールの
// 収納トグルと各 PanelShell の折りたたみは、現在ビューの永続状態を利用する。
function buildInfoPanels(leftRail: HTMLElement, rightRail: HTMLElement): void {
  const status = new PanelShell(rightRail, 'hud-vessel-status', 'Vessel');
  configureCombatPanel(status);
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

  const orbit = new PanelShell(
    leftRail, 'hud-orbit', 'Orbit', (view) => view === 'map' || isCompactViewport(),
  );
  configureCombatPanel(orbit);
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

  // ブースター燃焼管理は戦闘/マップで同じ DOM を移動して使う。ゲーム状態を直接
  // 参照する controller は Hud 側へ注入し、ここでは表示用のシェルだけを組む。
  const burnManagement = new PanelShell(
    leftRail, 'burn-management-panel', '燃焼管理',
  );
  configureCombatPanel(burnManagement);
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

  const target = new PanelShell(rightRail, 'hud-target', 'Target');
  configureCombatPanel(target);
  target.setHidden(true);
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
        <div class="row metric"><dt class="k">装甲</dt><dd class="v armor-readout">
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

  const enemies = new PanelShell(rightRail, 'hud-enemies', 'Enemies', isCompactViewport());
  configureCombatPanel(enemies);
  const count = document.createElement('span');
  count.className = 'panel-count';
  count.dataset['id'] = 'count';
  count.textContent = '—';
  enemies.titleEl.append(' ', count);
  enemies.body.innerHTML = `<ol class="contact-list" data-id="elist" aria-label="距離順の戦闘対象"></ol>`;

}

// マップ視点の縮尺バー。MapScaleBadge.sync がカメラの注視点基準で更新する。
function buildMapScale(root: HTMLElement): void {
  const mapScale = createHudElement('div', 'hud-map-scale', root);
  mapScale.dataset.id = 'map-scale';
  mapScale.setAttribute('aria-label', 'マップ縮尺');
  mapScale.innerHTML = `
    <div><span class="map-scale-value" data-id="map-scale-value"></span></div>
    <div class="map-scale-ruler" data-id="map-scale-ruler">
      <span class="map-scale-tick start"></span><span class="map-scale-tick q1"></span>
      <span class="map-scale-tick mid"></span><span class="map-scale-tick q3"></span>
      <span class="map-scale-tick end"></span>
    </div>`;
}

// 画面全体のトップバーを組む。1行目はビュー切替と現在の対象バッジ(ViewBadge が中身を組む)、
// 2行目は MET・時間加速・NODE WARP。
function buildTopBar(root: HTMLElement): void {
  const bar = createHudElement('section', 'hud-topbar', root);
  bar.setAttribute('aria-label', 'Mission status');
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

// 追従カメラの視点リセットボタンを組む。
function buildChaseReset(root: HTMLElement): void {
  const chaseReset = createHudElement('button', 'hud-chase-reset', root);
  chaseReset.setAttribute('type', 'button');
  chaseReset.setAttribute('aria-label', '視点をリセット');
  chaseReset.setAttribute('title', '視点をリセット');
  chaseReset.dataset.id = 'chase-reset';
  chaseReset.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2"
      fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
      <path d="M3 3v5h5"></path>
    </svg>`;
  chaseReset.addEventListener('keydown', (event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    chaseReset.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

// H キーを知らないマウス/タッチ操作者向けの、ヘルプパネルを開く常設バッジ。
function buildHelpBadge(root: HTMLElement, helpPanel: HelpPanel): void {
  const badge = createHudElement('button', 'hud-help-badge', root);
  badge.setAttribute('type', 'button');
  badge.setAttribute('aria-label', '操作ガイドを開く');
  badge.setAttribute('title', '操作ガイドを開く');
  badge.textContent = '?';
  badge.addEventListener('click', () => helpPanel.open());
}

// data-id 属性を持つ要素を、その id をキーにした Map にまとめて返す。
function collectDataIdElements(root: HTMLElement): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
    els.set(e.dataset['id']!, e);
  });
  return els;
}

// HUD のスタイル・レイヤ・各パネル・SVG オーバーレイを構築し、DOM 参照をまとめて返す。
export function buildHudDom(renderStyle: RenderStyleSetting): HudDomRefs {
  injectThemeVariables();
  injectStyle();
  startViewportTracking();
  const root = createHudElement('div', 'hud', document.body);
  // 模式図では白背景になるため、マーカー配色をそれに合わせて切り替える手掛かりとして
  // 現在のスタイルをルート要素の属性で公開する。
  renderStyle.subscribe((style) => { root.dataset['renderStyle'] = style; });
  const layers = buildOverlayLayers(root);
  const svgOverlay = buildSvgOverlay(layers.marker);
  const combatRoot = buildWorldRoot(layers.panel, 'hud-combat-root', 'combat');
  const mapRoot = buildWorldRoot(layers.panel, 'hud-map-root', 'map');

  // 常設パネル群を組む。
  buildInfoPanels(combatRoot.leftRail, combatRoot.rightRail);
  buildTopBar(layers.panel);
  buildChaseReset(layers.panel);
  buildMapScale(mapRoot.element);
  const overlayShield = createHudElement('div', 'hud-overlay-shield', layers.gate);
  const overlayManager = new OverlayManager(overlayShield, layers.gate);

  createHudElement('div', 'hud-toast', layers.notify);

  const helpPanel = new HelpPanel(layers.system, overlayManager);
  buildHelpBadge(layers.panel, helpPanel);

  createHudElement('div', 'hud-result', layers.system);

  const els = collectDataIdElements(root);
  return { root, layers, combatRoot, mapRoot, svgOverlay, overlayManager, helpPanel, els };
}
