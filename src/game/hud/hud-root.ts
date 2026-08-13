// HUD の静的 DOM/スタイル構築。
import { KEY_MAPPING as K } from '../input/key-mapping';
import { injectThemeVariables } from '../theme';
import { buildOverlayLayers, type OverlayLayers } from './overlay-layer';
import { OverlayManager } from './overlay-manager';
import { HelpPanel } from './help-panel';
import { PanelShell } from './panel-shell';
import { LAYOUT_TOKENS_STYLE } from './layout-tokens';
import { SKELETON_STYLE } from './skeleton-style';
import { PANEL_CONTENT_STYLE } from './panel-content-style';
import { startViewportTracking } from './viewport';
import { buildCollapseToggle, WIDGET_STYLE, type CollapseToggleLabels } from './widgets';
export {
  buildCollapseToggle,
  type CollapseToggleLabels,
  COLLAPSE_EXPANDED_GLYPH,
  COLLAPSE_COLLAPSED_GLYPH,
  PREDICT_TOGGLE_LABELS,
} from './widgets';

// 置き場4種(層・レール・シェルフ / トークン / パネル個別 / ウィジェット共通)ごとに
// 分割したスタイルを結合する。定義順はレイヤ→骨格→パネル→ウィジェットで、
// カスケードの後勝ちを利用する箇所(同一セレクタの再定義)は各ファイル内で完結させてある。
const STYLE = LAYOUT_TOKENS_STYLE + SKELETON_STYLE + PANEL_CONTENT_STYLE;


// 指定タグ・id・class の要素を作り、parent に追加して返す。
function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

export interface HudDomRefs {
  root: HTMLElement;
  layers: OverlayLayers;
  svgOverlay: SVGSVGElement;
  overlayManager: OverlayManager;
  helpPanel: HelpPanel;
  els: Map<string, HTMLElement>;
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
    expandedTitle: `${label}マップパネルを閉じる`,
    collapsedTitle: `${label}マップパネルを開く`,
  };
}

export function syncNavballPlacement(root: HTMLElement, mapMode: boolean): void {
  const navball = root.querySelector<HTMLElement>('#navball');
  const target = mapMode ? root.querySelector<HTMLElement>('#hud-rail-left') : root;
  if (navball && target && navball.parentElement !== target) target.appendChild(navball);
}

function buildRailToggle(root: HTMLElement, rail: HTMLElement, side: 'left' | 'right'): void {
  buildCollapseToggle(root, `hud-rail-toggle-${side}`, 'rail-toggle', rail, railToggleLabels(side));
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
  svgOverlay.style.position = 'absolute';
  svgOverlay.style.inset = '0';
  svgOverlay.style.width = '100%';
  svgOverlay.style.height = '100%';
  svgOverlay.style.pointerEvents = 'none';
  svgOverlay.style.zIndex = '0';
  root.appendChild(svgOverlay);
  return svgOverlay;
}

