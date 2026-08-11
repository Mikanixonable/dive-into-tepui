// 負荷確認ウィンドウ: フレーム時間の計測・集計と、その表示。
// 窓が開いている間だけ計測が走る(`on` が計測の可否そのもの)。
import { PropertyRow, PropertyWindow } from './game/hud/property-window';
import { fmtDuration } from './game/hud/utils';

// 計測表示に載せるエンティティ数・シミュレーション規模の一式。
export type PerfCounts = {
  players: number; enemies: number; bullets: number; casings: number;
  debris: number; ammos: number; asteroids: number; bases: number;
  predicted: number; predictComplete: number; predictDiscarded: number; predictorSteps: number;
  mapMode: boolean; mapItems: number; mapLabels: number; displayDurationSec: number;
  simSubsteps: number; orbitSteps: number; gravitySources: number;
  planArcs: number; planSteps: number;
  attractorsCacheHits: number; attractorsCacheMisses: number;
  timeCacheHits: number; timeCacheMisses: number;
  warp: number;
};

export interface PerfCountSource {
  perfCounts(): PerfCounts;
}

interface PhaseStats {
  sum: number;
  max: number;
  samples: number[];
}

function newPhaseStats(): PhaseStats {
  return { sum: 0, max: 0, samples: [] };
}

// 塗り文字の横棒が満杯になる所要時間 [ms](60fps の 1 フレーム)。
const BUDGET_MS = 16.7;
const BAR_CELLS = 8;

// 窓を開く既定位置 [px]。マップビューの左ドック(left 12px + 幅 300px まで)の右隣。
const DEFAULT_X = 324;
const DEFAULT_Y = 12;

