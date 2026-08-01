// HUD の静的 DOM/スタイル構築。
import * as C from '../const';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, SURFACE, EDGE, TEXT as INK, TEXT_DIM as INK_SOFT, FONT } from '../theme';


const throttleLabels = [K.throttleLow, K.throttleMid, K.throttleHigh].map((k) => k.label).join(' / ');

const STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: ${FONT};
  color: ${INK}; user-select: none; z-index: 10;
  font-size: 13px;
}
/* --- 重なり順: マーカーは実行時に DOM 末尾へ追加されるため z-index を明示しないとパネルの上に出る。
     0=マーカー  1=常設パネル  2=トースト・ヒント  3=終了画面・ヘルプ  4=ESC メニュー */
#hud .mk { z-index: 0; }
#hud-status, #hud-orbit, #hud-target, #hud-enemies, #hud-controls,
#hud-plan, #hud-displaytime, #hud-trajframe, #hud-overview-camera, #hud-stagestatus, #hud-gear { z-index: 1; }
#hud-toast, #hud-hint { z-index: 2; }
#hud-end, #hud-help { z-index: 3; }
#hud-settings { z-index: 4; }
#hud .panel {
  position: absolute; background: ${SURFACE};
  border: 1px solid ${EDGE}; border-radius: 4px;
  padding: 10px 14px; line-height: 1.55; backdrop-filter: blur(4px);
}
#hud .panel h3 {
  font-size: 11px; letter-spacing: 2.5px; color: ${ACCENT};
  border-bottom: 1px solid rgba(${ACCENT_RGB}, 0.25); margin-bottom: 6px; padding-bottom: 4px;
  font-weight: 600;
}
#hud .row { display: flex; justify-content: space-between; gap: 12px; }
#hud .row .k { color: ${INK_SOFT}; }
#hud .row .v { color: ${INK}; min-width: 90px; text-align: right; }
#hud-status { bottom: 12px; left: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-status h3 { font-size: 8.8px; }
#hud-orbit { bottom: 12px; left: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-orbit h3 { font-size: 8.8px; }
#hud-status .v, #hud-orbit .v { min-width: 75px; }
#hud-target { bottom: 12px; right: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-target h3 { font-size: 8.8px; }
#hud-enemies { bottom: 12px; right: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-enemies h3 { font-size: 8.8px; }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: 8px; color: ${INK_SOFT}; }
#hud-enemies .erow.tgt { color: ${ACCENT}; }

