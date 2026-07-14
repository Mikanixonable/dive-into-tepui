// DOM オーバーレイの HUD。数値パネル・スクリーン投影マーカー・
// ヒント・リザルト画面を管理する。WebGPU キャンバスの上に重ねる。
import * as C from './const';

export interface StatsData {
  met: number;
  warpLabel: string;
  paused: boolean;
  rcsDamp: boolean;
  throttleIdx: number;
  fineAttitude: boolean;
  progradeHold: boolean;
  camFollowAttitude: boolean;
  roundsInMag: number; // 給弾中マガジンの残弾
  magsLeft: number; // ベルトの未使用マガジン数
  alt: number;
  spd: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
  qdyn: number; // 動圧 [Pa]
  hullTemp: number; // 機体表面温度 [K]
  shots: number;
  kills: number;
  total: number;
}

export interface TargetData {
  name: string;
  dist: number;
  closing: number; // 接近速度 [m/s] (正 = 近づいている)
  relSpeed: number;
  hp: number;
  maxHp: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
  relIncDeg: number; // 自機軌道面との相対傾斜角 [deg]
}

export interface EnemyRow {
  name: string;
  dist: number;
  targeted: boolean;
}

// デザイン方針: ダークテーマ。ニューモーフィズムは廃止し、モノトーン
// (ほぼ無彩色のグレースケール)+ 彩度の高いオレンジ 1 色をアクセントに使う
// フラットなパネルにする。スクリーン投影マーカーもモノトーンに揃え、
// 「注目すべきもの」(ターゲット・リード・マニューバ・補給)だけをオレンジで示す。
const INK = '#e6e8eb'; // 本文色
const INK_SOFT = '#7d838c'; // ラベル・キャプション色
const ACCENT = '#ff6a00'; // 彩度の高いオレンジ(唯一のアクセントカラー)
const ACCENT_SOFT = '#ff9040'; // アクセントの淡色
const SURFACE = 'rgba(13, 15, 18, 0.82)'; // パネル面(ほぼ黒)
const EDGE = 'rgba(255, 255, 255, 0.09)'; // 細いエッジライン

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
  border-bottom: 1px solid rgba(255, 106, 0, 0.25); margin-bottom: 6px; padding-bottom: 4px;
  font-weight: 600;
}
#hud .row { display: flex; justify-content: space-between; gap: 12px; }
#hud .row .k { color: ${INK_SOFT}; }
#hud .row .v { color: ${INK}; min-width: 90px; text-align: right; }
#hud-status { top: 12px; left: 12px; min-width: 230px; }
#hud-orbit { top: 236px; left: 12px; min-width: 230px; }
#hud-target { top: 12px; right: 12px; min-width: 240px; }
#hud-enemies { top: 348px; right: 12px; min-width: 240px; }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: 8px; color: ${INK_SOFT}; }
#hud-enemies .erow.tgt { color: ${ACCENT}; }
#hud-controls {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 6px 18px;
  color: ${INK_SOFT}; font-size: 11px; text-align: center; white-space: nowrap;
}
#hud-hint {
  position: absolute; bottom: 200px; left: 50%; transform: translateX(-50%);
  background: ${SURFACE}; border: 1px solid rgba(255, 106, 0, 0.35); border-radius: 4px;
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
}
.mk .sym { display: block; font-size: 22px; line-height: 1; }
.mk .lbl { display: block; font-size: 10px; margin-top: 2px; letter-spacing: 1px; }
.mk-boresight { color: #dfe3e8; font-size: 18px; }
.mk-target { color: ${ACCENT}; }
.mk-enemy { color: rgba(230, 232, 235, 0.35); }
.mk-lead { color: ${ACCENT}; }
.mk-pro { color: #cfd6dd; }
.mk-retro { color: #cfd6dd; }
.mk-node { color: #8b93a0; }
.mk-boardhit { color: #ffffff; text-shadow: 0 0 5px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.45); }
.mk-boardhit .sym { font-size: 8px; }
.mk-mnode { color: ${ACCENT_SOFT}; }
.mk-burn { color: ${ACCENT}; text-shadow: 0 0 8px rgba(255,106,0,0.7); }
.mk-self { color: #dfe3e8; }
.mk-ammo { color: ${ACCENT_SOFT}; text-shadow: 0 0 6px rgba(255,144,64,0.6), 0 0 3px #000; }
#hud .warn-hot { color: ${ACCENT}; }
#hud-plan {
  position: absolute; bottom: 40px; left: 12px; min-width: 280px;
}
#hud-end {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(6, 7, 9, 0.82); backdrop-filter: blur(3px);
  flex-direction: column; text-align: center;
}
#hud-end h1 { font-size: 34px; letter-spacing: 6px; margin-bottom: 18px; }
#hud-end.win h1 { color: ${INK}; text-shadow: 0 0 18px rgba(230,232,235,0.35); }
#hud-end.lose h1 { color: ${ACCENT}; text-shadow: 0 0 18px rgba(255,106,0,0.4); }
#hud-end .detail {
  font-size: 15px; line-height: 2; color: ${INK};
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 18px 30px;
}
#hud-end .restart { margin-top: 22px; color: ${ACCENT_SOFT}; font-size: 13px; }
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; min-width: 480px; max-height: 86vh; overflow-y: auto;
}
#hud-help table { border-collapse: collapse; width: 100%; }
#hud-help td { padding: 3px 10px; color: ${INK}; }
#hud-help td.key { color: ${ACCENT_SOFT}; text-align: right; white-space: nowrap; }
`;

function el(tag: string, id: string, parent: HTMLElement, className = ''): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  if (className) e.className = className;
  parent.appendChild(e);
  return e;
}

function fmtDist(m: number): string {
  if (!isFinite(m)) return '---';
  if (Math.abs(m) >= 1e6) return `${(m / 1e6).toFixed(2)} Mm`;
  if (Math.abs(m) >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

function fmtSpeed(ms: number): string {
  if (!isFinite(ms)) return '---';
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(2)} km/s`;
  return `${ms.toFixed(1)} m/s`;
}

function fmtTime(s: number): string {
  if (!isFinite(s)) return '--:--:--';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export class Hud {
  private root: HTMLElement;
  private els = new Map<string, HTMLElement>();
  private markers = new Map<string, { root: HTMLElement; sym: HTMLElement; lbl: HTMLElement }>();
  private hintUntil = 0;
  private toastUntil = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = el('div', 'hud', document.body);

    const status = el('div', 'hud-status', this.root, 'panel');
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

    const orbit = el('div', 'hud-orbit', this.root, 'panel');
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

    const target = el('div', 'hud-target', this.root, 'panel');
    target.innerHTML = `
      <h3>TARGET [Tab]</h3>
      <div data-id="tgtbody"></div>`;

    const enemies = el('div', 'hud-enemies', this.root, 'panel');
    enemies.innerHTML = `
      <h3>CONTACTS <span data-id="count"></span></h3>
      <div data-id="elist"></div>`;

    const controls = el('div', 'hud-controls', this.root);
    controls.innerHTML =
      'W/S/A/D/Q/E:並進 &nbsp;I/K/J/L/U/O:回転 &nbsp;1/2/3:並進出力 &nbsp;C:進行方向ホールド &nbsp;G:視点のRCS追従 &nbsp;M:軌道計画 &nbsp;N:ノードへワープ &nbsp;Z:ズーム &nbsp;' +
      'Space/右クリック:射撃 &nbsp;左ドラッグ/矢印キー:視点 &nbsp;,/.:ワープ &nbsp;[H]:ヘルプ';

    const plan = el('div', 'hud-plan', this.root, 'panel');
    plan.innerHTML = `<h3>MANEUVER PLAN [M]</h3><div data-id="planbody"></div>`;
    plan.style.display = 'none';

    el('div', 'hud-hint', this.root);
    el('div', 'hud-toast', this.root);

    const help = el('div', 'hud-help', this.root, 'panel');
    help.innerHTML = `
      <h3>操作方法 [H で閉じる]</h3>
      <table>
        <tr><td class="key">W / S</td><td>並進 (前 / 後)</td></tr>
        <tr><td class="key">A / D</td><td>並進 (左 / 右)</td></tr>
        <tr><td class="key">Q / E</td><td>並進 (上 / 下)</td></tr>
        <tr><td class="key">I / K</td><td>ピッチ (機首下げ / 上げ)</td></tr>
        <tr><td class="key">J / L</td><td>ヨー (左 / 右)</td></tr>
        <tr><td class="key">O / U</td><td>ロール (右 / 左)</td></tr>
        <tr><td class="key">T</td><td>RCS 回転制動 ON/OFF</td></tr>
        <tr><td class="key">1 / 2 / 3</td><td>並進出力の切替 (弱 / 中 / 強)。W/S/A/D/Q/E の全 6 方向に共通で適用される</td></tr>
        <tr><td class="key">V</td><td>姿勢微調整モード ON/OFF (角加速度・角速度を絞って小刻みに操作)</td></tr>
        <tr><td class="key">C</td><td>進行方向ホールド ON/OFF (機首をプログレード方向へ自動で向け続ける。手動回転で解除)</td></tr>
        <tr><td class="key">G</td><td>視点のRCS追従 ON/OFF (既定 ON: 視点が機体姿勢を基準に回転し、RCS操作と一体的に動く。OFF で従来の軌道基準の独立視点に戻る)</td></tr>
        <tr><td class="key">Z (長押し)</td><td>照準ズーム (機首方向を画面中心に拡大表示、自機は非表示になる)</td></tr>
        <tr><td class="key">Tab</td><td>ターゲット切替 (近い順)。TARGET パネルに軌道要素・相対傾斜角を表示</td></tr>
        <tr><td class="key">▲AN / ▽DN マーカー</td><td>自機軌道とターゲット軌道面の交点。面変更(ノーマル/アンチノーマル)burn の目安位置</td></tr>
        <tr><td class="key">✦ マーカー</td><td>ターゲット位置に自機側を向けた仮想標的面を弾が通過した点。次弾の照準修正の目安</td></tr>
        <tr><td class="key">Navball</td><td>画面下中央の姿勢儀。青半球 = 地球方向。PRO/RET・NRM/ANM・OUT/IN・TGT/ATG を表示</td></tr>
        <tr><td class="key">M</td><td>軌道計画モード。地球中心ビューで自機軌道をクリックしノード配置、W/S・A/D・Q/E で Δv 調整、再度 M で確定(時間は進み続けるのでワープも可)</td></tr>
        <tr><td class="key">N</td><td>マニューバノードへ自動タイムワープ(実行点の直前で自動解除)</td></tr>
        <tr><td class="key">X</td><td>マニューバノードを削除</td></tr>
        <tr><td class="key">◆NODE / ⬢BURN</td><td>マニューバ実行点と噴射ガイド。BURN の方向へ加速し、計画軌道(白)に十分近づくと達成</td></tr>
        <tr><td class="key">オレンジの軌道線</td><td>ターゲットの軌道(自機軌道とほぼ重なる場合は上に重ねて描画)</td></tr>
        <tr><td class="key">弾薬 / ▣ AMMO</td><td>16発でマガジン1連を消費(右舷のベルトから自動給弾)。残弾が少なくなると付近の軌道に補給が投入されるので、▣ マーカーへ接近して回収</td></tr>
        <tr><td class="key">Space / 右クリック</td><td>機関砲発射 (ワープ×4以下)。撃ち始めは起動音とともに一瞬遅れて連射開始</td></tr>
        <tr><td class="key">, / .</td><td>タイムワープ 減 / 増</td></tr>
        <tr><td class="key">P</td><td>一時停止</td></tr>
        <tr><td class="key">左ドラッグ / ホイール</td><td>カメラ回転 / 距離ズーム</td></tr>
        <tr><td class="key">矢印キー</td><td>マウスの代わりにキーボードで視点回転</td></tr>
      </table>`;

    el('div', 'hud-end', this.root);

    this.root.querySelectorAll<HTMLElement>('[data-id]').forEach((e) => {
      this.els.set(e.dataset['id']!, e);
    });
  }

  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }

  setStats(d: StatsData): void {
    this.setText('met', `T+ ${fmtTime(d.met)}`);
    const warpEl = this.els.get('warp');
    if (warpEl) {
      warpEl.textContent = d.paused ? 'PAUSE' : d.warpLabel;
      warpEl.classList.toggle('warp-hot', d.warpLabel !== '×1' || d.paused);
    }

    this.setText('rcs', d.rcsDamp ? 'ON' : 'OFF');
    const throttleLabels = ['弱', '中', '強'];
    this.setText(
      'throttle',
      `${throttleLabels[d.throttleIdx]} (${C.THROTTLE_LEVELS[d.throttleIdx]!.toFixed(1)} m/s²)`,
    );
    const fineEl = this.els.get('fine');
    if (fineEl) {
      fineEl.textContent = d.fineAttitude ? 'ON' : 'OFF';
      fineEl.classList.toggle('mode-tgt', d.fineAttitude);
    }
    const camfollowEl = this.els.get('camfollow');
    if (camfollowEl) {
      camfollowEl.textContent = d.camFollowAttitude ? 'ON' : 'OFF';
      camfollowEl.classList.toggle('mode-tgt', d.camFollowAttitude);
    }
    const proholdEl = this.els.get('prohold');
    if (proholdEl) {
      proholdEl.textContent = d.progradeHold ? 'ON' : 'OFF';
      proholdEl.classList.toggle('mode-tgt', d.progradeHold);
    }
    const ammoEl = this.els.get('ammo');
    if (ammoEl) {
      ammoEl.textContent =
        d.roundsInMag <= 0 && d.magsLeft <= 0
          ? '弾切れ'
          : `${d.roundsInMag}/${C.MAG_ROUNDS} +${d.magsLeft}連`;
      ammoEl.classList.toggle('warn-hot', d.magsLeft < 4);
    }
    this.setText('alt', fmtDist(d.alt));
    this.setText('spd', fmtSpeed(d.spd));
    this.setText('ap', fmtDist(d.apAlt));
    this.setText('pe', fmtDist(d.peAlt));
    this.setText('inc', `${d.incDeg.toFixed(2)}°`);
    this.setText('prd', fmtTime(d.period));
    const qEl = this.els.get('qdyn');
    if (qEl) {
      qEl.textContent = d.qdyn >= 10 ? `${(d.qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
      qEl.classList.toggle('warn-hot', d.qdyn > 0.5 * C.MAX_DYN_PRESSURE);
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${d.hullTemp.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', d.hullTemp > 0.7 * C.MAX_HULL_TEMP);
    }
    this.setText('count', `${d.total - d.kills}/${d.total}`);
  }

  setTarget(t: TargetData | null): void {
    const body = this.els.get('tgtbody');
    if (!body) return;
    if (!t) {
      body.innerHTML = '<div style="color:#7d838c">ターゲットなし</div>';
      return;
    }
    body.innerHTML = `
      <div class="row"><span class="k">名称</span><span class="v">${t.name}</span></div>
      <div class="row"><span class="k">距離</span><span class="v">${fmtDist(t.dist)}</span></div>
      <div class="row"><span class="k">接近速度</span><span class="v">${fmtSpeed(t.closing)}</span></div>
      <div class="row"><span class="k">相対速度</span><span class="v">${fmtSpeed(t.relSpeed)}</span></div>
      <div class="row"><span class="k">HP</span><span class="v">${'■'.repeat(Math.max(0, t.hp))}${'□'.repeat(Math.max(0, t.maxHp - t.hp))}</span></div>
      <div class="row"><span class="k">遠地点 AP</span><span class="v">${fmtDist(t.apAlt)}</span></div>
      <div class="row"><span class="k">近地点 PE</span><span class="v">${fmtDist(t.peAlt)}</span></div>
      <div class="row"><span class="k">傾斜角 INC</span><span class="v">${isFinite(t.incDeg) ? t.incDeg.toFixed(2) + '°' : '---'}</span></div>
      <div class="row"><span class="k">周期 PRD</span><span class="v">${fmtTime(t.period)}</span></div>
      <div class="row"><span class="k">相対傾斜 [AN/DN]</span><span class="v">${isFinite(t.relIncDeg) ? t.relIncDeg.toFixed(2) + '°' : '---'}</span></div>`;
  }

  setEnemyList(rows: EnemyRow[]): void {
    const list = this.els.get('elist');
    if (!list) return;
    if (rows.length === 0) {
      list.innerHTML = '<div style="color:#7d838c">残存目標なし</div>';
      return;
    }
    list.innerHTML = rows
      .map(
        (r) =>
          `<div class="erow${r.targeted ? ' tgt' : ''}"><span>${r.targeted ? '▶ ' : ''}${r.name}</span><span>${fmtDist(r.dist)}</span></div>`,
      )
      .join('');
  }

  // 軌道計画パネル。html=null で非表示。
  setPlanPanel(html: string | null): void {
    const panel = document.getElementById('hud-plan');
    const body = this.els.get('planbody');
    if (!panel || !body) return;
    if (html === null) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    if (body.innerHTML !== html) body.innerHTML = html;
  }

  // 計画パネルの定型 HTML(Δv 成分・飛行時間・計画軌道の要素)
  planHtml(dv: { x: number; y: number; z: number }, tofSec: number, el: { apAlt: number; peAlt: number; incDeg: number; period: number } | null): string {
    const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    let s =
      row('Δv PRO [W/S]', `${dv.x.toFixed(1)} m/s`) +
      row('Δv NRM [A/D]', `${dv.y.toFixed(1)} m/s`) +
      row('Δv RAD [E/Q]', `${dv.z.toFixed(1)} m/s`) +
      row('合計 Δv', `${Math.hypot(dv.x, dv.y, dv.z).toFixed(1)} m/s`) +
      row('ノードまで', fmtTime(tofSec));
    if (el) {
      s +=
        `<div style="margin-top:4px;color:#e6e8eb;font-size:11px;letter-spacing:1px">計画軌道</div>` +
        row('遠地点 AP', fmtDist(el.apAlt)) +
        row('近地点 PE', fmtDist(el.peAlt)) +
        row('傾斜角 INC', isFinite(el.incDeg) ? `${el.incDeg.toFixed(2)}°` : '---') +
        row('周期 PRD', fmtTime(el.period));
      if (isFinite(el.peAlt) && el.peAlt < 120e3) {
        s += `<div style="color:#ff6a00;margin-top:2px">⚠ 近地点が大気圏内</div>`;
      }
    }
    s += `<div style="margin-top:6px;color:#7d838c;font-size:11px">[クリック] ノード移動 [X] 削除 [V] 微調整 [M] 確定して戻る(時間は進み続ける)</div>`;
    return s;
  }

  // マーカー(スクリーン座標)。visible=false で非表示。
  marker(
    key: string,
    cls: string,
    sym: string,
    x: number,
    y: number,
    visible: boolean,
    label = '',
    opacity = 1,
  ): void {
    let m = this.markers.get(key);
    if (!m) {
      const root = el('div', `mk-${key}`, this.root, `mk ${cls}`);
      const symEl = el('span', `mk-${key}-s`, root, 'sym');
      const lblEl = el('span', `mk-${key}-l`, root, 'lbl');
      m = { root, sym: symEl, lbl: lblEl };
      this.markers.set(key, m);
    }
    m.root.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    m.root.style.left = `${x.toFixed(1)}px`;
    m.root.style.top = `${y.toFixed(1)}px`;
    m.root.style.opacity = opacity >= 1 ? '' : opacity.toFixed(2);
    if (m.sym.textContent !== sym) m.sym.textContent = sym;
    if (m.lbl.textContent !== label) m.lbl.textContent = label;
  }

  hideMarker(key: string): void {
    const m = this.markers.get(key);
    if (m) m.root.style.display = 'none';
  }

  hint(text: string, durationMs = 1800): void {
    const e = document.getElementById('hud-hint');
    if (!e) return;
    e.textContent = text;
    e.style.opacity = '1';
    this.hintUntil = performance.now() + durationMs;
  }

  toast(html: string, durationMs = 8000): void {
    const e = document.getElementById('hud-toast');
    if (!e) return;
    e.innerHTML = html;
    e.style.opacity = '1';
    this.toastUntil = performance.now() + durationMs;
  }

  toggleHelp(): void {
    const e = document.getElementById('hud-help');
    if (e) e.style.display = e.style.display === 'block' ? 'none' : 'block';
  }

  showEnd(win: boolean, detailHtml: string): void {
    const e = document.getElementById('hud-end');
    if (!e) return;
    e.className = win ? 'win' : 'lose';
    e.style.display = 'flex';
    e.innerHTML = `
      <h1>${win ? 'MISSION COMPLETE' : 'SHIP LOST'}</h1>
      <div class="detail">${detailHtml}</div>
      <div class="restart">[R] キーで再出撃</div>`;
  }

  tick(): void {
    const now = performance.now();
    const hint = document.getElementById('hud-hint');
    if (hint && this.hintUntil && now > this.hintUntil) {
      hint.style.opacity = '0';
      this.hintUntil = 0;
    }
    const toast = document.getElementById('hud-toast');
    if (toast && this.toastUntil && now > this.toastUntil) {
      toast.style.opacity = '0';
      this.toastUntil = 0;
    }
  }
}
