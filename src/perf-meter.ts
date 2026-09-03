// 負荷確認ウィンドウ: フレーム時間の計測・集計と、その表示、そして描画パスの中間結果を映す
// デバッグ表示の選択。窓が開いている間だけ計測が走る(`on` が計測の可否そのもの)。
import type { WebGPURenderer } from 'three/webgpu';
import { PropertyRow, PropertyWindow } from './game/hud/windows/property-window';
import { SegmentedControl } from './game/hud/widgets';
import { DEBUG_TARGETS, type DebugTargetHost, type DebugTargetId } from './render/pipeline/debug-target';
import type { RenderStyleSetting } from './render/render-style';
import { fmtDuration } from './game/hud/utils';
import { FrameSections, SECTION_COUNT, SECTION_LABELS, type SectionId } from './frame-sections';
import { GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings, type GpuPassId } from './gpu-timings';
import type { OverlayManager } from './game/hud/overlay-manager';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { ProteinMotionMetricsRecorder, PROTEIN_MOTION_LODS, type ProteinMotionFrameSample } from './protein-motion-metrics';

// 計測表示に載せるエンティティ数・シミュレーション規模の一式。
export type PerfCounts = {
  players: number; enemies: number; bullets: number; casings: number;
  debris: number; ammoPickups: number; rcsFuelPickups: number; bases: number;
  predicted: number; predictComplete: number; predictorSteps: number;
  arcCelestialBodies: number; arcRevisits: number; arcLead: number | null;
  mapMode: boolean; mapItems: number; mapLabels: number; displayDurationSec: number;
  simSubsteps: number; simIntegrated: number; simFollowed: number; gravitySources: number;
  planArcs: number; planSteps: number;
  timeCacheHits: number; timeCacheMisses: number;
  warp: number;
};

interface PerfCountSource {
  perfCounts(): PerfCounts;
  proteinMotionFrameSample(): ProteinMotionFrameSample;
}