#hud-hint {
  position: absolute; bottom: 200px; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid rgba(${ACCENT_RGB}, 0.35); border-radius: 4px;
  padding: 8px 18px;
  color: ${ACCENT_SOFT}; font-size: 14px;
  transition: opacity 0.4s; opacity: 0; text-align: center;
}
#hud-chase-reset {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 1px solid ${EDGE}; background: ${SURFACE}; color: ${INK_SOFT};
  z-index: 1;
}
#hud-chase-reset:hover { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 14px 26px;
  color: ${INK}; font-size: 15px; text-align: center;
  transition: opacity 1s; opacity: 0; line-height: 1.8;
}
#hud .sim-speed-hot { color: ${ACCENT}; }
#hud .mode-tgt { color: ${ACCENT}; }
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px #000, 0 0 2px #000;
  width: 24px; height: 24px;
}
.mk .sym { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; line-height: 1; }
.mk .lbl { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); font-size: 10px; margin-top: 2px; letter-spacing: 1px; }
.mk-boresight { color: ${C.COLOR_MARKER_BORESIGHT}; font-size: 18px; }
.mk-target { color: ${ACCENT}; }
.mk-enemy { color: rgba(230, 232, 235, 0.35); }
.mk-lead { color: ${ACCENT}; }
.mk-pro { color: ${C.COLOR_MARKER_PROGRADE}; }
.mk-retro { color: ${C.COLOR_MARKER_PROGRADE}; }
.mk-nrm { color: ${C.COLOR_MARKER_NORMAL}; }
.mk-rad { color: ${C.COLOR_MARKER_RADIAL}; }
.mk-tgtdir { color: ${C.COLOR_MARKER_TGTDIR}; }
.mk-node { color: ${C.COLOR_MARKER_NODE}; }
.mk-boardhit { color: ${C.COLOR_MARKER_BOARDHIT}; text-shadow: 0 0 5px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.45); }
.mk-boardhit .sym { font-size: 8px; }
.mk-mnode { color: ${ACCENT_SOFT}; }
.mk-burn { color: ${ACCENT}; text-shadow: 0 0 8px rgba(${ACCENT_RGB}, 0.7); }
.mk-self { color: ${C.COLOR_MARKER_SELF}; }
.mk-ammo { color: ${ACCENT_SOFT}; text-shadow: 0 0 6px rgba(255,144,64,0.6), 0 0 3px #000; }
#hud .warn-hot { color: ${ACCENT}; }
#hud-plan {
  position: absolute; top: 12px; right: 12px; left: auto; bottom: auto; min-width: 90px; width: 33vw; max-width: 300px;
}
#hud .hud-seg { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
#hud .hud-seg .seg-title { font-size: 10px; letter-spacing: 1px; color: ${INK_SOFT}; min-width: 28px; }
#hud .hud-seg .seg-btn {
  pointer-events: auto; cursor: pointer; padding: 3px 10px; font-size: 11px;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK_SOFT};
}
#hud .hud-seg .seg-btn.on { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-overview-camera { display: none; top: 12px; left: 12px; width: 292px; pointer-events: auto; }
#hud-displaytime { display: none; top: 166px; left: 12px; width: 292px; pointer-events: auto; }
#hud-displaytime input[type="range"] { width: 100%; pointer-events: auto; accent-color: ${ACCENT}; }
#hud-displaytime .slider-label { font-size: 11px; color: ${INK_SOFT}; margin-top: 4px; text-align: center; }
#hud-trajframe { display: none; top: 296px; left: 12px; width: 292px; pointer-events: auto; }
.mk-planned { color: ${C.COLOR_MARKER_PLANNED}; text-shadow: 0 0 6px rgba(143,208,255,0.6), 0 0 3px #000; }
.mk-poi { color: #ffffff; text-shadow: 0 0 4px #000; }
.mk-poi .sym { font-size: 5px; }
.mk-poi .lbl { font-size: 11px; margin-top: 4px; padding: 2px 4px; border-radius: 2px; background: rgba(13,15,18,0.6); border: 1px solid rgba(255,255,255,0.2); }
#hud-end {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(6, 7, 9, 0.82); backdrop-filter: blur(3px);
  flex-direction: column; text-align: center;
}
#hud-end h1 { font-size: 34px; letter-spacing: 6px; margin-bottom: 18px; }
#hud-end.win h1 { color: ${INK}; text-shadow: 0 0 18px rgba(230,232,235,0.35); }
#hud-end.lose h1 { color: ${ACCENT}; text-shadow: 0 0 18px rgba(${ACCENT_RGB}, 0.4); }
#hud-end .detail {
  font-size: 15px; line-height: 2; color: ${INK};
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 18px 30px;
}
#hud-end .restart { margin-top: 22px; color: ${ACCENT_SOFT}; font-size: 13px; }
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; min-width: 480px; max-height: 86vh; overflow-y: auto; pointer-events: auto;
}
#hud-help table { border-collapse: collapse; width: 100%; }
#hud-help td { padding: 3px 10px; color: ${INK}; }
#hud-help td.key { color: ${ACCENT_SOFT}; text-align: right; white-space: nowrap; }

#hud-stagestatus {
  top: 12px; left: 50%; transform: translateX(-50%);
  text-align: center; min-width: 280px; padding: 8px 16px;
}
#hud-stagestatus .t { font-size: 11px; letter-spacing: 2px; color: ${INK}; font-variant-numeric: tabular-nums; }
#hud-stagestatus .t.warn { color: ${ACCENT}; }
#hud-stagestatus .k { font-size: 11px; color: ${INK_SOFT}; margin-top: 2px; }
#hud-settings {
  position: absolute; bottom: 40px; top: auto; left: 50%; transform: translateX(-50%);
  display: none; min-width: 260px; pointer-events: auto;
}
#hud-settings .srow {
  display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 6px 0;
}
#hud-settings .stoggle {
  pointer-events: auto; cursor: pointer; padding: 4px 16px; min-width: 46px; text-align: center;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK_SOFT};
}
#hud-settings .stoggle.on { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-settings .squit {
  margin-top: 14px; text-align: center; padding: 8px 10px; cursor: pointer;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK_SOFT}; font-size: 12px;
}
#hud-settings .squit:hover { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-settings .sclose {
  margin-top: 10px; text-align: center; color: ${INK_SOFT}; font-size: 11px; cursor: pointer;
}

