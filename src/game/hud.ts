// DOM オーバーレイの HUD。数値パネル・スクリーン投影マーカー・
// ヒント・リザルト画面を管理する。WebGPU キャンバスの上に重ねる。
//
// 内部構成:
//   - hud/dom.ts     … 静的 DOM/スタイル構築(旧 constructor 本体)
//   - hud/markers.ts … スクリーン投影マーカー管理(marker/hideMarker/resolveMarkerCollisions)
//   - このファイル   … パネル更新・トースト・ヘルプ・設定・終了画面(公開 API は不変)
import * as C from './const';
import { ACCENT, TEXT as INK, TEXT_DIM as INK_SOFT } from './theme';
import { buildHudDom } from './hud/dom';
import { MarkerManager } from './hud/markers';

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
  reloadTimer: number; // リロード(バレル交換)中の残り時間
  alt: number;
  altDescending: boolean;
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
  stage0State: { hp: number; maxHp: number; msg: string } | null;
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
  private els: Map<string, HTMLElement>;
  private markerMgr: MarkerManager;
  private hintUntil = 0;
  private toastUntil = 0;
  private bgmOn = true;
  onBgmToggle: ((on: boolean) => void) | null = null;
  // 一時停止メニュー(旧 [P] を統合した [Esc]/⚙設定パネル)の開閉状態が変化した際に呼ぶ。
  // ゲーム側はこれを HP自動回復・時間経過の一時停止フラグ (paused) に同期させる。
  onSettingsOpenChange: ((open: boolean) => void) | null = null;
  // 「ゲームを中断してタイトル画面に戻る」ボタン
  onQuitToTitle: (() => void) | null = null;
  // 軌道計画モードのマップツールバー(期間選択・スライダー・座標系トグル)
  onDurationSelect: ((key: string) => void) | null = null;
  onFrameToggle: (() => void) | null = null;
  onMapFocusSelect: ((focus: string) => void) | null = null;
  onMapViewReset: (() => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;

  private svgOverlay: SVGSVGElement;

  constructor() {
    const { root, svgOverlay, els } = buildHudDom(this);
    this.root = root;
    this.svgOverlay = svgOverlay;
    this.els = els;
    this.markerMgr = new MarkerManager(this.root, this.svgOverlay);
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
      if (d.reloadTimer > 0) {
        ammoEl.textContent = 'RELOADING...';
        ammoEl.classList.add('warn-hot');
      } else {
        ammoEl.textContent =
          d.roundsInMag <= 0 && d.magsLeft <= 0
            ? '弾切れ'
            : `${d.roundsInMag}/${C.MAG_ROUNDS} +${d.magsLeft}連`;
        ammoEl.classList.toggle('warn-hot', d.magsLeft < 4);
      }
    }
    this.setText('alt', fmtDist(d.alt));
    const altEl = this.els.get('alt');
    if (altEl) altEl.classList.toggle('warn-hot', d.altDescending);
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

    const stage0El = document.getElementById('hud-stage0');
    if (stage0El) {
      if (d.stage0State !== null) {
        stage0El.style.display = 'block';
        const hpEl = this.els.get('stage0hp');
        if (hpEl) {
          const { hp, maxHp } = d.stage0State;
          const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
          hpEl.innerHTML = `HP: ${Math.floor(hp)} / ${maxHp} <div style="display:inline-block; width:120px; height:10px; border:1px solid #aaa; background:#222; vertical-align:middle; margin-left:8px;"><div style="width:${pct}%; height:100%; background:${hp <= maxHp * 0.3 ? '#ff4a3d' : '#4de8ff'}; transition:width 0.2s;"></div></div>`;
          hpEl.classList.toggle('warn', hp <= maxHp * 0.3);
        }
        this.setText('stage0phase', d.stage0State.msg);
        this.setText('stage0kills', `${d.kills}`);
      } else {
        stage0El.style.display = 'none';
      }
    }
  }

  setTarget(t: TargetData | null): void {
    const body = this.els.get('tgtbody');
    if (!body) return;
    const title = this.els.get('tgtname');
    if (!t) {
      if (title) title.textContent = 'TARGET';
      body.innerHTML = `<div style="color:${INK_SOFT}">ターゲットなし</div>`;
      return;
    }
    if (title) title.textContent = t.name;
    body.innerHTML = `
      <div class="row"><span class="k">距離</span><span class="v">${fmtDist(t.dist)}</span></div>
      <div class="row"><span class="k">接近速度</span><span class="v">${fmtSpeed(t.closing)}</span></div>
      <div class="row"><span class="k">相対速度</span><span class="v">${fmtSpeed(t.relSpeed)}</span></div>
      <div class="row"><span class="k">HP</span><span class="v">${Math.floor(t.hp)} / ${t.maxHp} <div style="display:inline-block; width:100px; height:8px; border:1px solid #aaa; background:#222; vertical-align:middle; margin-left:4px;"><div style="width:${Math.max(0, Math.min(100, (t.hp / t.maxHp) * 100))}%; height:100%; background:${t.hp <= t.maxHp * 0.3 ? '#ff4a3d' : '#ffc86e'}; transition:width 0.2s;"></div></div></span></div>
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
      list.innerHTML = `<div style="color:${INK_SOFT}">残存目標なし</div>`;
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

  // 計画パネルの定型 HTML(複数ノード対応)。nodes は時刻順のノード一覧
  // (選択中ノードのみ selected=true)、selDv/selEl は選択中ノードの Δv 成分と
  // 噴射後の軌道要素(未選択なら null)。
  planHtml(
    nodes: { tRel: number; dvMag: number; selected: boolean }[],
    selDv: { x: number; y: number; z: number } | null,
    selEl: { apAlt: number; peAlt: number; incDeg: number; period: number } | null,
  ): string {
    const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    let s = '';
    if (nodes.length === 0) {
      s += `<div style="color:${INK_SOFT}">予測軌道(グレー)をクリックしてマニューバノードを配置</div>`;
    } else {
      s += nodes
        .map((n, i) => {
          const sign = n.tRel >= 0 ? 'T-' : 'T+';
          return `<div class="row"><span class="k">${n.selected ? '▶ ' : '◆ '}NODE${i + 1} ${sign}${fmtTime(Math.abs(n.tRel))}</span><span class="v">${n.dvMag.toFixed(1)} m/s</span></div>`;
        })
        .join('');
    }
    if (selDv) {
      s +=
        `<div style="margin-top:4px;color:${INK};font-size:11px;letter-spacing:1px">選択中ノードの Δv</div>` +
        row('Δv PRO [W/S]', `${selDv.x.toFixed(1)} m/s`) +
        row('Δv NRM [A/D]', `${selDv.y.toFixed(1)} m/s`) +
        row('Δv RAD [E/Q]', `${selDv.z.toFixed(1)} m/s`) +
        row('合計 Δv', `${Math.hypot(selDv.x, selDv.y, selDv.z).toFixed(1)} m/s`);
    }
    if (selEl) {
      s +=
        `<div style="margin-top:4px;color:${INK};font-size:11px;letter-spacing:1px">噴射後の軌道</div>` +
        row('遠地点 AP', fmtDist(selEl.apAlt)) +
        row('近地点 PE', fmtDist(selEl.peAlt)) +
        row('傾斜角 INC', isFinite(selEl.incDeg) ? `${selEl.incDeg.toFixed(2)}°` : '---') +
        row('周期 PRD', fmtTime(selEl.period));
      if (isFinite(selEl.peAlt) && selEl.peAlt < 120e3) {
        s += `<div style="color:${ACCENT};margin-top:2px">⚠ 近地点が大気圏内</div>`;
      }
    }
    s += `<div style="margin-top:6px;color:${INK_SOFT};font-size:11px">[クリック] ノード配置/選択 [ノードをドラッグ] 時刻移動 [矢印ハンドル/W/S・A/D・Q/E] Δv調整 [右クリック] メニュー(自動ワープ/削除) [X] 選択ノード削除 [V] 微調整 [M] 確定して戻る(時間は進み続ける)</div>`;
    return s;
  }

  // マップモードのツールバー表示切替
  setMapToolbarVisible(visible: boolean): void {
    const e = document.getElementById('hud-maptool');
    if (e) e.style.display = visible ? 'block' : 'none';
  }

  // durationKey: 選択中の期間ボタン('orbit'|'day'|'week'|'month')。
  // frameRotating: 太陽回転系が有効か。sliderT: スライダー位置(0..1、変更なしなら省略)。
  // sliderLabel: スライダーが 0 より大きいときに表示するラベル(T+ 表記・高度など)。
  setMapToolbarState(
    durationKey: string,
    frameRotating: boolean,
    sliderLabel: string | null,
    focus: string = 'earth',
  ): void {
    const bar = document.getElementById('hud-maptool');
    if (!bar) return;
    bar.querySelectorAll<HTMLElement>('.mt-btn[data-dur]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['dur'] === durationKey);
    });
    const frameBtn = bar.querySelector<HTMLElement>('[data-id="mt-frame"]');
    if (frameBtn) {
      frameBtn.textContent = frameRotating ? '太陽回転系' : '慣性系';
      frameBtn.classList.toggle('on', frameRotating);
    }
    bar.querySelectorAll<HTMLElement>('.mt-btn[data-focus]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['focus'] === focus);
    });
    const lbl = bar.querySelector<HTMLElement>('[data-id="mt-sliderlabel"]');
    if (lbl) lbl.textContent = sliderLabel ?? 'スライダーで未来位置を確認';
  }

  // マーカー(スクリーン座標)。visible=false で非表示。実体は MarkerManager に委譲。
  marker(
    key: string,
    cls: string,
    sym: string,
    x: number,
    y: number,
    visible: boolean,
    label = '',
    opacity = 1,
    color?: string,
    rotationDeg?: number
  ): void {
    this.markerMgr.marker(key, cls, sym, x, y, visible, label, opacity, color, rotationDeg);
  }

  hideMarker(key: string): void {
    this.markerMgr.hideMarker(key);
  }

  resolveMarkerCollisions(): void {
    this.markerMgr.resolveMarkerCollisions();
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

  // 設定パネル(一時停止メニュー)の開閉。force を渡すとその状態に固定する。
  // ⚙ギアクリック・[閉じる]クリック・[Esc]キーいずれの経路でも同じここを通るので、
  // onSettingsOpenChange 経由でゲーム側の一時停止フラグを漏れなく同期できる。
  // HudDomHost 用: BGM トグルボタンの現在状態を返す(dom.ts のクリックハンドラから参照)。
  getBgmOn(): boolean {
    return this.bgmOn;
  }

  toggleSettings(force?: boolean): void {
    const e = document.getElementById('hud-settings');
    if (!e) return;
    const wasOpen = e.style.display === 'block';
    const show = force !== undefined ? force : !wasOpen;
    if (show === wasOpen) return;
    e.style.display = show ? 'block' : 'none';
    this.onSettingsOpenChange?.(show);
  }

  // BGM トグル表示の反映(実際の再生制御は呼び出し側の Sfx が行う)
  setBgmState(on: boolean): void {
    this.bgmOn = on;
    const t = this.els.get('bgmtoggle');
    if (t) {
      t.textContent = on ? 'ON' : 'OFF';
      t.classList.toggle('on', on);
    }
  }

  // title を渡すと見出しを差し替える(第零ステージのスコアアタック終了など、
  // 勝敗二択に収まらない結果画面向け)。
  showEnd(win: boolean, detailHtml: string, title?: string): void {
    const e = document.getElementById('hud-end');
    if (!e) return;
    e.className = win ? 'win' : 'lose';
    e.style.display = 'flex';
    e.style.pointerEvents = 'auto'; // タップでも再出撃できるようにする
    e.innerHTML = `
      <h1>${title ?? (win ? 'MISSION COMPLETE' : 'SHIP LOST')}</h1>
      <div class="detail">${detailHtml}</div>
      <div class="restart">[R] キーまたはタップで再出撃</div>`;
    e.onclick = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
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
