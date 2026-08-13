// HUD の静的 DOM/スタイル構築。
import * as C from '../const';
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


const throttleKeyLabels = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax].map((k) => k.label).join(' / ');

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
export function hudDock(root: HTMLElement, side: 'left' | 'right'): HTMLElement {
  const id = `hud-dock-${side}`;
  return root.querySelector<HTMLElement>(`#${id}`) ?? root;
}

function dockToggleLabels(side: 'left' | 'right'): CollapseToggleLabels {
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
  const target = mapMode ? root.querySelector<HTMLElement>('#hud-dock-left') : root;
  if (navball && target && navball.parentElement !== target) target.appendChild(navball);
}

function buildDockToggle(root: HTMLElement, dock: HTMLElement, side: 'left' | 'right'): void {
  buildCollapseToggle(root, `hud-dock-toggle-${side}`, 'dock-toggle', dock, dockToggleLabels(side));
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
function buildInfoPanels(root: HTMLElement, targetDock: HTMLElement): void {
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

  const target = new PanelShell(targetDock, 'hud-target', 'TARGET');
  target.titleEl.dataset['id'] = 'tgtname';
  target.setHidden(true);
  target.body.innerHTML = `<div data-id="tgtbody"></div>`;

  const enemies = new PanelShell(shelf, 'hud-enemies', 'CONTACTS');
  enemies.titleEl.innerHTML = 'CONTACTS <span data-id="count"></span>';
  enemies.body.innerHTML = `<div data-id="elist"></div>`;

  // マップ視点の縮尺バー。描画自体は HudPanels.sync がカメラの注視点基準で更新する。
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

// 全操作の説明表([H]で開閉するヘルプパネル)の DOM を組む。開閉状態自体は HelpPanel が持つ。
function buildHelpPanel(root: HTMLElement): HTMLElement {
  const help = el('div', 'hud-help', root, 'panel');
  // キーと説明を1行ずつ対応させた表。
  help.innerHTML = `
    <h3>操作方法 [${K.help.label} で閉じる]</h3>
    <table>
      <tr><td class="key">
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-right:8px; vertical-align:middle;">
          <div>W</div><div>A S D</div>
        </div>
        /
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-left:8px; vertical-align:middle;">
          <div>↑</div><div>← ↓ →</div>
        </div>
      </td><td>並進 (前 / 後 / 左 / 右 / 上 / 下)<br><span style="font-size:var(--font-xs); color:var(--text-dim);">※ 上下は Q/E</span></td></tr>
      <tr><td class="key">
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; vertical-align:middle;">
          <div>I</div><div>J K L</div>
        </div>
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-left:8px; vertical-align:middle;">
          <div>U O</div>
        </div>
      </td><td>回転 (ピッチ / ヨー / ロール)</td></tr>
      <tr><td class="key">${K.rcsDampToggle.label}</td><td>RCS 回転制動 ON/OFF</td></tr>
      <tr><td class="key">${K.progradeReset.label}</td><td>プログレード姿勢リセット (機首を進行方向へ即座に向ける)</td></tr>
      <tr><td class="key">${throttleKeyLabels}</td><td>並進出力の切替 (${C.THROTTLE_LABELS.join(' / ')})。並進 6 方向に共通で適用される</td></tr>
      <tr><td class="key">${K.fineAttitudeToggle.label}</td><td>姿勢微調整モード ON/OFF (角加速度・角速度を絞って小刻みに操作)</td></tr>
      <tr><td class="key">${K.progradeHoldToggle.label}</td><td>進行方向ホールド ON/OFF (機首をプログレード方向へ自動で向け続ける。手動回転で解除)</td></tr>
      <tr><td class="key">${K.radiatorDeployLeft.label} / ${K.radiatorDeployRight.label}</td><td>ラジエーター展開/収納 (左 / 右)</td></tr>
      <tr><td class="key">${K.followAttitudeToggle.label}</td><td>視点のRCS追従 ON/OFF (既定 ON: 視点が機体姿勢を基準に回転し、RCS操作と一体的に動く。OFF で軌道基準の独立視点になる)</td></tr>
      <tr><td class="key">${K.gunsightZoom.label} (長押し)</td><td>照準ズーム (機首方向を画面中心に拡大表示、自機は非表示になる)</td></tr>
      <tr><td class="key">右クリック (敵)</td><td>敵をターゲット固定 / 解除 (固定中はターゲット名が画面右上に表示される)</td></tr>
      <tr><td class="key">${K.targetSelect.label}</td><td>照準に近い敵をターゲット選択 (短時間の連打で第二ターゲットを順送り)</td></tr>
      <tr><td class="key">▲AN / ▽DN マーカー</td><td>自機軌道とターゲット軌道面の交点。面変更(ノーマル/アンチノーマル)burn の目安位置</td></tr>
      <tr><td class="key">✦ マーカー</td><td>ターゲット位置に自機側を向けた仮想標的面を弾が通過した点。次弾の照準修正の目安</td></tr>
      <tr><td class="key">方向マーカー</td><td>軌道基準の6方向 (PRO/RET・NRM/ANM・OUT/IN) を示すマーカー。並進は機体基準なので、この6方向へ加速するには機首をマーカーへ向ける</td></tr>
      <tr><td class="key">${K.toggleMapMode.label}</td><td>軌道計画モード。地球中心ビューで数値積分した計画軌道(折れ線)をクリックしてノードを複数配置でき、再度 ${K.toggleMapMode.label} で確定(時間は進み続けるのでワープも可)</td></tr>
      <tr><td class="key">ノードのドラッグ</td><td>ノード上の丸ハンドルをドラッグすると、ポインタに最も近い軌道上の時刻へノードを移動する(小さな動きはドラッグでなくクリック=選択として扱う)</td></tr>
      <tr><td class="key">Δv 矢印ハンドル</td><td>選択中ノードの周囲に PRO/RET・NRM/ANM・OUT/IN の6ハンドルを表示。ドラッグした向きに応じて対応する Δv 成分を増減する(マップモード中のみ ${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label} キーでも同じ成分を調整可能、[${K.fineAttitudeToggle.label}] で微調整)</td></tr>
      <tr><td class="key">PREDICT パネル</td><td>マップモード下部。期間 = スライダーが指せる未来の長さ(1周回は現在の周期、双曲線等では1日にフォールバック)、スライダー = 期間内の任意の時刻へゴースト位置(⬡)を表示(0で非表示)</td></tr>
      <tr><td class="key">TRAJECTORY パネル</td><td>マップモード下部。軌道 = 計画軌道の折れ線を描く座標系</td></tr>
      <tr><td class="key">MAP VIEW パネル</td><td>マップモード左上。注視 = カメラの注視対象(それ以外の天体・ラグランジュ点はラベルを右クリック)、視点 = カメラを固定する座標系、視点リセット = 距離と向きを初期値へ戻す</td></tr>
      <tr><td class="key">慣性系/太陽回転系</td><td>計画軌道とカメラの座標系はそれぞれ独立に選べる。太陽回転系では太陽方向が画面上でほぼ固定される(遷移計画の目安)</td></tr>
      <tr><td class="key">${K.autoWarpToNode.label}</td><td>直近のマニューバノードへ時間を自動加速(実行点の直前で自動解除)</td></tr>
      <tr><td class="key">右クリック</td><td>マップモード中、ノード近傍で右クリックするとコンテキストメニュー(この時刻まで自動ワープ / ノードを削除 / キャンセル)を開く。ノードが無い位置での右クリックや、開いたメニュー外への右クリックは閉じるだけ</td></tr>
      <tr><td class="key">${K.deleteNode.label}</td><td>マップモード中は選択中のノードを削除(右クリックメニューのフォールバック)、戦闘ビューでは計画全体を破棄</td></tr>
      <tr><td class="key">◆/▶NODE / ⬢BURN</td><td>直近のマニューバ実行点(▶は選択中)と噴射ガイド。BURN の方向へ加速し、噴射後の計画軌道に十分近づくとそのノードを達成として次のノードへ進む</td></tr>
      <tr><td class="key">オレンジの軌道線</td><td>ターゲットの軌道(自機軌道とほぼ重なる場合は上に重ねて描画)</td></tr>
      <tr><td class="key">弾薬 / ▣ AMMO</td><td>${C.MAG_ROUNDS}発でマガジン1連を消費(右舷のベルトから自動給弾)。残弾が少なくなると付近の軌道に補給が投入されるので、▣ マーカーへ接近して回収</td></tr>
      <tr><td class="key">${K.reload.label}</td><td>マニュアル装填(残弾のあるマガジンを捨てて新しい1連を装填)。決着後は同じステージで再出撃</td></tr>
      <tr><td class="key">${K.fire.label} / 右クリック</td><td>機関砲発射 (ワープ×${C.MAX_PHYS_SIM_SPEED}以下)。撃ち始めは起動音とともに一瞬遅れて連射開始</td></tr>
      <tr><td class="key">${K.warpSlower.label} / ${K.warpFaster.label}</td><td>時間加速 減 / 増</td></tr>
      <tr><td class="key">左ドラッグ / ホイール</td><td>カメラ回転 / 距離ズーム</td></tr>
      <tr><td class="key">矢印キー (${K.cameraYawLeft.label}${K.cameraYawRight.label}${K.cameraPitchUp.label}${K.cameraPitchDown.label})</td><td>マウスの代わりにキーボードで視点回転</td></tr>
      <tr><td class="key">${K.pauseMenu.label}</td><td>一時停止メニュー (設定 / タイトルへ戻る)</td></tr>
    </table>`;
  return help;
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
  el('div', 'hud-dock-left', layers.panel, 'hud-dock hud-dock-left');
  const rightDock = el('div', 'hud-dock-right', layers.panel, 'hud-dock hud-dock-right');
  const leftDock = layers.panel.querySelector<HTMLElement>('#hud-dock-left')!;
  buildDockToggle(layers.panel, leftDock, 'left');
  buildDockToggle(layers.panel, rightDock, 'right');

  // 常設パネル群を組む。
  buildInfoPanels(layers.panel, rightDock);
  buildGlobalStatus(layers.panel);
  buildChaseReset(layers.panel);
  const overlayShield = el('div', 'hud-overlay-shield', layers.notify);
  const overlayManager = new OverlayManager(overlayShield, layers.notify);

  el('div', 'hud-hint', layers.notify);
  el('div', 'hud-toast', layers.notify);

  const helpEl = buildHelpPanel(layers.system);
  const helpPanel = new HelpPanel(helpEl, overlayManager);

  el('div', 'hud-end', layers.system);

  const els = collectDataIdElements(root);
  return { root, layers, svgOverlay, overlayManager, helpPanel, els };
}
