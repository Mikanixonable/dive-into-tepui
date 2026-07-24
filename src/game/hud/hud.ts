// DOM オーバーレイの HUD のシェル。トースト・ヒント・ヘルプ・設定(一時停止メニュー)・
// 終了画面・計画パネル/マップツールバーを管理し、WebGPU キャンバスの上に重ねる。
// マーカー表示(MarkerManager)は SVG オーバーレイを使う実装詳細に過ぎず、今後変わり得る一方、
// 各所から多数のマーカーが参照される点は変わらないため、実体は Hud ではなく Game が持つ
// (game.ts の markerManager フィールド)。Hud は DOM 構築で得た root/svgOverlay を
// 公開するのみで、マーカーの内容には関与しない。
//
// 内部構成:
//   - hud/dom.ts  … 静的 DOM/スタイル構築
//   - hud/panel.ts … ステータスパネル同期(panels として公開)
import { ACCENT, TEXT as INK, TEXT_DIM as INK_SOFT } from '../theme';
import { Frame } from '../../physics/frame';
import { buildHudDom } from './dom';
import { HudPanels } from './panel';
import { fmtDist, fmtTime } from './utils';

export class Hud {
  private els: Map<string, HTMLElement>;
  readonly root: HTMLElement;
  readonly svgOverlay: SVGSVGElement;
  readonly panels: HudPanels;
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
  onFrameSelect: ((frame: Frame) => void) | null = null;
  onMapFocusSelect: ((focus: string) => void) | null = null;
  onMapViewReset: (() => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;

  constructor() {
    const { root, svgOverlay, els } = buildHudDom(this);
    this.root = root;
    this.svgOverlay = svgOverlay;
    this.els = els;
    this.panels = new HudPanels(els);
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
  // frame: 選択中の表示座標系('inertial'|'sunRotating')。sliderT: スライダー位置(0..1、変更なしなら省略)。
  // sliderLabel: スライダーが 0 より大きいときに表示するラベル(T+ 表記・高度など)。
  setMapToolbarState(
    durationKey: string,
    frame: string,
    sliderLabel: string | null,
    focus: string = 'earth',
  ): void {
    const bar = document.getElementById('hud-maptool');
    if (!bar) return;
    bar.querySelectorAll<HTMLElement>('.mt-btn[data-dur]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['dur'] === durationKey);
    });
    bar.querySelectorAll<HTMLElement>('.mt-btn[data-frame]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['frame'] === frame);
    });
    bar.querySelectorAll<HTMLElement>('.mt-btn[data-focus]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['focus'] === focus);
    });
    const lbl = bar.querySelector<HTMLElement>('[data-id="mt-sliderlabel"]');
    if (lbl) lbl.textContent = sliderLabel ?? 'スライダーで未来位置を確認';
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