/* --- モバイル / 狭幅画面: パネルを縮小してタッチパッドと共存させる --- */
@media (max-width: 900px), (pointer: coarse) {
  #hud { font-size: 11px; }
  #hud .panel { padding: 6px 8px; line-height: 1.4; }
  #hud .panel h3 { font-size: 10px; letter-spacing: 1.5px; margin-bottom: 4px; }
  #hud .row { gap: 8px; }
  #hud .row .v { min-width: 64px; }
  #hud-status { top: 8px; left: 8px; min-width: 178px; }
  #hud-orbit { top: 184px; left: 8px; min-width: 178px; }
  #hud-target { top: 8px; right: 8px; min-width: 182px; }
  #hud-enemies { top: 286px; right: 8px; min-width: 182px; }
  #hud-controls { display: none; }
  #hud-hint { bottom: auto; top: 26%; max-width: 92vw; white-space: normal; }
  #hud-toast { max-width: 92vw; padding: 10px 14px; font-size: 13px; }
  #hud-plan { top: 8px; right: 8px; left: auto; bottom: auto; min-width: 210px; max-width: 60vw; }
  #hud-overview-camera { top: 8px; left: 8px; width: 186px; }
  #hud-displaytime { top: 146px; left: 8px; width: 186px; }
  #hud-trajframe { top: 246px; left: 8px; width: 186px; }
  #hud-help { min-width: 0; width: 94vw; max-height: 78vh; }
  #hud-end h1 { font-size: 24px; letter-spacing: 3px; }
  #hud-end .detail { font-size: 13px; padding: 12px 18px; max-width: 92vw; }
  #navball { width: 100px !important; height: 100px !important; bottom: 130px !important; }
  #hud-settings { min-width: 0; width: 78vw; }
  #hud-stagestatus { top: 8px; min-width: 130px; padding: 6px 10px; }
  #hud-stagestatus .t { font-size: 14px; }
  #hud-chase-reset { bottom: 12px; width: 28px; height: 28px; }
  #hud-chase-reset svg { width: 14px; height: 14px; }
}
`;

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
  svgOverlay: SVGSVGElement;
  els: Map<string, HTMLElement>;
}

// STYLE の CSS を <head> に注入する。
function injectStyle(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
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

// 常設の情報パネル(SHIP STATUS/ORBIT/TARGET/CONTACTS)を組む。
function buildInfoPanels(root: HTMLElement): void {

  // SHIP STATUS パネル
  const status = el('div', 'hud-status', root, 'panel');
  status.innerHTML = `
    <h3>SHIP STATUS</h3>
    <div class="row"><span class="k">MET</span><span class="v" data-id="met"></span></div>
    <div class="row"><span class="k">時間加速</span><span class="v" data-id="sim-speed"></span></div>

    <div class="row"><span class="k">RCS制動 [${K.rcsDampToggle.label}]</span><span class="v" data-id="rcs"></span></div>
    <div class="row"><span class="k">並進出力 [${K.throttleLow.label}-${K.throttleHigh.label}]</span><span class="v" data-id="throttle"></span></div>
    <div class="row"><span class="k">微調整 [${K.fineAttitudeToggle.label}]</span><span class="v" data-id="fine"></span></div>
    <div class="row"><span class="k">進行方向ホールド [${K.progradeHoldToggle.label}]</span><span class="v" data-id="prohold"></span></div>
    <div class="row"><span class="k">視点のRCS追従 [${K.followAttitudeToggle.label}]</span><span class="v" data-id="camfollow"></span></div>
    <div class="row"><span class="k">弾薬 AMMO</span><span class="v" data-id="ammo"></span></div>`;

  // ORBIT パネル
  const orbit = el('div', 'hud-orbit', root, 'panel');
  orbit.innerHTML = `
    <h3>ORBIT</h3>
    <div class="row"><span class="k">高度 ALT</span><span class="v" data-id="alt"></span></div>
    <div class="row"><span class="k">速度 VEL</span><span class="v" data-id="spd"></span></div>
    <div class="row"><span class="k">遠地点 AP</span><span class="v" data-id="ap"></span></div>
    <div class="row"><span class="k">近地点 PE</span><span class="v" data-id="pe"></span></div>
    <div class="row"><span class="k">傾斜角 INC</span><span class="v" data-id="inc"></span></div>
    <div class="row"><span class="k">周期 PRD</span><span class="v" data-id="prd"></span></div>
    <div class="row"><span class="k">動圧 Q</span><span class="v" data-id="qdyn"></span></div>
    <div class="row"><span class="k">機体温度</span><span class="v" data-id="temp"></span></div>`;

  // TARGET パネル
  const target = el('div', 'hud-target', root, 'panel');
  target.innerHTML = `
    <h3 data-id="tgtname">TARGET</h3>
    <div data-id="tgtbody"></div>`;

  // CONTACTS パネル
  const enemies = el('div', 'hud-enemies', root, 'panel');
  enemies.innerHTML = `
    <h3>CONTACTS <span data-id="count"></span></h3>
    <div data-id="elist"></div>`;
}

// 視点リセットボタン（以前は controlsBar と一緒だったが、単独で追加）
function buildChaseReset(root: HTMLElement): void {
  const chaseReset = el('div', 'hud-chase-reset', root);
  chaseReset.dataset.id = 'chase-reset';
  chaseReset.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>`;
}

