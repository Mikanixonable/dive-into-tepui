// 軌道分析パネル: 操作対象の未来の軌道を「高度」「接近」「投影」の3タブでグラフ表示する
// ドラッグ可能ウィンドウ。タブ・スケール入力欄を組み立て、比較対象(接近・投影タブの
// ターゲット)を解決・保持し、orbit-analysis-data.ts へ問い合わせた点列を
// OrbitChart/OrbitProjectionChart へ渡す。ドラッグ・ホイール・ピンチ操作は PointerPanZoom が
// 変換した値を、選択中タブのスケール・平行移動量へ反映する。
import { CelestialMotion } from '../../../physics/celestial-motion';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import { SyncThrottle } from '../sync-throttle';
import { DraggableWindow } from '../windows/draggable-window';
import { ChartAxis, ChartMark, ChartPoint, ChartSpec, OrbitChart } from './orbit-chart';
import { distanceAxis, timeAxis } from './orbit-chart-axes';
import { OrbitProjectionTab, projectionTextureUrl } from './orbit-projection-tab';
import { altitudeSeries, approachSeries, ApproachTargetSource } from './orbit-analysis-data';
import { MQ_COMPACT } from '../breakpoints';
import { Button, TabBar, ValueInput } from '../widgets';
import { PointerPanZoom } from '../widgets/pointer-pan-zoom';
import type { OverlayManager } from '../overlay-manager';

export type AnalysisTab = 'altitude' | 'approach' | 'projection';

const SYNC_INTERVAL_MS = 250;
const MAX_TICKS = 6;
const SAMPLE_PX_PER_POINT = 2.5;
const MIN_SAMPLES = 20;
const MAX_SAMPLES = 300;
// 接近タブは横軸が距離なので、どこまで先を描くかは横軸のスケールからは決まらない。低軌道の
// 数周ぶんに相当する 1 日を先まで見る。
const APPROACH_SAMPLE_SPAN_SEC = 86400;
// 接近タブは1日ぶんを描くため、高度タブと同じ密度では周回1つあたりの点が粗く、折れ線が
// 角ばって見える。密度を底上げする倍率。
const APPROACH_SAMPLE_MULTIPLIER = 4;
const SCALE_MIN_KM = 1;
const SCALE_MAX_KM = 1_000_000;

const TAB_LABELS: Readonly<Record<AnalysisTab, string>> = { altitude: '高度', approach: '接近', projection: '投影' };

// TabBar へ渡す選択肢。高度タブは常に選べ、接近・投影タブは条件が整ったときだけ加える。
function tabItems(approachAvailable: boolean, projectionAvailable: boolean): readonly (readonly [AnalysisTab, string])[] {
  const tabs: AnalysisTab[] = ['altitude'];
  if (approachAvailable) tabs.push('approach');
  if (projectionAvailable) tabs.push('projection');
  return tabs.map((tab) => [tab, TAB_LABELS[tab]] as const);
}

// 縦軸・横軸のスケール入力欄を持つタブ。投影タブはパン・ズームで表示範囲を操作する。
type ScaleTab = 'altitude' | 'approach';

// tab がスケール入力欄を持つタブかどうかを判定する型ガード。
function isScaleTab(tab: AnalysisTab): tab is ScaleTab {
  return tab === 'altitude' || tab === 'approach';
}

interface TabScale { yKm: number; x: number }

const DEFAULT_SCALES: Readonly<Record<ScaleTab, TabScale>> = {
  altitude: { yKm: 1000, x: 10 },
  approach: { yKm: 1000, x: 1000 },
};

const STYLE = `
#hud .dg-window.orbit-analysis { max-width: 420px; }
@media ${MQ_COMPACT} {
  #hud .dg-window.orbit-analysis { max-width: 100%; }
}
#hud .orbit-analysis-relinc {
  display: flex; justify-content: space-between; padding: var(--space-2) 0; color: var(--text);
}
#hud .orbit-analysis-relinc-label { opacity: 0.7; }
#hud .orbit-analysis-scales { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-3); }
#hud .orbit-analysis-scale { display: flex; align-items: center; gap: var(--space-2); }
#hud .orbit-analysis-scale-label { color: var(--text-dim); font-size: var(--font-xs); }
#hud .orbit-analysis-scale-unit { color: var(--text-dim); font-size: var(--font-xs); }
#hud .orbit-analysis-scale .w-input { width: 64px; }
#hud .orbit-analysis-reset { margin-left: auto; }
`;

