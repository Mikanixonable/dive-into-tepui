// 軌道分析パネル: 操作対象の未来の軌道を「高度」「接近」の2タブでグラフ表示するドラッグ可能
// ウィンドウ。外枠(ドラッグ・クリップ・ヘッダ・OverlayManager 登録)は DraggableWindow に
// 委譲し、ここではタブ・スケール入力欄の組み立てと、点列を orbit-analysis-data.ts へ問い合わせて
// OrbitChart へ渡すことだけを持つ。
import type { CelestialBody } from '../../physics/celestial-body';
import type { Game } from '../game';
import type { GameEntity } from '../game-entity/game-entity';
import { DraggableWindow } from './draggable-window';
import {
  ChartAxis, ChartMark, ChartPoint, ChartSpec, OrbitChart, distanceAxis, timeAxis,
} from './orbit-chart';
import { altitudeSeries, approachSeries, ApproachTargetSource } from './orbit-analysis-data';
import { MQ_COMPACT } from './breakpoints';
import { TabBar, ValueInput } from './widgets';
import type { OverlayManager } from './overlay-manager';

export type AnalysisTab = 'altitude' | 'approach';

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

const TAB_ITEMS_ALTITUDE_ONLY: readonly (readonly [AnalysisTab, string])[] = [['altitude', '高度']];
const TAB_ITEMS_BOTH: readonly (readonly [AnalysisTab, string])[] =
  [['altitude', '高度'], ['approach', '接近']];

interface TabScale { yKm: number; x: number }

