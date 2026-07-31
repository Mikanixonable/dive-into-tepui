import { EDGE, TEXT } from './game/theme';

export interface PerfCountSource {
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number };
}

export class PerfMeter {
  readonly on: boolean;
  private readonly el: HTMLDivElement | null;
  private simMs = 0;
  private renderMs = 0;
  private frames = 0;
  private lastFlush = performance.now();

  // URL の ?perf=1 が付いていれば計測用DOM要素を作る。
  constructor(private readonly counts: PerfCountSource) {
    this.on = new URLSearchParams(location.search).get('perf') === '1';
    this.el = this.on ? this.createElement() : null;
  }

  // このフレームの update/render 所要時間を積算し、表示更新のタイミングなら flush する。
  record(simMs: number, renderMs: number, now: number): void {
    this.simMs += simMs;
    this.renderMs += renderMs;
    this.frames++;
    this.flush(now);
  }

  // 500ms ごとに蓄積した計測値から fps・処理時間・エンティティ数を表示へ反映する。
  private flush(now: number): void {
    if (!this.el || now - this.lastFlush < 500) return;
    // 集計期間内の平均値・ヒープ使用量を求める
    const n = Math.max(1, this.frames);
    const c = this.counts.perfCounts();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    // 表示テキストへまとめる
    this.el.textContent =
      `fps ${((n * 1000) / (now - this.lastFlush)).toFixed(0)}  ` +
      `sim ${(this.simMs / n).toFixed(2)}ms  render ${(this.renderMs / n).toFixed(2)}ms\n` +
      `enemies ${c.enemies}  bullets ${c.bullets}  casings ${c.casings}  debris ${c.debris}` +
      (mem ? `\nheap ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '');
    // 次の集計期間へ向けてリセットする
    this.simMs = 0;
    this.renderMs = 0;
    this.frames = 0;
    this.lastFlush = now;
  }

  // 計測結果を表示する固定位置のDOM要素を作り body へ追加する。
  private createElement(): HTMLDivElement {
    const perfEl = document.createElement('div');
    perfEl.style.cssText =
      `position:fixed;left:8px;top:8px;z-index:2000;pointer-events:none;` +
      `font:11px Consolas,monospace;color:${TEXT};background:rgba(0,0,0,0.55);` +
      `border:1px solid ${EDGE};border-radius:3px;padding:4px 8px;white-space:pre;line-height:1.5`;
    document.body.appendChild(perfEl);
    return perfEl;
  }
}
