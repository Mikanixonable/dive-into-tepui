// HUD の静的 DOM/スタイル構築。
import { KEY_MAPPING as K } from '../input/key-mapping';
import { injectThemeVariables } from '../theme';
import { buildOverlayLayers } from './overlay-layer';
import { OverlayManager } from './overlay-manager';
import { HelpPanel } from './help-panel';
import { PanelShell, loadPanelCollapsed, savePanelCollapsed } from './panel-shell';
import { LAYOUT_TOKENS_STYLE } from './layout-tokens';
import { SKELETON_STYLE } from './skeleton-style';
import { PANEL_CONTENT_STYLE } from './panel-content-style';
import { COMBAT_VIEW_STYLE } from './combat-view-style';
import { MAP_VIEW_STYLE } from './map-view-style';
import { isCompactViewport } from './breakpoints';
import { startViewportTracking } from './viewport';
import {
  buildCollapseToggle, WIDGET_STYLE,
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
  readonly svgOverlay: SVGSVGElement;
  readonly overlayManager: OverlayManager;
  readonly helpPanel: HelpPanel;
  readonly els: Map<string, HTMLElement>;
}

/** 動的に生成されるマップ系パネルの配置先を返す。 */
export function hudRail(root: HTMLElement, side: 'left' | 'right'): HTMLElement {
  const id = `hud-rail-${side}`;
  return root.querySelector<HTMLElement>(`#${id}`) ?? root;
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

export function syncNavballPlacement(root: HTMLElement, mapMode: boolean): void {
  const navball = root.querySelector<HTMLElement>('#navball');
  const target = mapMode ? root.querySelector<HTMLElement>('#hud-rail-left') : root;
  if (navball && target && navball.parentElement !== target) target.appendChild(navball);
}

// レールの折りたたみ状態は PanelShell と同じ localStorage を共有する。一度も操作されて
// いなければ、初回表示の既定として compact 幅でだけ畳んでおく（マップビュー = PREDICT バー +
// 畳まれた左右レール)。
function buildRailToggle(root: HTMLElement, rail: HTMLElement, side: 'left' | 'right'): void {
  const railId = `hud-rail-${side}`;
  const collapsed = loadPanelCollapsed(railId) ?? isCompactViewport();
  rail.classList.toggle('collapsed', collapsed);
  const toggle = buildCollapseToggle(root, `hud-rail-toggle-${side}`, 'rail-toggle', rail, railToggleLabels(side));
  toggle.addEventListener('click', () => savePanelCollapsed(railId, rail.classList.contains('collapsed')));
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
function buildInfoPanels(root: HTMLElement, leftRail: HTMLElement, rightRail: HTMLElement): void {
  const status = new PanelShell(rightRail, 'hud-status', 'Vessel');
  configureCombatPanel(status);
  status.body.innerHTML = `
    <dl class="metric-list">
      <div class="row metric">
        <dt class="k">RCS制動 <kbd>${K.rcsDampToggle.label}</kbd></dt>
        <dd class="v"><output data-id="rcs">—</output></dd>
      </div>
      <div class="row metric">
        <dt class="k">並進出力 <kbd>${K.throttleLow.label}–${K.throttleMax.label}</kbd></dt>
        <dd class="v"><output data-id="throttle">—</output></dd>
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
    <div class="status-throttle-touch" data-id="status-throttle-touch"></div>
    <div class="status-actions" data-id="status-actions" role="group" aria-label="機体の主要操作"></div>`;

  const orbit = new PanelShell(leftRail, 'hud-orbit', 'Orbit', isCompactViewport());
  configureCombatPanel(orbit);
  orbit.body.innerHTML = `
    <dl class="metric-list">
      <div class="row metric">
        <dt class="k">基準天体</dt><dd class="v"><output data-id="center">—</output></dd>
      </div>
      <div class="row metric"><dt class="k">高度</dt><dd class="v"><output data-id="alt">—</output></dd></div>
      <div class="row metric"><dt class="k">速度</dt><dd class="v"><output data-id="spd">—</output></dd></div>
      <div class="row metric"><dt class="k">遠地点 Ap</dt><dd class="v"><output data-id="ap">—</output></dd></div>
      <div class="row metric"><dt class="k">近地点 Pe</dt><dd class="v"><output data-id="pe">—</output></dd></div>
      <div class="row metric"><dt class="k">傾斜角</dt><dd class="v"><output data-id="inc">—</output></dd></div>
      <div class="row metric"><dt class="k">周期</dt><dd class="v"><output data-id="prd">—</output></dd></div>
      <div class="row metric"><dt class="k">動圧 q</dt><dd class="v"><output data-id="qdyn">—</output></dd></div>
      <div class="row metric">
        <dt class="k">機体温度</dt><dd class="v"><output data-id="temp">—</output></dd>
      </div>
    </dl>`;

  const target = new PanelShell(rightRail, 'hud-target', 'Target');
  configureCombatPanel(target);
  target.setHidden(true);
  target.body.innerHTML = `
    <div data-id="tgtbody">
      <div class="target-identity">
        <span class="target-lock-glyph" aria-hidden="true">⌖</span>
        <strong class="target-name" data-id="tgtname" aria-live="polite">—</strong>
        <span class="target-role">第一ターゲット</span>
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
          <span class="armor-meter" data-id="tgt-armor-meter" role="progressbar"
            aria-label="ターゲットの装甲" aria-valuemin="0">
            <span class="armor-meter-fill" data-id="tgt-armor-fill"></span>
          </span>
          <output class="armor-value" data-id="tgt-armor-value">—</output>
        </dd></div>
      </dl>
      <p class="target-help">軌道要素は右クリックで表示</p>
    </div>`;

  const enemies = new PanelShell(rightRail, 'hud-enemies', 'Contacts', isCompactViewport());
  configureCombatPanel(enemies);
  const count = document.createElement('span');
  count.className = 'panel-count';
  count.dataset['id'] = 'count';
  count.textContent = '—';
  enemies.titleEl.append(' ', count);
  enemies.body.innerHTML = `<ol class="contact-list" data-id="elist" aria-label="距離順の戦闘対象"></ol>`;

  // マップ視点の縮尺バー。MapScaleBadge.sync がカメラの注視点基準で更新する。
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

// 画面全体のグローバルステータス(MET・時間加速・NODE WARP)を組む。
function buildGlobalStatus(root: HTMLElement): void {
  const bar = createHudElement('section', 'hud-globalstatus', root);
  bar.setAttribute('aria-label', 'Mission status');
  bar.innerHTML = `
    <span class="k">Mission time</span><output class="v" data-id="met">—</output>
    <span class="gs-sep" aria-hidden="true">·</span>
    <span class="k">時間加速</span><output class="v" data-id="sim-speed">—</output>
    <span class="gs-sep" aria-hidden="true">·</span>
    <span class="k">Node warp</span><output class="v" data-id="node-warp-remain">—</output>`;
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

// data-id 属性を持つ要素を、その id をキーにした Map にまとめて返す。
function collectDataIdElements(root: HTMLElement): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
    els.set(e.dataset['id']!, e);
  });
  return els;
}

// HUD のスタイル・レイヤ・各パネル・SVG オーバーレイを構築し、DOM 参照をまとめて返す。
export function buildHudDom(): HudDomRefs {
  injectThemeVariables();
  injectStyle();
  startViewportTracking();
  const root = createHudElement('div', 'hud', document.body);
  const layers = buildOverlayLayers(root);
  const svgOverlay = buildSvgOverlay(layers.marker);
  createHudElement('div', 'hud-rail-left', layers.panel, 'hud-rail hud-rail-left');
  const rightRail = createHudElement('div', 'hud-rail-right', layers.panel, 'hud-rail hud-rail-right');
  const leftRail = layers.panel.querySelector<HTMLElement>('#hud-rail-left')!;
  buildRailToggle(layers.panel, leftRail, 'left');
  buildRailToggle(layers.panel, rightRail, 'right');

  // 常設パネル群を組む。
  buildInfoPanels(layers.panel, leftRail, rightRail);
  buildGlobalStatus(layers.panel);
  buildChaseReset(layers.panel);
  const overlayShield = createHudElement('div', 'hud-overlay-shield', layers.gate);
  const overlayManager = new OverlayManager(overlayShield, layers.gate);

  createHudElement('div', 'hud-hint', layers.notify);
  createHudElement('div', 'hud-toast', layers.notify);

  const helpPanel = new HelpPanel(layers.system, overlayManager);

  createHudElement('div', 'hud-result', layers.system);

  const els = collectDataIdElements(root);
  return { root, layers, svgOverlay, overlayManager, helpPanel, els };
}