// 所要時間を「████░░░░ 12.3ms」の形にする。
function barText(ms: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((ms / BUDGET_MS) * BAR_CELLS)));
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${ms.toFixed(1)}ms`;
}

// 昇順に並べた標本から百分位値を取る。標本が空なら 0。
function percentile(sorted: readonly number[], ratio: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[i] ?? 0;
}

export class PerfMeter {
  private win: PropertyWindow | null = null;
  private readonly updateStats = newPhaseStats();
  private readonly syncStats = newPhaseStats();
  private readonly renderStats = newPhaseStats();
  private frames = 0;
  private lastFlush = performance.now();
  // 前回フラッシュ時点の暦キャッシュ累計。表示する集計期間分の差分を取るために持つ。
  private lastAttractorsHits = 0;
  private lastAttractorsMisses = 0;
  private lastTimeHits = 0;
  private lastTimeMisses = 0;
  // 直近フラッシュで組んだ行。窓を開き直したときに空の窓を出さないために持つ。
  private rows: readonly PropertyRow[] = [];

  // 計測が走っているか。窓が開いている間だけ真になる。
  get on(): boolean { return this.win !== null; }

  // ?perf=1 が付いていれば起動直後から窓を開く。
  constructor(private readonly counts: PerfCountSource, private readonly root: HTMLElement) {
    if (new URLSearchParams(location.search).get('perf') === '1') this.open();
  }

  // 負荷確認ウィンドウを開く。既に開いていれば手前へ出すだけ。
  open(): void {
    if (this.win) {
      this.win.bringToFront();
      return;
    }
    // 閉じている間は計測が止まっているので、集計期間はここから数え直す。
    this.resetStats(this.updateStats);
    this.resetStats(this.syncStats);
    this.resetStats(this.renderStats);
    this.frames = 0;
    this.lastFlush = performance.now();
    this.win = new PropertyWindow(this.root, DEFAULT_X, DEFAULT_Y, {
      title: '負荷',
      rows: this.rows,
      items: [],
    });
    this.win.onClose = () => { this.win = null; };
  }

  // 窓を閉じ、計測も止める。
  close(): void {
    this.win?.dispose();
    this.win = null;
  }

  // 開閉を反転する。
  toggle(): void {
    if (this.win) this.close();
    else this.open();
  }

  // このフレームの update/sync/render 所要時間を積算し、表示更新のタイミングなら flush する。
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

  private resetStats(stats: PhaseStats): void {
    stats.sum = 0;
    stats.max = 0;
    stats.samples.length = 0;
  }

  // フェーズ1つ分の avg/p95/max 行。
  private phaseRow(key: string, label: string, stats: PhaseStats, frames: number): PropertyRow {
    const sorted = [...stats.samples].sort((a, b) => a - b);
    const avg = stats.sum / frames;
    return {
      key, label, group: 'フレーム時間',
      value: `${barText(avg)} p95 ${percentile(sorted, 0.95).toFixed(1)} max ${stats.max.toFixed(1)}`,
    };
  }

  // 500ms ごとに蓄積した計測値から表示行を組み、窓へ反映する。
  private flush(now: number): void {
    if (!this.win || now - this.lastFlush < 500) return;
    const n = Math.max(1, this.frames);
    const c = this.counts.perfCounts();
    this.rows = this.buildRows(c, n, now - this.lastFlush);
    this.win.syncRows(this.rows);
    // 次の集計期間へ向けてリセットする
    this.resetStats(this.updateStats);
    this.resetStats(this.syncStats);
    this.resetStats(this.renderStats);
    this.frames = 0;
    this.lastFlush = now;
  }

  // 集計期間 elapsedMs / frames 本のフレームから、窓に並べる行一式を組む。
  private buildRows(c: PerfCounts, frames: number, elapsedMs: number): readonly PropertyRow[] {
    const totals = this.updateStats.samples.map(
      (v, i) => v + (this.syncStats.samples[i] ?? 0) + (this.renderStats.samples[i] ?? 0),
    );
    const totalAvg = totals.reduce((a, b) => a + b, 0) / frames;
    const totalSorted = [...totals].sort((a, b) => a - b);
    // 暦キャッシュは累計値なので、この集計期間に増えた分だけを見せる
    const attrHits = c.attractorsCacheHits - this.lastAttractorsHits;
    const attrMisses = c.attractorsCacheMisses - this.lastAttractorsMisses;
    const timeHits = c.timeCacheHits - this.lastTimeHits;
    const timeMisses = c.timeCacheMisses - this.lastTimeMisses;
    this.lastAttractorsHits = c.attractorsCacheHits;
    this.lastAttractorsMisses = c.attractorsCacheMisses;
    this.lastTimeHits = c.timeCacheHits;
    this.lastTimeMisses = c.timeCacheMisses;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

    return [
      { key: 'fps', label: 'fps', value: ((frames * 1000) / elapsedMs).toFixed(0) },
      {
        key: 'frame', label: 'frame',
        value: `${barText(totalAvg)} p95 ${percentile(totalSorted, 0.95).toFixed(1)}`,
      },
      { key: 'warp', label: 'warp', value: `×${c.warp}` },

      this.phaseRow('update', 'update', this.updateStats, frames),
      this.phaseRow('sync', 'sync', this.syncStats, frames),
      this.phaseRow('render', 'render', this.renderStats, frames),

      { key: 'plan-arcs', label: '再積分区間', value: `${c.planArcs}`, group: '計画軌道' },
      { key: 'plan-steps', label: '積分step', value: `${c.planSteps}`, group: '計画軌道' },

      { key: 'pred-tracked', label: 'tracked', value: `${c.predicted}`, group: '予測' },
      { key: 'pred-complete', label: 'complete', value: `${c.predictComplete}`, group: '予測' },
      { key: 'pred-discard', label: 'discard', value: `${c.predictDiscarded}`, group: '予測' },
      { key: 'pred-steps', label: 'steps', value: `${c.predictorSteps}`, group: '予測' },

      { key: 'sim-substeps', label: 'substeps', value: `${c.simSubsteps}`, group: 'シミュレーション' },
      { key: 'sim-orbit', label: '軌道積分', value: `${c.orbitSteps}`, group: 'シミュレーション' },
      { key: 'sim-sources', label: '重力源', value: `${c.gravitySources}`, group: 'シミュレーション' },

      { key: 'eph-attr', label: 'attractorsAt', value: `hit ${attrHits} / miss ${attrMisses}`, group: '暦キャッシュ' },
      { key: 'eph-all', label: '全リング', value: `hit ${timeHits} / miss ${timeMisses}`, group: '暦キャッシュ' },

      { key: 'view', label: 'view', value: c.mapMode ? 'map' : 'combat', group: '表示' },
      { key: 'view-pickables', label: 'pickables', value: `${c.mapItems}`, group: '表示' },
      { key: 'view-labels', label: 'labels', value: `${c.mapLabels}`, group: '表示' },
      {
        key: 'view-duration', label: '表示期間', group: '表示',
        value: fmtDuration(c.displayDurationSec, c.displayDurationSec),
      },

      { key: 'ent-players', label: 'players', value: `${c.players}`, group: 'エンティティ' },
      { key: 'ent-enemies', label: 'enemies', value: `${c.enemies}`, group: 'エンティティ' },
      { key: 'ent-bullets', label: 'bullets', value: `${c.bullets}`, group: 'エンティティ' },
      { key: 'ent-casings', label: 'casings', value: `${c.casings}`, group: 'エンティティ' },
      { key: 'ent-debris', label: 'debris', value: `${c.debris}`, group: 'エンティティ' },
      { key: 'ent-ammos', label: 'ammos', value: `${c.ammos}`, group: 'エンティティ' },
      { key: 'ent-asteroids', label: 'asteroids', value: `${c.asteroids}`, group: 'エンティティ' },
      { key: 'ent-bases', label: 'bases', value: `${c.bases}`, group: 'エンティティ' },

      { key: 'heap', label: 'JS heap', group: 'メモリ',
        value: mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '--' },
    ];
  }
}