// 常設の情報パネル(SHIP STATUS/ORBIT/TARGET/CONTACTS)を組む。戦闘シェルフの並びに
// 乗る3枚(STATUS/ORBIT/CONTACTS)と、右レールに乗る1枚(TARGET)。いずれも PanelShell
// に載せ、個別に折りたためるようにする。
function buildInfoPanels(root: HTMLElement, targetRail: HTMLElement): void {
  const shelf = el('div', 'hud-combat-shelf', root);

  const status = new PanelShell(shelf, 'hud-status', 'SHIP STATUS');
  status.body.innerHTML = `
    <div class="row"><span class="k">RCS制動 [${K.rcsDampToggle.label}]</span><span class="v" data-id="rcs"></span></div>
    <div class="row"><span class="k">並進出力 [${K.throttleLow.label}-${K.throttleMax.label}]</span><span class="v" data-id="throttle"></span></div>
    <div class="row"><span class="k">微調整 [${K.fineAttitudeToggle.label}]</span><span class="v" data-id="fine"></span></div>
    <div class="row"><span class="k">進行方向ホールド [${K.progradeHoldToggle.label}]</span><span class="v" data-id="prohold"></span></div>
    <div class="row"><span class="k">視点のRCS追従 [${K.followAttitudeToggle.label}]</span><span class="v" data-id="camfollow"></span></div>
    <div class="row"><span class="k">弾薬 AMMO</span><span class="v" data-id="ammo"></span></div>`;

  const orbit = new PanelShell(shelf, 'hud-orbit', 'ORBIT');
  orbit.body.innerHTML = `
    <div class="row"><span class="k">基準天体</span><span class="v" data-id="center"></span></div>
    <div class="row"><span class="k">高度 ALT</span><span class="v" data-id="alt"></span></div>
    <div class="row"><span class="k">速度 VEL</span><span class="v" data-id="spd"></span></div>
    <div class="row"><span class="k">遠地点 AP</span><span class="v" data-id="ap"></span></div>
    <div class="row"><span class="k">近地点 PE</span><span class="v" data-id="pe"></span></div>
    <div class="row"><span class="k">傾斜角 INC</span><span class="v" data-id="inc"></span></div>
    <div class="row"><span class="k">周期 PRD</span><span class="v" data-id="prd"></span></div>
    <div class="row"><span class="k">動圧 Q</span><span class="v" data-id="qdyn"></span></div>
    <div class="row"><span class="k">機体温度</span><span class="v" data-id="temp"></span></div>`;

  const target = new PanelShell(targetRail, 'hud-target', 'TARGET');
  target.titleEl.dataset['id'] = 'tgtname';
  target.setHidden(true);
  target.body.innerHTML = `<div data-id="tgtbody"></div>`;

  const enemies = new PanelShell(shelf, 'hud-enemies', 'CONTACTS');
  enemies.titleEl.innerHTML = 'CONTACTS <span data-id="count"></span>';
  enemies.body.innerHTML = `<div data-id="elist"></div>`;

  // マップ視点の縮尺バー。描画自体は MapScaleBadge.sync がカメラの注視点基準で更新する。
  const mapScale = el('div', 'hud-map-scale', root);
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
  const bar = el('div', 'hud-globalstatus', root);
  bar.innerHTML = `
    <span class="v" data-id="met"></span>
    <span class="gs-sep">|</span>
    <span class="k">時間加速</span><span class="v" data-id="sim-speed"></span>
    <span class="gs-sep">|</span>
    <span class="k">NODE WARP</span><span class="v" data-id="node-warp-remain">—</span>`;
}

// 追従カメラの視点リセットボタンを組む。
function buildChaseReset(root: HTMLElement): void {
  const chaseReset = el('div', 'hud-chase-reset', root);
  chaseReset.dataset.id = 'chase-reset';
  chaseReset.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>`;
}

// data-id 属性を持つ要素を、その id をキーにした Map にまとめて返す。
function collectDataIdElements(root: HTMLElement): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
    els.set(e.dataset['id']!, e);
  });
  return els;
}

// HUD のスタイル・レイヤ・各パネル・SVG オーバーレイを一括構築し、DOM 参照をまとめて返す。
export function buildHudDom(): HudDomRefs {
  injectThemeVariables();
  injectStyle();
  startViewportTracking();
  const root = el('div', 'hud', document.body);
  const layers = buildOverlayLayers(root);
  const svgOverlay = buildSvgOverlay(layers.marker);
  el('div', 'hud-rail-left', layers.panel, 'hud-rail hud-rail-left');
  const rightRail = el('div', 'hud-rail-right', layers.panel, 'hud-rail hud-rail-right');
  const leftRail = layers.panel.querySelector<HTMLElement>('#hud-rail-left')!;
  buildRailToggle(layers.panel, leftRail, 'left');
  buildRailToggle(layers.panel, rightRail, 'right');

  // 常設パネル群を組む。
  buildInfoPanels(layers.panel, rightRail);
  buildGlobalStatus(layers.panel);
  buildChaseReset(layers.panel);
  const overlayShield = el('div', 'hud-overlay-shield', layers.notify);
  const overlayManager = new OverlayManager(overlayShield, layers.notify);

  el('div', 'hud-hint', layers.notify);
  el('div', 'hud-toast', layers.notify);

  const helpPanel = new HelpPanel(layers.system, overlayManager);

  el('div', 'hud-result', layers.system);

  const els = collectDataIdElements(root);
  return { root, layers, svgOverlay, overlayManager, helpPanel, els };
}
