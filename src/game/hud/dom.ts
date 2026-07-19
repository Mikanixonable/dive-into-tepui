// HUD の静的 DOM 構築(旧 Hud constructor 内の innerHTML/スタイル組み立て部分)。
// 副作用(document への要素追加・スタイル注入)は残るが、状態は持たない。
// イベントリスナーが参照するコールバックは HudDomHost 経由で呼び出し時に解決するため、
// (呼び出し元の) Hud インスタンスをそのまま渡せる。
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, SURFACE, EDGE, TEXT as INK, TEXT_DIM as INK_SOFT } from '../theme';

// デザイン方針: ダークテーマ。ニューモーフィズムは廃止し、モノトーン
// (ほぼ無彩色のグレースケール)+ 彩度の高いオレンジ 1 色をアクセントに使う
// フラットなパネルにする。スクリーン投影マーカーもモノトーンに揃え、
// 「注目すべきもの」(ターゲット・リード・マニューバ・補給)だけをオレンジで示す。

const STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: 'Consolas', 'Courier New', monospace;
  color: ${INK}; user-select: none; z-index: 10;
  font-size: 13px;
}
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
#hud-status { bottom: 44px; left: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-status h3 { font-size: 8.8px; }
#hud-orbit { bottom: 44px; left: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-orbit h3 { font-size: 8.8px; }
#hud-status .v, #hud-orbit .v { min-width: 75px; }
#hud-target { bottom: 44px; right: 252px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-target h3 { font-size: 8.8px; }
#hud-enemies { bottom: 44px; right: 12px; width: 228px; box-sizing: border-box; font-size: 10.4px; }
#hud-enemies h3 { font-size: 8.8px; }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: 8px; color: ${INK_SOFT}; }
#hud-enemies .erow.tgt { color: ${ACCENT}; }
#hud-controls {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 6px 18px;
  color: ${INK_SOFT}; font-size: 11px; text-align: center; white-space: nowrap;
}
#hud-hint {
  position: absolute; bottom: 200px; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid rgba(${ACCENT_RGB}, 0.35); border-radius: 4px;
  padding: 8px 18px;
  color: ${ACCENT_SOFT}; font-size: 14px;
  transition: opacity 0.4s; opacity: 0; text-align: center;
}
#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 14px 26px;
  color: ${INK}; font-size: 15px; text-align: center;
  transition: opacity 1s; opacity: 0; line-height: 1.8;
}
#hud .warp-hot { color: ${ACCENT}; }
#hud .mode-tgt { color: ${ACCENT}; }
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px #000, 0 0 2px #000;
  width: 24px; height: 24px;
}
.mk .sym { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; line-height: 1; }
.mk .lbl { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); font-size: 10px; margin-top: 2px; letter-spacing: 1px; }
.mk-boresight { color: #dfe3e8; font-size: 18px; }
.mk-target { color: ${ACCENT}; }
.mk-enemy { color: rgba(230, 232, 235, 0.35); }
.mk-lead { color: ${ACCENT}; }
.mk-pro { color: #cfd6dd; }
.mk-retro { color: #cfd6dd; }
.mk-nrm { color: #d08cff; }
.mk-rad { color: #7de8ff; }
.mk-tgtdir { color: #ff7ab0; }
.mk-node { color: #8b93a0; }
.mk-boardhit { color: #ffffff; text-shadow: 0 0 5px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.45); }
.mk-boardhit .sym { font-size: 8px; }
.mk-mnode { color: ${ACCENT_SOFT}; }
.mk-burn { color: ${ACCENT}; text-shadow: 0 0 8px rgba(${ACCENT_RGB}, 0.7); }
.mk-self { color: #dfe3e8; }
.mk-ammo { color: ${ACCENT_SOFT}; text-shadow: 0 0 6px rgba(255,144,64,0.6), 0 0 3px #000; }
#hud .warn-hot { color: ${ACCENT}; }
#hud-plan {
  position: absolute; bottom: 40px; left: 12px; min-width: 280px;
}
#hud-maptool {
  display: none; position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%);
  min-width: 320px; pointer-events: auto; text-align: center;
}
#hud-maptool .mt-row { display: flex; justify-content: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
#hud-maptool .mt-btn {
  pointer-events: auto; cursor: pointer; padding: 4px 12px; font-size: 11px;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE}; color: ${INK_SOFT};
}
#hud-maptool .mt-btn.on { border-color: ${ACCENT}; color: ${ACCENT}; }
#hud-maptool input[type="range"] { width: 100%; pointer-events: auto; accent-color: ${ACCENT}; }
#hud-maptool .mt-sliderlabel { font-size: 11px; color: ${INK_SOFT}; margin-top: 4px; }
.mk-ghost { color: #8fd0ff; text-shadow: 0 0 6px rgba(143,208,255,0.6), 0 0 3px #000; }
.mk-poi { color: #8fd0ff; text-shadow: 0 0 4px #000; }
.mk-poi .sym { font-size: 14px; }
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
#hud-gear {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  width: 30px; height: 30px; border-radius: 50%; pointer-events: auto; cursor: pointer;
  background: ${SURFACE}; border: 1px solid ${EDGE};
  display: flex; align-items: center; justify-content: center; font-size: 15px; color: ${INK_SOFT};
}
#hud-stage0 {
  position: absolute; top: 50px; left: 50%; transform: translateX(-50%);
  display: none; text-align: center; min-width: 170px; padding: 8px 16px;
}
#hud-stage0 .t { font-size: 22px; letter-spacing: 2px; color: ${INK}; font-variant-numeric: tabular-nums; }
#hud-stage0 .t.warn { color: ${ACCENT}; }
#hud-stage0 .k { font-size: 11px; color: ${INK_SOFT}; margin-top: 2px; }
#hud-settings {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
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
  #hud-plan { bottom: 216px; left: 8px; min-width: 210px; max-width: 60vw; }
  #hud-help { min-width: 0; width: 94vw; max-height: 78vh; }
  #hud-end h1 { font-size: 24px; letter-spacing: 3px; }
  #hud-end .detail { font-size: 13px; padding: 12px 18px; max-width: 92vw; }
  #navball { width: 100px !important; height: 100px !important; bottom: 130px !important; }
  #hud-gear { top: 8px; width: 26px; height: 26px; font-size: 13px; }
  #hud-settings { min-width: 0; width: 78vw; }
  #hud-stage0 { top: 42px; min-width: 130px; padding: 6px 10px; }
  #hud-stage0 .t { font-size: 17px; }
}
`;

function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

// DOM 構築が発火するイベントが呼び出し時に参照するコールバック/メソッド群。
// 呼び出し元の Hud インスタンスをそのまま渡せば、代入順序に関わらず
// クリック時点の最新のコールバックが呼ばれる(元の constructor 内 this 参照と同じ挙動)。
export interface HudDomHost {
  getBgmOn(): boolean;
  onBgmToggle: ((on: boolean) => void) | null;
  onSettingsOpenChange: ((open: boolean) => void) | null;
  onQuitToTitle: (() => void) | null;
  onDurationSelect: ((key: string) => void) | null;
  onFrameToggle: (() => void) | null;
  onMapFocusSelect: ((focus: string) => void) | null;
  onMapViewReset: (() => void) | null;
  onSliderChange: ((t: number) => void) | null;
  toggleSettings(force?: boolean): void;
  setBgmState(on: boolean): void;
}

export interface HudDomRefs {
  root: HTMLElement;
  svgOverlay: SVGSVGElement;
  els: Map<string, HTMLElement>;
}

// 旧 Hud constructor 本体だった静的 DOM/スタイル構築。document.body に直接要素を追加する。
export function buildHudDom(host: HudDomHost): HudDomRefs {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = el('div', 'hud', document.body);

  const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgOverlay.style.position = 'absolute';
  svgOverlay.style.inset = '0';
  svgOverlay.style.width = '100%';
  svgOverlay.style.height = '100%';
  svgOverlay.style.pointerEvents = 'none';
  svgOverlay.style.zIndex = '-1';
  root.appendChild(svgOverlay);

  const status = el('div', 'hud-status', root, 'panel');
  status.innerHTML = `
    <h3>SHIP STATUS</h3>
    <div class="row"><span class="k">MET</span><span class="v" data-id="met"></span></div>
    <div class="row"><span class="k">TIME WARP</span><span class="v" data-id="warp"></span></div>

    <div class="row"><span class="k">RCS制動 [T]</span><span class="v" data-id="rcs"></span></div>
    <div class="row"><span class="k">並進出力 [1-3]</span><span class="v" data-id="throttle"></span></div>
    <div class="row"><span class="k">微調整 [V]</span><span class="v" data-id="fine"></span></div>
    <div class="row"><span class="k">進行方向ホールド [C]</span><span class="v" data-id="prohold"></span></div>
    <div class="row"><span class="k">視点のRCS追従 [G]</span><span class="v" data-id="camfollow"></span></div>
    <div class="row"><span class="k">弾薬 AMMO</span><span class="v" data-id="ammo"></span></div>`;

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

  const target = el('div', 'hud-target', root, 'panel');
  target.innerHTML = `
    <h3 data-id="tgtname">TARGET</h3>
    <div data-id="tgtbody"></div>`;

  const enemies = el('div', 'hud-enemies', root, 'panel');
  enemies.innerHTML = `
    <h3>CONTACTS <span data-id="count"></span></h3>
    <div data-id="elist"></div>`;

  const controls = el('div', 'hud-controls', root);
  controls.innerHTML =
    'W/S(またはCTRL/SHIFT):前後 &nbsp;Q/E:上下 &nbsp;A/D:左右 &nbsp;I/K/J/L/U/O:回転 &nbsp;1/2/3:並進出力 &nbsp;T:RCS制動 &nbsp;F:プログレードリセット &nbsp;C:進行方向ホールド &nbsp;G:視点のRCS追従 &nbsp;M:軌道計画 &nbsp;N:ノードへワープ &nbsp;Z:ズーム &nbsp;' +
    'Space/右クリック:射撃 &nbsp;左ドラッグ/矢印キー:視点 &nbsp;中ドラッグ:マップ平行移動 &nbsp;,/.:ワープ &nbsp;[H]:ヘルプ';

  const plan = el('div', 'hud-plan', root, 'panel');
  plan.innerHTML = `<h3>MANEUVER PLAN [M]</h3><div data-id="planbody"></div>`;
  plan.style.display = 'none';

  const mapTool = el('div', 'hud-maptool', root, 'panel');
  mapTool.innerHTML = `
    <div class="mt-row" data-id="mt-duration">
      <span class="mt-btn" data-dur="orbit">1周回</span>
      <span class="mt-btn" data-dur="day">1日</span>
      <span class="mt-btn" data-dur="week">7日</span>
      <span class="mt-btn" data-dur="month">28日</span>
      <span class="mt-btn" data-id="mt-frame">慣性系</span>
    </div>
    <div class="mt-row" data-id="mt-focus">
      <span class="mt-btn" data-focus="earth">地球中心</span>
      <span class="mt-btn" data-focus="moon">月中心</span>
      <span class="mt-btn" data-id="mt-reset">視点リセット</span>
    </div>
    <input type="range" data-id="mt-slider" min="0" max="1000" value="0" />
    <div class="mt-sliderlabel" data-id="mt-sliderlabel">スライダーで未来位置を確認</div>`;
  mapTool.querySelectorAll<HTMLElement>('.mt-btn[data-dur]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (host.onDurationSelect) host.onDurationSelect(btn.dataset['dur']!);
    });
  });
  const frameBtn = mapTool.querySelector<HTMLElement>('[data-id="mt-frame"]')!;
  frameBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  frameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (host.onFrameToggle) host.onFrameToggle();
  });
  mapTool.querySelectorAll<HTMLElement>('.mt-btn[data-focus]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const focus = btn.dataset['focus'];
      if (focus) host.onMapFocusSelect?.(focus);
    });
  });
  const resetBtn = mapTool.querySelector<HTMLElement>('[data-id="mt-reset"]')!;
  resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    host.onMapViewReset?.();
  });
  const slider = mapTool.querySelector<HTMLInputElement>('[data-id="mt-slider"]')!;
  slider.addEventListener('pointerdown', (e) => e.stopPropagation());
  slider.addEventListener('input', () => {
    if (host.onSliderChange) host.onSliderChange(Number(slider.value) / 1000);
  });

  const stage0 = el('div', 'hud-stage0', root, 'panel');
  stage0.innerHTML = `<div class="t" data-id="stage0hp"></div><div class="k"><span data-id="stage0phase"></span><br>撃墜 <span data-id="stage0kills"></span></div>`;

  const gear = el('div', 'hud-gear', root);
  gear.textContent = '⚙';
  gear.addEventListener('click', () => host.toggleSettings());

  const settings = el('div', 'hud-settings', root, 'panel');
  settings.innerHTML = `
    <h3>一時停止 / 設定</h3>
    <div class="srow"><span class="k">BGM</span><span class="stoggle" data-id="bgmtoggle">ON</span></div>
    <div class="squit" data-id="settingsquit">ゲームを中断してタイトル画面に戻る</div>
    <div class="sclose" data-id="settingsclose">[閉じる]</div>`;
  settings.querySelector<HTMLElement>('[data-id="bgmtoggle"]')!.addEventListener('click', () => {
    const on = !host.getBgmOn();
    host.setBgmState(on);
    if (host.onBgmToggle) host.onBgmToggle(on);
  });
  settings.querySelector<HTMLElement>('[data-id="settingsquit"]')!.addEventListener('click', () => {
    host.onQuitToTitle?.();
  });
  settings.querySelector<HTMLElement>('[data-id="settingsclose"]')!.addEventListener('click', () =>
    host.toggleSettings(false),
  );

  el('div', 'hud-hint', root);
  el('div', 'hud-toast', root);

  const help = el('div', 'hud-help', root, 'panel');
  help.innerHTML = `
    <h3>操作方法 [H で閉じる]</h3>
    <table>
      <tr><td class="key">Q / E (または CTRL / SHIFT)</td><td>並進 (前 / 後)</td></tr>
      <tr><td class="key">W / S</td><td>並進 (上 / 下)</td></tr>
      <tr><td class="key">A / D</td><td>並進 (左 / 右)</td></tr>
      <tr><td class="key">I / K</td><td>ピッチ (機首下げ / 上げ)</td></tr>
      <tr><td class="key">J / L</td><td>ヨー (右 / 左)</td></tr>
      <tr><td class="key">O / U</td><td>ロール (右 / 左)</td></tr>
      <tr><td class="key">T</td><td>RCS 回転制動 ON/OFF</td></tr>
      <tr><td class="key">F</td><td>プログレード姿勢リセット (機首を進行方向へ即座に向ける)</td></tr>
      <tr><td class="key">1 / 2 / 3</td><td>並進出力の切替 (弱 / 中 / 強)。W/S/A/D の並進 4 方向に共通で適用される</td></tr>
      <tr><td class="key">V</td><td>姿勢微調整モード ON/OFF (角加速度・角速度を絞って小刻みに操作)</td></tr>
      <tr><td class="key">C</td><td>進行方向ホールド ON/OFF (機首をプログレード方向へ自動で向け続ける。手動回転で解除)</td></tr>
      <tr><td class="key">G</td><td>視点のRCS追従 ON/OFF (既定 ON: 視点が機体姿勢を基準に回転し、RCS操作と一体的に動く。OFF で従来の軌道基準の独立視点に戻る)</td></tr>
      <tr><td class="key">Z (長押し)</td><td>照準ズーム (機首方向を画面中心に拡大表示、自機は非表示になる)</td></tr>
      <tr><td class="key">右クリック (敵)</td><td>敵をターゲット固定 / 解除 (固定中はターゲット名が画面右上に表示される)</td></tr>
      <tr><td class="key">▲AN / ▽DN マーカー</td><td>自機軌道とターゲット軌道面の交点。面変更(ノーマル/アンチノーマル)burn の目安位置</td></tr>
      <tr><td class="key">✦ マーカー</td><td>ターゲット位置に自機側を向けた仮想標的面を弾が通過した点。次弾の照準修正の目安</td></tr>
      <tr><td class="key">方向マーカー</td><td>Q/E (PRO/RET), A/D (NRM/ANM), W/S (OUT/IN) 方向を示すマーカー</td></tr>
      <tr><td class="key">M</td><td>軌道計画モード。地球中心ビューで数値予測した軌道(折れ線)をクリックしてノードを複数配置でき、再度 M で確定(時間は進み続けるのでワープも可)</td></tr>
      <tr><td class="key">ノードのドラッグ</td><td>ノード上の丸ハンドルをドラッグすると、ポインタに最も近い軌道上の時刻へノードを移動する(小さな動きはドラッグでなくクリック=選択として扱う)</td></tr>
      <tr><td class="key">Δv 矢印ハンドル</td><td>選択中ノードの周囲に PRO/RET・NRM/ANM・OUT/IN の6ハンドルを表示。ドラッグした向きに応じて対応する Δv 成分を増減する(マップモード中のみ W/S・A/D・Q/E キーでも同じ成分を調整可能、[V] で微調整)</td></tr>
      <tr><td class="key">1周回/1日/7日/28日</td><td>マップモード下部のボタンで予測期間を切替(1周回は現在の周期、双曲線等では1日にフォールバック)</td></tr>
      <tr><td class="key">スライダー</td><td>予測期間内の任意の時刻へゴースト位置(⬡)を表示(0で非表示)</td></tr>
      <tr><td class="key">慣性系/太陽回転系</td><td>マップモードの表示座標系を切替。太陽回転系では太陽方向が画面上でほぼ固定される(遷移計画の目安)</td></tr>
      <tr><td class="key">N</td><td>直近のマニューバノードへ自動タイムワープ(実行点の直前で自動解除)</td></tr>
      <tr><td class="key">右クリック</td><td>マップモード中、ノード近傍で右クリックするとコンテキストメニュー(この時刻まで自動ワープ / ノードを削除 / キャンセル)を開く。ノードが無い位置での右クリックや、開いたメニュー外への右クリックは閉じるだけ</td></tr>
      <tr><td class="key">X</td><td>マップモード中は選択中のノードを削除(右クリックメニューのフォールバック)、戦闘ビューでは計画全体を破棄</td></tr>
      <tr><td class="key">◆/▶NODE / ⬢BURN</td><td>直近のマニューバ実行点(▶は選択中)と噴射ガイド。BURN の方向へ加速し、噴射後の計画軌道に十分近づくとそのノードを達成として次のノードへ進む</td></tr>
      <tr><td class="key">オレンジの軌道線</td><td>ターゲットの軌道(自機軌道とほぼ重なる場合は上に重ねて描画)</td></tr>
      <tr><td class="key">弾薬 / ▣ AMMO</td><td>16発でマガジン1連を消費(右舷のベルトから自動給弾)。残弾が少なくなると付近の軌道に補給が投入されるので、▣ マーカーへ接近して回収</td></tr>
      <tr><td class="key">Space / 右クリック</td><td>機関砲発射 (ワープ×4以下)。撃ち始めは起動音とともに一瞬遅れて連射開始</td></tr>
      <tr><td class="key">, / .</td><td>タイムワープ 減 / 増</td></tr>
      <tr><td class="key">左ドラッグ / ホイール</td><td>カメラ回転 / 距離ズーム</td></tr>
      <tr><td class="key">矢印キー</td><td>マウスの代わりにキーボードで視点回転</td></tr>
      <tr><td class="key">Esc / ⚙</td><td>一時停止メニュー (設定 / タイトルへ戻る)</td></tr>
    </table>`;

  el('div', 'hud-end', root);

  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
    els.set(e.dataset['id']!, e);
  });

  return { root, svgOverlay, els };
}
