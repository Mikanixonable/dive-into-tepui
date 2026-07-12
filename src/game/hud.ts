// DOM オーバーレイの HUD。数値パネル・スクリーン投影マーカー・
// ヒント・リザルト画面を管理する。WebGPU キャンバスの上に重ねる。
export interface StatsData {
  met: number;
  warpLabel: string;
  paused: boolean;
  frameMode: 'orbital' | 'target';
  rcsDamp: boolean;
  alt: number;
  spd: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
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
}

export interface EnemyRow {
  name: string;
  dist: number;
  targeted: boolean;
}

const STYLE = `
#hud, #hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font-family: 'Consolas', 'Courier New', monospace;
  color: #9fd8e8; user-select: none; z-index: 10;
  font-size: 13px;
}
#hud .panel {
  position: absolute; background: rgba(6, 18, 26, 0.55);
  border: 1px solid rgba(90, 190, 220, 0.35); border-radius: 4px;
  padding: 8px 12px; line-height: 1.55; backdrop-filter: blur(2px);
}
#hud .panel h3 {
  font-size: 11px; letter-spacing: 2px; color: #5fb6cc;
  border-bottom: 1px solid rgba(90,190,220,0.25); margin-bottom: 4px; padding-bottom: 2px;
  font-weight: normal;
}
#hud .row { display: flex; justify-content: space-between; gap: 12px; }
#hud .row .k { color: #58899a; }
#hud .row .v { color: #c9f0fa; min-width: 90px; text-align: right; }
#hud-status { top: 12px; left: 12px; min-width: 230px; }
#hud-orbit { top: 150px; left: 12px; min-width: 230px; }
#hud-target { top: 12px; right: 12px; min-width: 240px; }
#hud-enemies { top: 190px; right: 12px; min-width: 240px; }
#hud-enemies .erow { display: flex; justify-content: space-between; gap: 8px; }
#hud-enemies .erow.tgt { color: #ffb15e; }
#hud-controls {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  color: #4e7c8c; font-size: 11px; text-align: center; white-space: nowrap;
}
#hud-hint {
  position: absolute; bottom: 64px; left: 50%; transform: translateX(-50%);
  color: #ffd27a; font-size: 14px; text-shadow: 0 0 6px #000;
  transition: opacity 0.4s; opacity: 0; text-align: center;
}
#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  color: #c9f0fa; font-size: 15px; text-align: center; text-shadow: 0 0 8px #000;
  transition: opacity 1s; opacity: 0; line-height: 1.8;
}
#hud .warp-hot { color: #ffb15e; }
#hud .mode-tgt { color: #ffb15e; }
.mk {
  position: absolute; transform: translate(-50%, -50%);
  text-align: center; white-space: nowrap; text-shadow: 0 0 4px #000;
}
.mk .sym { display: block; font-size: 22px; line-height: 1; }
.mk .lbl { display: block; font-size: 10px; margin-top: 2px; letter-spacing: 1px; }
.mk-boresight { color: #7df0ff; font-size: 18px; }
.mk-target { color: #ffb15e; }
.mk-enemy { color: rgba(255, 177, 94, 0.45); }
.mk-lead { color: #ff5f5f; }
.mk-pro { color: #8aff8a; }
.mk-retro { color: #8aff8a; }
#hud-end {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(2, 8, 12, 0.72); flex-direction: column; text-align: center;
}
#hud-end h1 { font-size: 34px; letter-spacing: 6px; margin-bottom: 18px; }
#hud-end.win h1 { color: #7dffc4; text-shadow: 0 0 24px rgba(125,255,196,0.6); }
#hud-end.lose h1 { color: #ff6a5f; text-shadow: 0 0 24px rgba(255,106,95,0.6); }
#hud-end .detail { font-size: 15px; line-height: 2; color: #c9f0fa; }
#hud-end .restart { margin-top: 22px; color: #5fb6cc; font-size: 13px; }
#hud-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: none; min-width: 480px;
}
#hud-help table { border-collapse: collapse; width: 100%; }
#hud-help td { padding: 2px 10px; }
#hud-help td.key { color: #ffd27a; text-align: right; white-space: nowrap; }
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
      <div class="row"><span class="k">推進基準 [F]</span><span class="v" data-id="mode"></span></div>
      <div class="row"><span class="k">RCS制動 [T]</span><span class="v" data-id="rcs"></span></div>`;

    const orbit = el('div', 'hud-orbit', this.root, 'panel');
    orbit.innerHTML = `
      <h3>ORBIT</h3>
      <div class="row"><span class="k">高度 ALT</span><span class="v" data-id="alt"></span></div>
      <div class="row"><span class="k">速度 VEL</span><span class="v" data-id="spd"></span></div>
      <div class="row"><span class="k">遠地点 AP</span><span class="v" data-id="ap"></span></div>
      <div class="row"><span class="k">近地点 PE</span><span class="v" data-id="pe"></span></div>
      <div class="row"><span class="k">傾斜角 INC</span><span class="v" data-id="inc"></span></div>
      <div class="row"><span class="k">周期 PRD</span><span class="v" data-id="prd"></span></div>`;

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
      'W/S/A/D/Q/E:並進 &nbsp;I/K/J/L/U/O:回転 &nbsp;Space/左クリック:射撃 &nbsp;右ドラッグ:視点 &nbsp;,/.:ワープ &nbsp;[H]:ヘルプ';

    el('div', 'hud-hint', this.root);
    el('div', 'hud-toast', this.root);

    const help = el('div', 'hud-help', this.root, 'panel');
    help.innerHTML = `
      <h3>操作方法 [H で閉じる]</h3>
      <table>
        <tr><td class="key">W / S</td><td>加速(プログレード) / 減速(レトログレード) ※TGT基準では接近/離脱</td></tr>
        <tr><td class="key">A / D</td><td>ノーマル / アンチノーマル ※TGT基準では左右</td></tr>
        <tr><td class="key">Q / E</td><td>ラジアルイン / ラジアルアウト ※TGT基準では下上</td></tr>
        <tr><td class="key">F</td><td>推進基準の切替 (軌道基準 ⇄ ターゲット基準)</td></tr>
        <tr><td class="key">I / K</td><td>ピッチ (機首下げ / 上げ)</td></tr>
        <tr><td class="key">J / L</td><td>ヨー (左 / 右)</td></tr>
        <tr><td class="key">U / O</td><td>ロール (左 / 右)</td></tr>
        <tr><td class="key">T</td><td>RCS 回転制動 ON/OFF</td></tr>
        <tr><td class="key">Tab</td><td>ターゲット切替 (近い順)</td></tr>
        <tr><td class="key">Space / 左クリック</td><td>機関砲発射 (ワープ×4以下)</td></tr>
        <tr><td class="key">, / .</td><td>タイムワープ 減 / 増</td></tr>
        <tr><td class="key">P</td><td>一時停止</td></tr>
        <tr><td class="key">右ドラッグ / ホイール</td><td>カメラ回転 / ズーム</td></tr>
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
    const modeEl = this.els.get('mode');
    if (modeEl) {
      modeEl.textContent = d.frameMode === 'orbital' ? 'ORBIT' : 'TARGET';
      modeEl.classList.toggle('mode-tgt', d.frameMode === 'target');
    }
    this.setText('rcs', d.rcsDamp ? 'ON' : 'OFF');
    this.setText('alt', fmtDist(d.alt));
    this.setText('spd', fmtSpeed(d.spd));
    this.setText('ap', fmtDist(d.apAlt));
    this.setText('pe', fmtDist(d.peAlt));
    this.setText('inc', `${d.incDeg.toFixed(2)}°`);
    this.setText('prd', fmtTime(d.period));
    this.setText('count', `${d.total - d.kills}/${d.total}`);
  }

  setTarget(t: TargetData | null): void {
    const body = this.els.get('tgtbody');
    if (!body) return;
    if (!t) {
      body.innerHTML = '<div style="color:#58899a">ターゲットなし</div>';
      return;
    }
    body.innerHTML = `
      <div class="row"><span class="k">名称</span><span class="v">${t.name}</span></div>
      <div class="row"><span class="k">距離</span><span class="v">${fmtDist(t.dist)}</span></div>
      <div class="row"><span class="k">接近速度</span><span class="v">${fmtSpeed(t.closing)}</span></div>
      <div class="row"><span class="k">相対速度</span><span class="v">${fmtSpeed(t.relSpeed)}</span></div>
      <div class="row"><span class="k">HP</span><span class="v">${'■'.repeat(Math.max(0, t.hp))}${'□'.repeat(Math.max(0, t.maxHp - t.hp))}</span></div>`;
  }

  setEnemyList(rows: EnemyRow[]): void {
    const list = this.els.get('elist');
    if (!list) return;
    if (rows.length === 0) {
      list.innerHTML = '<div style="color:#58899a">残存目標なし</div>';
      return;
    }
    list.innerHTML = rows
      .map(
        (r) =>
          `<div class="erow${r.targeted ? ' tgt' : ''}"><span>${r.targeted ? '▶ ' : ''}${r.name}</span><span>${fmtDist(r.dist)}</span></div>`,
      )
      .join('');
  }

  // マーカー(スクリーン座標)。visible=false で非表示。
  marker(key: string, cls: string, sym: string, x: number, y: number, visible: boolean, label = ''): void {
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