let styleInjected = false;

// STYLE を document.head へ一度だけ注入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export class OrbitAnalysisWindow {
  private readonly win: DraggableWindow;
  private readonly tabBar: TabBar<AnalysisTab>;
  private readonly chart = new OrbitChart();
  private readonly projectionTab = new OrbitProjectionTab();
  private readonly relIncRow: HTMLElement;
  private readonly relIncValue: HTMLElement;
  private readonly scalesRow: HTMLElement;
  private readonly yField: HTMLElement;
  private readonly xField: HTMLElement;
  private readonly yInput: ValueInput;
  private readonly xInput: ValueInput;
  private readonly xUnitEl: HTMLElement;
  private tab: AnalysisTab = 'altitude';
  private approachAvailable = false;
  private projectionAvailable = false;
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // 縦軸(高度)の中心 [m]。null なら次の sync で現在高度に固定し直す。
  private altitudeCenterM: number | null = null;
  // 戦闘ビューでも未来の弧を伸ばし続けさせるため analysisPanelReader を立てている個体
  // (操作対象・接近/投影タブのターゲット)。
  private readerEntity: DynamicEntity | null = null;
  private readerTargetEntity: DynamicEntity | null = null;
  private readonly scales: Record<ScaleTab, TabScale> = {
    altitude: { ...DEFAULT_SCALES.altitude },
    approach: { ...DEFAULT_SCALES.approach },
  };
  // 接近タブのドラッグでの平行移動 [m]。ズーム(ホイール/ピンチ)は scales.approach を
  // 直接書き換える(入力欄と同じ状態)。リセットボタンはこの2つだけを戻す。
  private readonly approachPan = { x: 0, y: 0 };
  private approachBaselineScale: TabScale = { ...DEFAULT_SCALES.approach };
  // 高度タブは縦軸(高度)だけがドラッグ・ホイールの対象——横軸(経過時間)は現在時刻を
  // 基準とした固定の軸で、平行移動すると「現在」の意味を失うため入力欄でのみ変更できる。
  private altitudeYBaselineKm: number = DEFAULT_SCALES.altitude.yKm;
  private resetBtn!: Button;

  // ESC・外側クリック・✕ ボタンのどの経路で閉じても発火する。
  public onClose: (() => void) | null = null;

  // ウィンドウ・タブバー・2枚のチャート(高度/接近用・投影用)・相対傾斜角の表示行・
  // スケール入力欄を組み立てる。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number,
    overlayManager: OverlayManager, tempWindowGroup: string,
  ) {
    ensureStyle();
    this.win = new DraggableWindow(
      root, clientX, clientY, { title: '軌道分析', initiallyClipped: true, tempWindowGroup }, overlayManager,
    );
    this.win.element.classList.add('orbit-analysis');
    this.win.onClose = () => this.onClose?.();

    // タブと、高度/接近タブ用・投影タブ用の2枚のチャートを積む(同時に見えるのは1枚だけ)。
    this.tabBar = new TabBar<AnalysisTab>(tabItems(false, false), (tab) => this.selectTab(tab));
    this.win.body.appendChild(this.tabBar.element);
    this.win.body.appendChild(this.chart.element);
    this.chart.element.classList.add('panzoom');
    new PointerPanZoom(this.chart.element, (dx, dy) => this.applyPan(dx, dy), (wd) => this.applyZoom(wd));
    this.win.body.appendChild(this.projectionTab.chart.element);
    this.projectionTab.chart.element.classList.add('hidden', 'panzoom');
    new PointerPanZoom(
      this.projectionTab.chart.element,
      (dx, dy) => this.projectionTab.chart.pan(dx, dy),
      (wd) => this.projectionTab.chart.zoom(wd),
    );

    // 接近タブでのみ表示する相対傾斜角の1行。
    const relIncLabel = document.createElement('span');
    relIncLabel.className = 'orbit-analysis-relinc-label';
    relIncLabel.textContent = '相対傾斜角';
    this.relIncValue = document.createElement('output');
    this.relIncRow = document.createElement('div');
    this.relIncRow.className = 'orbit-analysis-relinc hidden';
    this.relIncRow.appendChild(relIncLabel);
    this.relIncRow.appendChild(this.relIncValue);
    this.win.body.appendChild(this.relIncRow);

    // 縦軸・横軸のスケール入力欄とリセットボタン(投影タブでは hidden にする)。
    this.scalesRow = document.createElement('div');
    this.scalesRow.className = 'orbit-analysis-scales';
    const yField = this.buildScaleField(
      '縦軸', 'km',
      () => (isScaleTab(this.tab) ? this.scales[this.tab].yKm : this.scales.altitude.yKm),
      (v) => { this.commitScale('yKm', v); },
    );
    this.yInput = yField.input;
    this.yField = yField.element;
    this.scalesRow.appendChild(yField.element);
    const xField = this.buildScaleField(
      '横軸', this.xUnitLabel(),
      () => (isScaleTab(this.tab) ? this.scales[this.tab].x : this.scales.altitude.x),
      (v) => { this.commitScale('x', v); },
    );
    this.xInput = xField.input;
    this.xUnitEl = xField.unitEl;
    this.xField = xField.element;
    this.scalesRow.appendChild(xField.element);
    this.resetBtn = new Button('リセット', () => this.resetView());
    this.resetBtn.element.classList.add('orbit-analysis-reset');
    this.scalesRow.appendChild(this.resetBtn.element);
    this.win.body.appendChild(this.scalesRow);

    this.refreshScaleInputs();
  }

  // 呼び出し側から見た「引き上げて最前面へ」— Orbit パネルのボタンが2枚目を開かないために使う。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  // ウィンドウを閉じ、立てていた analysisPanelReader フラグをすべて降ろす。
  public dispose(): void {
    this.setReaderEntity(null);
    this.setReaderTargetEntity(null);
    this.win.dispose();
    this.chart.dispose();
    this.projectionTab.dispose();
  }

  // 旧対象のフラグを降ろし、新対象に立て直す。
  private static applyReader(prev: DynamicEntity | null, next: DynamicEntity | null): DynamicEntity | null {
    if (prev === next) return prev;
    if (prev) prev.analysisPanelReader = false;
    if (next) next.analysisPanelReader = true;
    return next;
  }

  // 操作対象が変わったら analysisPanelReader を付け替え、高度中心を次の sync で固定し直す。
  private setReaderEntity(entity: DynamicEntity | null): void {
    if (entity === this.readerEntity) return;
    this.readerEntity = OrbitAnalysisWindow.applyReader(this.readerEntity, entity);
    this.altitudeCenterM = null;
  }

  // 接近/投影タブのターゲットが変わったら analysisPanelReader を付け替える。
  private setReaderTargetEntity(entity: DynamicEntity | null): void {
    this.readerTargetEntity = OrbitAnalysisWindow.applyReader(this.readerTargetEntity, entity);
  }

  // 操作対象・ターゲットの状態から選択中タブの点列を求め、対応するチャートへ描く。
  public sync(game: Game, celestialBodies: readonly CelestialMotion[]): void {
    if (!this.throttle.due()) return;

    const entity = game.activeControllableEntity;
    this.setReaderEntity(entity);
    if (!entity) {
      this.approachAvailable = false;
      this.projectionAvailable = false;
      this.tabBar.setItems(tabItems(false, false));
      this.chart.draw(this.emptySpec('操作対象がありません'));
      return;
    }

    const reference = game.orbitReference.resolve(
      entity.state.r, celestialBodies, game.navTarget, game.dynamicSystem, game.celestialSystem, entity.state.t,
    );
    const sampleCount = this.sampleCount();

    // 接近タブが選べるかどうかは、航法ターゲットが解決でき、かつ approachSeries が
    // null を返さない(同じ主天体を周回している)かで決まる。
    const approachSource = this.resolveApproachTarget(game, celestialBodies);
    this.setReaderTargetEntity(approachSource?.kind === 'entity' ? approachSource.entity : null);
    const approach = approachSource
      ? approachSeries(
        entity, approachSource, celestialBodies, game.celestialSystem, entity.state.t,
        APPROACH_SAMPLE_SPAN_SEC, sampleCount * APPROACH_SAMPLE_MULTIPLIER,
      )
      : null;
    this.approachAvailable = approach !== null;

    // 投影タブが選べるかどうかは、操作対象の基準天体が円筒図法テクスチャを持つかで決まる。
    const projectionCenter = reference.attractor;
    const textureUrl = projectionCenter ? projectionTextureUrl(game, projectionCenter.id) : null;
    this.projectionAvailable = textureUrl !== null;

    // タブの選択肢を更新し、選択中タブが選べなくなっていたら高度タブへ戻す。
    this.tabBar.setItems(tabItems(this.approachAvailable, this.projectionAvailable));
    if (this.tab === 'approach' && !this.approachAvailable) this.selectTab('altitude');
    if (this.tab === 'projection' && !this.projectionAvailable) this.selectTab('altitude');
    this.tabBar.setSelected(this.tab);

    this.chart.element.classList.toggle('hidden', this.tab === 'projection');
    this.projectionTab.chart.element.classList.toggle('hidden', this.tab !== 'projection');

    // 選択中タブの点列を求め、対応するチャートへ描く。
    if (this.tab === 'altitude') {
      const altitude = altitudeSeries(
        entity, reference, game.celestialSystem, entity.state.t, this.scales.altitude.x * 3600, sampleCount,
      );
      this.chart.draw(this.altitudeSpec(altitude));
    } else if (this.tab === 'approach' && approach) {
      this.chart.draw(this.approachSpec(approach));
      this.relIncValue.textContent = isFinite(approach.relIncDeg) ? `${approach.relIncDeg.toFixed(2)}°` : '---';
    } else if (this.tab === 'projection' && projectionCenter && textureUrl) {
      this.projectionTab.draw(
        game, entity, projectionCenter, approachSource, celestialBodies,
        entity.state.t, game.displayWindowManager.current.duration, sampleCount, textureUrl,
      );
    }
  }

  // タブを切り替え、表示範囲を開いた時点の状態へ戻し、タブごとの表示要素を出し分ける。
  private selectTab(tab: AnalysisTab): void {
    this.tab = tab;
    this.resetView();
    this.tabBar.setSelected(tab);
    this.relIncRow.classList.toggle('hidden', tab !== 'approach');
    this.yField.classList.toggle('hidden', tab === 'projection');
    this.xField.classList.toggle('hidden', tab === 'projection');
  }

  // 選択中タブのドラッグ/ズームを、開いた/タブを選び直した時点の状態(パン0・直近に確定した
  // スケール)へ戻す。高度タブは縦軸(中心・スケール)だけを、接近タブは縦横両方を、投影タブは
  // 全球表示(中心経緯度0・最大縮小)を戻す。
  private resetView(): void {
    if (this.tab === 'altitude') {
      // 縦軸の中心を次の sync で現在高度に固定し直し、スケールを直近の既定値へ戻す。
      this.altitudeCenterM = null;
      this.scales.altitude = { ...this.scales.altitude, yKm: this.altitudeYBaselineKm };
    } else if (this.tab === 'approach') {
      // 平行移動を0へ、スケールを直近の既定値へ戻す。
      this.approachPan.x = 0;
      this.approachPan.y = 0;
      this.scales.approach = { ...this.approachBaselineScale };
    } else {
      // 投影タブは表示範囲の中心・ズームをチャート自身が持つ。
      this.projectionTab.chart.resetView();
    }
    this.refreshScaleInputs();
  }

  // 選択中タブのスケール値・単位を入力欄へ反映する。タブ切替のたびに呼ぶ。投影タブは
  // 入力欄自体を隠すので何もしない。
  private refreshScaleInputs(): void {
    if (this.tab === 'projection') return;
    this.yInput.setValue(String(this.scales[this.tab].yKm));
    this.xInput.setValue(String(this.scales[this.tab].x));
    this.xUnitEl.textContent = this.xUnitLabel();
  }

  // 横軸の単位。高度タブは経過時間(時間)、接近タブは水平距離(km)。
  private xUnitLabel(): string {
    return this.tab === 'altitude' ? 'h' : 'km';
  }

  // 数値入力欄で手入力確定されたスケールを反映する。接近タブでの確定は、リセットで
  // 戻る先(approachBaselineScale)も同時に更新する — 手入力は新しい既定値の指定として扱う。
  private commitScale(field: keyof TabScale, v: number): void {
    if (!isScaleTab(this.tab)) return;
    this.scales[this.tab][field] = v;
    if (this.tab === 'approach') this.approachBaselineScale = { ...this.scales.approach };
    else if (field === 'yKm') this.altitudeYBaselineKm = v;
  }

  // ラベル+ValueInput+単位の1組を作る。非数値・0以下の確定は破棄して getCurrent() の値へ戻す。
  private buildScaleField(
    label: string, unit: string, getCurrent: () => number, onValid: (v: number) => void,
  ): { element: HTMLElement; input: ValueInput; unitEl: HTMLElement } {
    const wrap = document.createElement('div');
    wrap.className = 'orbit-analysis-scale';
    const labelEl = document.createElement('span');
    labelEl.className = 'orbit-analysis-scale-label';
    labelEl.textContent = label;
    wrap.appendChild(labelEl);
    // 確定値が不正なら getCurrent() の値へ戻す。有効なら onValid で反映してから表示を揃える。
    const input = new ValueInput({ type: 'number', step: 1 }, (text) => {
      const v = Number(text);
      if (!isFinite(v) || v <= 0) { input.setValue(String(getCurrent())); return; }
      onValid(v);
      input.setValue(String(v));
    });
    wrap.appendChild(input.element);
    const unitEl = document.createElement('span');
    unitEl.className = 'orbit-analysis-scale-unit';
    unitEl.textContent = unit;
    wrap.appendChild(unitEl);
    return { element: wrap, input, unitEl };
  }

  // チャートの表示幅から、点列のサンプル数を求める(密度を一定に保つ)。
  private sampleCount(): number {
    const width = this.chart.element.clientWidth || 300;
    return Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(width / SAMPLE_PX_PER_POINT)));
  }

  // tab のスケール・平行移動量から、OrbitChart へ渡す x軸・y軸を組み立てる。
  private axesFor(tab: AnalysisTab, currentAltM: number): { x: ChartAxis; y: ChartAxis } {
    if (tab === 'altitude') {
      // 横軸は経過時間の固定軸、縦軸は currentAltM を中心とした高度軸(下端は0でクリップ)。
      return {
        x: timeAxis(this.scales.altitude.x * 3600, MAX_TICKS, '経過時間'),
        y: distanceAxis(currentAltM, this.scales.altitude.yKm * 1000, MAX_TICKS, '高度', true),
      };
    }
    // 縦横とも approachPan を中心とした距離軸。
    return {
      x: distanceAxis(this.approachPan.x, this.scales.approach.x * 1000, MAX_TICKS, '水平距離'),
      y: distanceAxis(this.approachPan.y, this.scales.approach.yKm * 1000, MAX_TICKS, '相対高度'),
    };
  }

  // 点列が無い状態で軸だけを表示し、案内文を出す ChartSpec。
  private emptySpec(message: string): ChartSpec {
    const axes = this.axesFor(this.tab, 0);
    return { points: [], x: axes.x, y: axes.y, marks: [], emptyMessage: message };
  }

  // 高度タブの ChartSpec。series が null(基準が重力中心でない)なら案内文だけを出す。
  private altitudeSpec(series: ReturnType<typeof altitudeSeries>): ChartSpec {
    if (series === null) {
      const axes = this.axesFor('altitude', 0);
      return {
        points: [], x: axes.x, y: axes.y, marks: [],
        emptyMessage: '基準が重力中心ではないため高度を定義できません',
      };
    }
    // 縦軸の中心は開いた/タブを選び直した時点の現在高度に固定する。
    if (this.altitudeCenterM === null) this.altitudeCenterM = series.currentAlt;
    const axes = this.axesFor('altitude', this.altitudeCenterM);
    const points: (ChartPoint | null)[] = series.samples.map((s) => ({ x: s.t, y: s.alt }));
    const current = points[0];
    const marks: ChartMark[] = current ? [{ point: current, style: 'current' }] : [];
    return { points, x: axes.x, y: axes.y, marks };
  }

  // 接近タブの ChartSpec。原点(ターゲット位置)と操作対象の現在位置の丸マークを添える。
  private approachSpec(series: NonNullable<ReturnType<typeof approachSeries>>): ChartSpec {
    const axes = this.axesFor('approach', 0);
    const points: (ChartPoint | null)[] = series.samples.map((s) => (s ? { x: s.x, y: s.y } : null));
    const current = points.find((p): p is ChartPoint => p !== null) ?? null;
    const marks: ChartMark[] = [{ point: { x: 0, y: 0 }, style: 'target' }];
    if (current) marks.push({ point: current, style: 'current' });
    return { points, x: axes.x, y: axes.y, marks };
  }

  // ドラッグ移動量 [px] を軸の値へ換算してパンへ加える。接近タブは縦横とも平行移動するが、
  // 高度タブは横軸(経過時間)が現在時刻基準の固定軸なので縦軸(高度中心)だけを動かす。
  // プロット寸法が未確定(初回描画前)なら何もしない。
  private applyPan(dxPx: number, dyPx: number): void {
    const size = this.chart.plotPixelSize();
    if (!size) return;
    if (this.tab === 'approach') {
      // 縦横とも現在のスケールに応じて m へ換算し、パン位置へ加える。
      const spanXM = this.scales.approach.x * 1000;
      const spanYM = this.scales.approach.yKm * 1000;
      this.approachPan.x -= (dxPx / size.width) * spanXM;
      this.approachPan.y += (dyPx / size.height) * spanYM;
    } else {
      // 縦軸(高度)のスケールに応じて m へ換算し、中心へ加える。
      const spanYM = this.scales.altitude.yKm * 1000;
      this.altitudeCenterM = (this.altitudeCenterM ?? 0) + (dyPx / size.height) * spanYM;
    }
  }

  // ホイール/ピンチでズームする。接近タブは実質2D の位置図なので縦横同倍率で保つが、
  // 高度タブは縦軸(高度スケール)だけを動かす。
  private applyZoom(wheelDelta: number): void {
    const factor = Math.exp(wheelDelta);
    const clamp = (v: number): number => Math.max(SCALE_MIN_KM, Math.min(SCALE_MAX_KM, v));
    if (this.tab === 'approach') {
      this.scales.approach = { yKm: clamp(this.scales.approach.yKm * factor), x: clamp(this.scales.approach.x * factor) };
    } else {
      this.scales.altitude = { ...this.scales.altitude, yKm: clamp(this.scales.altitude.yKm * factor) };
    }
    this.refreshScaleInputs();
  }

  // 現在の航法ターゲットを、接近タブの点列計算に渡せる形(艦・基地 or 天体)へ解決する。
  // ラグランジュ点など質量を持たない対象は解決せず、接近タブを出さない。
  private resolveApproachTarget(
    game: Game, celestialBodies: readonly CelestialMotion[],
  ): ApproachTargetSource | null {
    const id = game.navTarget.id;
    if (id === null) return null;
    const body = celestialBodies.find((b) => b.id === id);
    if (body) return { kind: 'celestialBody', body };
    const entity = game.dynamicSystem.findAliveCombatTarget(id);
    return entity ? { kind: 'entity', entity } : null;
  }
}