const DEFAULT_SCALES: Readonly<Record<AnalysisTab, TabScale>> = {
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
`;

let styleInjected = false;

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
  private readonly relIncRow: HTMLElement;
  private readonly relIncValue: HTMLElement;
  private readonly yInput: ValueInput;
  private readonly xInput: ValueInput;
  private readonly xUnitEl: HTMLElement;
  private tab: AnalysisTab = 'altitude';
  private approachAvailable = false;
  private nextSyncAt = 0;
  // 縦軸(高度)の中心 [m]。null なら次の sync で現在高度に固定し直す。
  private altitudeCenterM: number | null = null;
  // 戦闘ビューでも未来の弧を伸ばし続けさせるため analysisPanelReader を立てている個体
  // (操作対象・接近タブのターゲット)。
  private readerEntity: GameEntity | null = null;
  private readerTargetEntity: GameEntity | null = null;
  private readonly scales: Record<AnalysisTab, TabScale> = {
    altitude: { ...DEFAULT_SCALES.altitude },
    approach: { ...DEFAULT_SCALES.approach },
  };

  // ESC・外側クリック・✕ ボタンのどの経路で閉じても発火する。
  public onClose: (() => void) | null = null;

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

    this.tabBar = new TabBar<AnalysisTab>(TAB_ITEMS_ALTITUDE_ONLY, (tab) => this.selectTab(tab));
    this.win.body.appendChild(this.tabBar.element);
    this.win.body.appendChild(this.chart.element);

    const relIncLabel = document.createElement('span');
    relIncLabel.className = 'orbit-analysis-relinc-label';
    relIncLabel.textContent = '相対傾斜角';
    this.relIncValue = document.createElement('output');
    this.relIncRow = document.createElement('div');
    this.relIncRow.className = 'orbit-analysis-relinc hidden';
    this.relIncRow.appendChild(relIncLabel);
    this.relIncRow.appendChild(this.relIncValue);
    this.win.body.appendChild(this.relIncRow);

    const scalesRow = document.createElement('div');
    scalesRow.className = 'orbit-analysis-scales';
    const yField = this.buildScaleField(
      '縦軸', 'km', () => this.scales[this.tab].yKm, (v) => { this.scales[this.tab].yKm = v; },
    );
    this.yInput = yField.input;
    scalesRow.appendChild(yField.element);
    const xField = this.buildScaleField(
      '横軸', this.xUnitLabel(), () => this.scales[this.tab].x, (v) => { this.scales[this.tab].x = v; },
    );
    this.xInput = xField.input;
    this.xUnitEl = xField.unitEl;
    scalesRow.appendChild(xField.element);
    this.win.body.appendChild(scalesRow);

    this.refreshScaleInputs();
  }

  // 呼び出し側から見た「引き上げて最前面へ」— Orbit パネルのボタンが2枚目を開かないために使う。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  public dispose(): void {
    this.setReaderEntity(null);
    this.setReaderTargetEntity(null);
    this.win.dispose();
    this.chart.dispose();
  }

  // 旧対象のフラグを降ろし、新対象に立て直す。
  private static applyReader(prev: GameEntity | null, next: GameEntity | null): GameEntity | null {
    if (prev === next) return prev;
    if (prev) prev.analysisPanelReader = false;
    if (next) next.analysisPanelReader = true;
    return next;
  }

  private setReaderEntity(entity: GameEntity | null): void {
    if (entity === this.readerEntity) return;
    this.readerEntity = OrbitAnalysisWindow.applyReader(this.readerEntity, entity);
    this.altitudeCenterM = null;
  }

  private setReaderTargetEntity(entity: GameEntity | null): void {
    this.readerTargetEntity = OrbitAnalysisWindow.applyReader(this.readerTargetEntity, entity);
  }

  public sync(game: Game, celestialBodies: readonly CelestialBody[]): void {
    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    const entity = game.activeControllableEntity;
    this.setReaderEntity(entity);
    if (!entity) {
      this.approachAvailable = false;
      this.tabBar.setItems(TAB_ITEMS_ALTITUDE_ONLY);
      this.chart.draw(this.emptySpec('操作対象がありません'));
      return;
    }

    const reference = game.orbitReference.resolve(
      entity.state.r, celestialBodies, game.navTarget, game.entities, game.ephemeris, entity.state.t,
    );
    const sampleCount = this.sampleCount();
    const approachSource = this.resolveApproachTarget(game, celestialBodies);
    this.setReaderTargetEntity(approachSource?.kind === 'entity' ? approachSource.entity : null);
    const approach = approachSource
      ? approachSeries(
        entity, approachSource, celestialBodies, game.ephemeris, entity.state.t,
        APPROACH_SAMPLE_SPAN_SEC, sampleCount * APPROACH_SAMPLE_MULTIPLIER,
      )
      : null;
    this.approachAvailable = approach !== null;
    this.tabBar.setItems(this.approachAvailable ? TAB_ITEMS_BOTH : TAB_ITEMS_ALTITUDE_ONLY);
    if (this.tab === 'approach' && !this.approachAvailable) this.selectTab('altitude');
    this.tabBar.setSelected(this.tab);

    if (this.tab === 'altitude') {
      const altitude = altitudeSeries(
        entity, reference, game.ephemeris, entity.state.t, this.scales.altitude.x * 3600, sampleCount,
      );
      this.chart.draw(this.altitudeSpec(altitude));
    } else if (approach) {
      this.chart.draw(this.approachSpec(approach));
      this.relIncValue.textContent = isFinite(approach.relIncDeg) ? `${approach.relIncDeg.toFixed(2)}°` : '---';
    }
  }

  private selectTab(tab: AnalysisTab): void {
    this.tab = tab;
    if (tab === 'altitude') this.altitudeCenterM = null;
    this.tabBar.setSelected(tab);
    this.relIncRow.classList.toggle('hidden', tab !== 'approach');
    this.refreshScaleInputs();
  }

  // 選択中タブのスケール値・単位を入力欄へ反映する。タブ切替のたびに呼ぶ。
  private refreshScaleInputs(): void {
    this.yInput.setValue(String(this.scales[this.tab].yKm));
    this.xInput.setValue(String(this.scales[this.tab].x));
    this.xUnitEl.textContent = this.xUnitLabel();
  }

  private xUnitLabel(): string {
    return this.tab === 'altitude' ? 'h' : 'km';
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

  private sampleCount(): number {
    const width = this.chart.element.clientWidth || 300;
    return Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(width / SAMPLE_PX_PER_POINT)));
  }

  private axesFor(tab: AnalysisTab, currentAltM: number): { x: ChartAxis; y: ChartAxis } {
    if (tab === 'altitude') {
      return {
        x: timeAxis(this.scales.altitude.x * 3600, MAX_TICKS, '経過時間'),
        y: distanceAxis(currentAltM, this.scales.altitude.yKm * 1000, MAX_TICKS, '高度'),
      };
    }
    return {
      x: distanceAxis(0, this.scales.approach.x * 1000, MAX_TICKS, '水平距離'),
      y: distanceAxis(0, this.scales.approach.yKm * 1000, MAX_TICKS, '相対高度'),
    };
  }

  private emptySpec(message: string): ChartSpec {
    const axes = this.axesFor(this.tab, 0);
    return { points: [], x: axes.x, y: axes.y, marks: [], emptyMessage: message };
  }

  private altitudeSpec(series: ReturnType<typeof altitudeSeries>): ChartSpec {
    if (series === null) {
      const axes = this.axesFor('altitude', 0);
      return {
        points: [], x: axes.x, y: axes.y, marks: [],
        emptyMessage: '基準が重力中心ではないため高度を定義できません',
      };
    }
    if (this.altitudeCenterM === null) this.altitudeCenterM = series.currentAlt;
    const axes = this.axesFor('altitude', this.altitudeCenterM);
    const points: (ChartPoint | null)[] = series.samples.map((s) => ({ x: s.t, y: s.alt }));
    const current = points[0];
    const marks: ChartMark[] = current ? [{ point: current, style: 'current' }] : [];
    return { points, x: axes.x, y: axes.y, marks };
  }

  private approachSpec(series: NonNullable<ReturnType<typeof approachSeries>>): ChartSpec {
    const axes = this.axesFor('approach', 0);
    const points: (ChartPoint | null)[] = series.samples.map((s) => (s ? { x: s.x, y: s.y } : null));
    const current = points.find((p): p is ChartPoint => p !== null) ?? null;
    const marks: ChartMark[] = [{ point: { x: 0, y: 0 }, style: 'target' }];
    if (current) marks.push({ point: current, style: 'current' });
    return { points, x: axes.x, y: axes.y, marks };
  }

  // 現在の航法ターゲットを、接近タブの点列計算に渡せる形(艦・基地 or 天体)へ解決する。
  // ラグランジュ点など質量を持たない対象は解決せず、接近タブを出さない。
  private resolveApproachTarget(
    game: Game, celestialBodies: readonly CelestialBody[],
  ): ApproachTargetSource | null {
    const id = game.navTarget.id;
    if (id === null) return null;
    const body = celestialBodies.find((b) => b.id === id);
    if (body) return { kind: 'celestialBody', body };
    const entity = game.entities.findEnemy(id)
      ?? game.entities.players.find((p) => p.id === id)
      ?? game.entities.bases.find((b) => b.id === id && b.alive)
      ?? null;
    return entity ? { kind: 'entity', entity } : null;
  }
}
