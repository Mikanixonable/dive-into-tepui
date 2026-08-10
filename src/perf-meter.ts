import { EDGE, TEXT } from './game/theme';

export interface PerfCountSource {
  perfCounts(): {
    enemies: number; bullets: number; casings: number; debris: number;
    predicted: number; predictComplete: number; predictDiscarded: number;
    mapMode: boolean; mapItems: number; mapLabels: number;
    simSubsteps: number; gravitySources: number; predictorSteps: number;
  };
}

interface PhaseStats {
  sum: number;
  max: number;
  samples: number[];
}

function newPhaseStats(): PhaseStats {
  return { sum: 0, max: 0, samples: [] };
}

export class PerfMeter {
  readonly on: boolean;
  private readonly el: HTMLDivElement | null;
  private readonly updateStats = newPhaseStats();
  private readonly syncStats = newPhaseStats();
  private readonly renderStats = newPhaseStats();
  private frames = 0;
  private lastFlush = performance.now();

  // URL の ?perf=1 が付いていれば計測用DOM要素を作る。
  constructor(private readonly counts: PerfCountSource) {
    this.on = new URLSearchParams(location.search).get('perf') === '1';
    this.el = this.on ? this.createElement() : null;
  }

  // このフレームの update/sync/render 所要時間を積算し、表示更新のタイミングなら flush する。
  // 計測表示を有効にした時だけ呼ばれるので、通常プレイにはサンプル配列の費用を持ち込まない。
  record(updateMs: number, syncMs: number, renderMs: number, now: number): void {
    this.addSample(this.updateStats, updateMs);
    this.addSample(this.syncStats, syncMs);
    this.addSample(this.renderStats, renderMs);
    this.frames++;
    this.flush(now);
  }

  private addSample(stats: PhaseStats, value: number): void {
    stats.sum += value;
    stats.max = Math.max(stats.max, value);
    stats.samples.push(value);
  }

  private phaseText(label: string, stats: PhaseStats, frames: number): string {
    const sorted = [...stats.samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    return `${label} ${(stats.sum / frames).toFixed(2)}/${p95.toFixed(2)}/${stats.max.toFixed(2)}ms`;
  }

  private resetStats(stats: PhaseStats): void {
    stats.sum = 0;
    stats.max = 0;
    stats.samples.length = 0;
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
      `${this.phaseText('update', this.updateStats, n)} avg/p95/max  ` +
      `${this.phaseText('sync', this.syncStats, n)} avg/p95/max\n` +
      `${this.phaseText('render', this.renderStats, n)} avg/p95/max\n` +
      `enemies ${c.enemies}  bullets ${c.bullets}  casings ${c.casings}  debris ${c.debris}\n` +
      `map ${c.mapMode ? 'on' : 'off'} items ${c.mapItems} labels ${c.mapLabels}  ` +
      `substeps ${c.simSubsteps} sources ${c.gravitySources}  predictSteps ${c.predictorSteps}\n` +
      `predict ${c.predictComplete}/${c.predicted}  discard ${c.predictDiscarded}` +
      (mem ? `\nheap ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '');
    // 次の集計期間へ向けてリセットする
    this.resetStats(this.updateStats);
    this.resetStats(this.syncStats);
    this.resetStats(this.renderStats);
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