// フレームごとに数え直される項目。集計期間の1フレームだけを覗くと実態を取り違えるので、
// ms系と同じく毎フレーム積んで avg/max で出す。
const RATE_COUNTS: readonly { key: string; label: string; group: string; read: (c: PerfCounts) => number }[] = [
  { key: 'plan-arcs', label: '再生成区間', group: '計画軌道', read: (c) => c.planArcs },
  { key: 'plan-steps', label: '積分step', group: '計画軌道', read: (c) => c.planSteps },
  { key: 'pred-tracked', label: 'tracked', group: '予測', read: (c) => c.predicted },
  { key: 'pred-complete', label: 'complete', group: '予測', read: (c) => c.predictComplete },
  { key: 'pred-steps', label: 'steps', group: '予測', read: (c) => c.predictorSteps },
  { key: 'arc-celestial-bodies', label: '解決天体', group: '予測', read: (c) => c.arcCelestialBodies },
  { key: 'arc-revisits', label: '期限訪問', group: '予測', read: (c) => c.arcRevisits },
  { key: 'sim-substeps', label: 'substeps', group: 'シミュレーション', read: (c) => c.simSubsteps },
  { key: 'sim-integrated', label: '積分', group: 'シミュレーション', read: (c) => c.simIntegrated },
  { key: 'sim-followed', label: '予測消費', group: 'シミュレーション', read: (c) => c.simFollowed },
  { key: 'sim-sources', label: '重力源', group: 'シミュレーション', read: (c) => c.gravitySources },
];

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
  private readonly drawCallStats = newPhaseStats();
  private readonly triangleStats = newPhaseStats();
  // update の区間ごとの統計。末尾は区間外へ落ちた時間(その他)。
  private readonly sectionStats = Array.from({ length: SECTION_COUNT + 1 }, newPhaseStats);
  // 描画パスごとの GPU 時間の統計。
  private readonly gpuStats = Array.from({ length: GPU_PASS_COUNT }, newPhaseStats);
  // 個数系の統計。RATE_COUNTS と添字で対応する。
  private readonly rateStats = Array.from({ length: RATE_COUNTS.length }, newPhaseStats);
  private frames = 0;
  private lastFlush = performance.now();
  // 前回フラッシュ時点の暦キャッシュ累計。表示する集計期間分の差分を取るために持つ。
  private lastTimeHits = 0;
  private lastTimeMisses = 0;
  // 直近フラッシュで組んだ行。窓を開き直したときに空の窓を出さないために持つ。
  private rows: readonly PropertyRow[] = [];
  // デバッグ表示の選択欄。窓へ載せ替えるだけなので、開閉をまたいで同じものを使い回す。
  private readonly debugTarget: SegmentedControl<DebugTargetId>;
  private readonly proteinMotion = new ProteinMotionMetricsRecorder();

  // 計測が走っているか。窓が開いている間だけ真になる。
  get on(): boolean { return this.win !== null; }

  // デバッグ表示は模式図スタイルでは選べない(DEVELOP/SPEC/RENDERING.md)ので、renderStyle の
  // 変化に合わせて選択欄の有効/無効を切り替える。?perf=1 が付いていれば起動直後から窓を開く。
  constructor(
    private readonly root: HTMLElement,
    private readonly renderer: WebGPURenderer,
    private readonly sections: FrameSections,
    private readonly gpu: GpuTimings,
    private readonly overlayManager: OverlayManager,
    private readonly debugTargetHost: DebugTargetHost,
    renderStyle: RenderStyleSetting,
  ) {
    this.debugTarget = new SegmentedControl('デバッグ表示', DEBUG_TARGETS, (id) => {
      this.debugTargetHost.debugTarget = id;
      this.debugTarget.setSelected(id);
    });
    renderStyle.subscribe((style) => this.debugTarget.setEnabled(style !== 'schematic'));
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
    this.resetStats(this.drawCallStats);
    this.resetStats(this.triangleStats);
    for (const s of this.sectionStats) this.resetStats(s);
    for (const s of this.gpuStats) this.resetStats(s);
    for (const s of this.rateStats) this.resetStats(s);
    this.proteinMotion.reset();
    this.sections.enabled = true;
    this.gpu.enabled = true;
    this.frames = 0;
    this.lastFlush = performance.now();
    this.win = new PropertyWindow(this.root, DEFAULT_X, DEFAULT_Y, {
      title: '負荷',
      rows: this.rows,
      items: [],
    }, this.overlayManager);
    this.win.onClose = () => {
      this.win = null;
      this.sections.enabled = false;
      this.gpu.enabled = false;
    };
    // 選択は窓を閉じている間も pipeline 側に残るので、開くたびにそちらから引き直す。
    this.debugTarget.setSelected(this.debugTargetHost.debugTarget);
    this.win.setControls(this.debugTarget.element);
  }

  // 窓を閉じ、計測も止める。
  close(): void {
    this.win?.dispose();
    this.win = null;
    this.sections.enabled = false;
    this.gpu.enabled = false;
  }

  // 開閉を反転する。
  toggle(): void {
    if (this.win) this.close();
    else this.open();
  }

  // [F3] を消費して開閉を反転する。
  handleInput(input: Input): void {
    if (input.takeKey(K.togglePerfWindow)) this.toggle();
  }

  // このフレームの update/sync/render 所要時間と、フレームごとに数え直される個数系の値を積算し、
  // 表示更新のタイミングなら flush する。counts は同じフレームで計測対象になっていた Game 自身が渡す。
  record(counts: PerfCountSource, updateMs: number, syncMs: number, renderMs: number, now: number): void {
    this.addSample(this.updateStats, updateMs);
    this.addSample(this.syncStats, syncMs);
    this.addSample(this.renderStats, renderMs);
    // WebGPURenderer.info.render は autoReset によりフレームごとに 0 へ戻るので、
    // このフレームの render() 呼び出し直後の値がそのままこのフレームの計測値になる。
    this.addSample(this.drawCallStats, this.renderer.info.render.drawCalls);
    this.addSample(this.triangleStats, this.renderer.info.render.triangles);
    for (const [i, stats] of this.sectionStats.entries()) {
      this.addSample(stats, i < SECTION_COUNT ? this.sections.msOf(i as SectionId) : this.sections.otherMs());
    }
    for (const [i, stats] of this.gpuStats.entries()) this.addSample(stats, this.gpu.msOf(i as GpuPassId));
    const c = counts.perfCounts();
    for (const [i, stats] of this.rateStats.entries()) this.addSample(stats, RATE_COUNTS[i]!.read(c));
    this.proteinMotion.record(counts.proteinMotionFrameSample());
    this.frames++;
    this.flush(c, now);
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

  // 個数系の統計1つ分の avg/max 行。
  private countRow(key: string, label: string, group: string, stats: PhaseStats, frames: number): PropertyRow {
    return { key, label, group, value: `avg ${Math.round(stats.sum / frames)} max ${Math.round(stats.max)}` };
  }

  // 500ms ごとに蓄積した計測値から表示行を組み、窓へ反映する。
  private flush(counts: PerfCounts, now: number): void {
    if (!this.win || now - this.lastFlush < 500) return;
    const n = Math.max(1, this.frames);
    this.rows = this.buildRows(counts, n, now - this.lastFlush);
    this.win.syncRows(this.rows);
    // 次の集計期間へ向けてリセットする
    this.resetStats(this.updateStats);
    this.resetStats(this.syncStats);
    this.resetStats(this.renderStats);
    this.resetStats(this.drawCallStats);
    this.resetStats(this.triangleStats);
    for (const s of this.sectionStats) this.resetStats(s);
    for (const s of this.gpuStats) this.resetStats(s);
    for (const s of this.rateStats) this.resetStats(s);
    this.proteinMotion.reset();
    this.frames = 0;
    this.lastFlush = now;
  }

  // update の区間1つ分の平均・最大の行。通らなかった区間も 0.0ms として出す。
  private sectionRow(index: number, stats: PhaseStats, frames: number): PropertyRow {
    const label = SECTION_LABELS[index] ?? 'その他';
    return {
      key: `usec-${index}`, label, group: 'update内訳',
      value: `${barText(stats.sum / frames)} max ${stats.max.toFixed(1)}`,
    };
  }

  // 描画パス1つ分の GPU 時間の行。時刻印がまだ届いていない間は取得中と出す。
  private gpuPassRow(index: number, stats: PhaseStats, frames: number): PropertyRow {
    const label = `GPU ${GPU_PASS_LABELS[index] ?? index}`;
    if (!this.gpu.supported) return { key: `gpu-${index}`, label, group: '描画', value: '未対応' };
    return {
      key: `gpu-${index}`, label, group: '描画',
      value: `${barText(stats.sum / frames)} max ${stats.max.toFixed(1)}`,
    };
  }

  // 集計期間 elapsedMs / frames 本のフレームから、窓に並べる行一式を組む。
  private buildRows(c: PerfCounts, frames: number, elapsedMs: number): readonly PropertyRow[] {
    const totals = this.updateStats.samples.map(
      (v, i) => v + (this.syncStats.samples[i] ?? 0) + (this.renderStats.samples[i] ?? 0),
    );
    const totalAvg = totals.reduce((a, b) => a + b, 0) / frames;
    const totalSorted = [...totals].sort((a, b) => a - b);
    // 暦キャッシュは累計値なので、この集計期間に増えた分だけを見せる
    const timeHits = c.timeCacheHits - this.lastTimeHits;
    const timeMisses = c.timeCacheMisses - this.lastTimeMisses;
    this.lastTimeHits = c.timeCacheHits;
    this.lastTimeMisses = c.timeCacheMisses;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const proteinSummary = this.proteinMotion.summary();

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

      ...this.sectionStats.map((s, i) => this.sectionRow(i, s, frames)),

      ...this.gpuStats.map((s, i) => this.gpuPassRow(i, s, frames)),
      this.countRow('draw-calls', 'draw calls', '描画', this.drawCallStats, frames),
      this.countRow('draw-tris', 'triangles', '描画', this.triangleStats, frames),

      ...RATE_COUNTS.map((r, i) => this.countRow(r.key, r.label, r.group, this.rateStats[i]!, frames)),
      { key: 'arc-lead', label: '先端余裕', group: '予測', value: c.arcLead === null ? '—' : `${c.arcLead.toFixed(0)}s` },

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
      { key: 'ent-ammo-pickups', label: 'ammoPickups', value: `${c.ammoPickups}`, group: 'エンティティ' },
      { key: 'ent-rcs-fuel-pickups', label: 'rcsFuelPickups', value: `${c.rcsFuelPickups}`, group: 'エンティティ' },
      { key: 'ent-bases', label: 'bases', value: `${c.bases}`, group: 'エンティティ' },

      { key: 'heap', label: 'JS heap', group: 'メモリ',
        value: mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '--' },

      {
        key: 'protein-motion-cpu', label: 'Motion CPU', group: 'タンパク質モーション',
        value: `${barText(proteinSummary.cpuMs.avg)} p95 ${proteinSummary.cpuMs.p95.toFixed(2)} max ${proteinSummary.cpuMs.max.toFixed(2)}`,
      },
      {
        key: 'protein-motion-upload', label: 'Upload', group: 'タンパク質モーション',
        value: `avg ${(proteinSummary.uploadBytes.avg / 1024).toFixed(1)}KiB max ${(proteinSummary.uploadBytes.max / 1024).toFixed(1)}KiB`,
      },
      ...PROTEIN_MOTION_LODS.map((lod) => ({
        key: `protein-motion-lod-${lod}`, label: lod, group: 'タンパク質モーション',
        value: `${proteinSummary.lodCounts[lod].toFixed(1)}`,
      })),
    ];
  }
}