// 全操作の説明表([H]で開閉するヘルプパネル)を組む。
function buildHelpPanel(root: HTMLElement): void {
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
      </td><td>並進 (前 / 後 / 左 / 右 / 上 / 下)<br><span style="font-size:10px; color:${INK_SOFT};">※ 上下は Q/E</span></td></tr>
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
      <tr><td class="key">${throttleLabels}</td><td>並進出力の切替 (弱 / 中 / 強)。並進 6 方向に共通で適用される</td></tr>
      <tr><td class="key">${K.fineAttitudeToggle.label}</td><td>姿勢微調整モード ON/OFF (角加速度・角速度を絞って小刻みに操作)</td></tr>
      <tr><td class="key">${K.progradeHoldToggle.label}</td><td>進行方向ホールド ON/OFF (機首をプログレード方向へ自動で向け続ける。手動回転で解除)</td></tr>
      <tr><td class="key">${K.followAttitudeToggle.label}</td><td>視点のRCS追従 ON/OFF (既定 ON: 視点が機体姿勢を基準に回転し、RCS操作と一体的に動く。OFF で軌道基準の独立視点になる)</td></tr>
      <tr><td class="key">${K.gunsightZoom.label} (長押し)</td><td>照準ズーム (機首方向を画面中心に拡大表示、自機は非表示になる)</td></tr>
      <tr><td class="key">右クリック (敵)</td><td>敵をターゲット固定 / 解除 (固定中はターゲット名が画面右上に表示される)</td></tr>
      <tr><td class="key">▲AN / ▽DN マーカー</td><td>自機軌道とターゲット軌道面の交点。面変更(ノーマル/アンチノーマル)burn の目安位置</td></tr>
      <tr><td class="key">✦ マーカー</td><td>ターゲット位置に自機側を向けた仮想標的面を弾が通過した点。次弾の照準修正の目安</td></tr>
      <tr><td class="key">方向マーカー</td><td>軌道基準の6方向 (PRO/RET・NRM/ANM・OUT/IN) を示すマーカー。並進は機体基準なので、この6方向へ加速するには機首をマーカーへ向ける</td></tr>
      <tr><td class="key">${K.toggleMapMode.label}</td><td>軌道計画モード。地球中心ビューで数値予測した軌道(折れ線)をクリックしてノードを複数配置でき、再度 ${K.toggleMapMode.label} で確定(時間は進み続けるのでワープも可)</td></tr>
      <tr><td class="key">ノードのドラッグ</td><td>ノード上の丸ハンドルをドラッグすると、ポインタに最も近い軌道上の時刻へノードを移動する(小さな動きはドラッグでなくクリック=選択として扱う)</td></tr>
      <tr><td class="key">Δv 矢印ハンドル</td><td>選択中ノードの周囲に PRO/RET・NRM/ANM・OUT/IN の6ハンドルを表示。ドラッグした向きに応じて対応する Δv 成分を増減する(マップモード中のみ ${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label} キーでも同じ成分を調整可能、[${K.fineAttitudeToggle.label}] で微調整)</td></tr>
      <tr><td class="key">PREDICT パネル</td><td>マップモード下部。期間 = 予測を描く長さ(1周回は現在の周期、双曲線等では1日にフォールバック)、軌道 = 予測軌道を描く座標系、スライダー = 期間内の任意の時刻へゴースト位置(⬡)を表示(0で非表示)</td></tr>
      <tr><td class="key">MAP VIEW パネル</td><td>マップモード左上。注視 = カメラの注視対象(それ以外の天体・ラグランジュ点はラベルを右クリック)、視点 = カメラを固定する座標系、視点リセット = 距離と向きを初期値へ戻す</td></tr>
      <tr><td class="key">慣性系/太陽回転系</td><td>予測軌道とカメラの座標系はそれぞれ独立に選べる。太陽回転系では太陽方向が画面上でほぼ固定される(遷移計画の目安)</td></tr>
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
}

// data-id 属性を持つ要素を、その id をキーにした Map にまとめて返す。
function collectDataIdElements(root: HTMLElement): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
    els.set(e.dataset['id']!, e);
  });
  return els;
}

// HUD のスタイル・各パネル・SVG オーバーレイを一括構築し、DOM 参照をまとめて返す。
export function buildHudDom(): HudDomRefs {
  injectStyle();
  const root = el('div', 'hud', document.body);
  const svgOverlay = buildSvgOverlay(root);

  // 常設パネル群を組む。
  buildInfoPanels(root);
  buildChaseReset(root);

  el('div', 'hud-hint', root);
  el('div', 'hud-toast', root);

  buildHelpPanel(root);

  el('div', 'hud-end', root);

  const els = collectDataIdElements(root);
  return { root, svgOverlay, els };
}
