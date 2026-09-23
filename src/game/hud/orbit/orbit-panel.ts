// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度、および基準切替のセグメントコントロール。戦闘/マップ共通。
import { fmtDist, fmtSpeed, fmtTime, setElementText } from '../../../hud/utils';
import { SyncThrottle } from '../sync-throttle';
import type { OrbitReferenceMode } from '../../viewer/orbit-reference-selection';
import { Button, SegmentedControl } from '../../../hud/widgets';

import { getApsisLabelSpec } from './orbit-labels';
import { MAX_HULL_TEMP } from '../../dynamic/dynamic-entity/combat-ship-entity';
import { MAX_DYN_PRESSURE } from '../../player/aero-load';

const SYNC_INTERVAL_MS = 100;

const REFERENCE_ITEMS: readonly (readonly [OrbitReferenceMode, string])[] = [
  ['auto', '自動'],
  ['earth', '地球'],
  ['moon', '月'],
  ['target', '航法ターゲット'],
];

// ORBIT パネルが1フレームに表示する値と、基準切替用のコールバック。
// 軌道要素が求まらない状態(基準が重力中心でない・双曲線軌道)では ap/pe/inc/period が NaN。
export interface OrbitPanelViewModel {
  readonly selectedMode: OrbitReferenceMode;
  readonly centerId: string;
  readonly centerName: string;
  readonly altitudeM: number;
  readonly descendWarned: boolean;
  readonly speedMps: number;
  readonly apAltitudeM: number;
  readonly peAltitudeM: number;
  readonly inclinationDeg: number;
  readonly periodSec: number;
  // 大気を受けない操作対象では null。
  readonly dynamicPressurePa: number | null;
  readonly temperatureK: number;
  setReferenceMode(mode: OrbitReferenceMode): void;
}

export class OrbitPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly referenceControl: SegmentedControl<OrbitReferenceMode>;
  // 直近の sync で受け取った状態。基準切替はフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: OrbitPanelViewModel | null = null;

  // 基準切替のセグメントコントロールと軌道分析ボタンを els が指す DOM へ組み込む。
  // openAnalysis は軌道分析ボタンが押されたときに呼ぶコールバック。
  public constructor(
    private readonly els: Map<string, HTMLElement>,
    private readonly openAnalysis: () => void,
  ) {
    this.referenceControl = new SegmentedControl('基準', REFERENCE_ITEMS, (mode) => {
      this.view?.setReferenceMode(mode);
    });
    this.els.get('reference-row')?.appendChild(this.referenceControl.element);
    this.buildActionButtons();
  }

  // 軌道分析パネルを開くボタンを els が指す DOM へ組み込む。
  private buildActionButtons(): void {
    const container = this.els.get('orbit-actions');
    if (!container) return;
    const button = new Button('軌道分析', () => this.openAnalysis());
    container.appendChild(button.element);
  }

  // 操作対象の基準・高度・速度・遠地点/近地点・傾斜角・周期・動圧・機体温度を DOM へ反映する。
  // view が null(操作対象が無い)ならパネルごと隠す。
  public sync(view: OrbitPanelViewModel | null, nowMs: number): void {
    this.view = view;
    const el = this.els.get('hud-orbit');
    if (!view) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.remove('hidden');

    if (!this.throttle.due(nowMs)) return;

    this.referenceControl.setSelected(view.selectedMode);
    const apSpec = getApsisLabelSpec('ap', view.centerId);
    const peSpec = getApsisLabelSpec('pe', view.centerId);
    setElementText(this.els, 'center', view.centerName);
    setElementText(this.els, 'orbit-context', `REFERENCE · ${referenceLabel(view.selectedMode)}`);
    setElementText(this.els, 'alt', fmtDist(view.altitudeM));
    this.els.get('alt')?.classList.toggle('warn-hot', view.descendWarned);
    setElementText(this.els, 'spd', fmtSpeed(view.speedMps));
    setElementText(this.els, 'ap-label', `${apSpec.nameJa} ${apSpec.short}`);
    setElementText(this.els, 'pe-label', `${peSpec.nameJa} ${peSpec.short}`);
    setElementText(this.els, 'ap', fmtDist(view.apAltitudeM));
    setElementText(this.els, 'pe', fmtDist(view.peAltitudeM));
    setElementText(this.els, 'inc', isFinite(view.inclinationDeg) ? `${view.inclinationDeg.toFixed(2)}°` : '---');
    setElementText(this.els, 'prd', fmtTime(view.periodSec));
    // 動圧は大気を受ける機体だけ行自体を出す。値だけの赤字ではなく、閾値接近をバーでも示す。
    const qdyn = view.dynamicPressurePa;
    const qEl = this.els.get('qdyn');
    const qRow = this.els.get('orbit-qdyn-row');
    const qFill = this.els.get('qdyn-meter-fill');
    qRow?.classList.toggle('hidden', qdyn === null);
    if (qdyn !== null) {
      const qDanger = qdyn > 0.5 * MAX_DYN_PRESSURE;
      if (qEl) {
        qEl.textContent = qdyn >= 10 ? `${(qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
        qEl.classList.toggle('warn-hot', qDanger);
      }
      qRow?.classList.toggle('warn-hot', qDanger);
      syncEnvironmentMeter(qFill, qdyn / MAX_DYN_PRESSURE, qDanger);
    } else {
      qEl?.classList.remove('warn-hot');
      qRow?.classList.remove('warn-hot');
      syncEnvironmentMeter(qFill, 0, false);
    }

    const tDanger = view.temperatureK > 0.7 * MAX_HULL_TEMP;
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${view.temperatureK.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', tDanger);
    }
    this.els.get('temp-row')?.classList.toggle('warn-hot', tDanger);
    syncEnvironmentMeter(this.els.get('temp-meter-fill') ?? null, view.temperatureK / MAX_HULL_TEMP, tDanger);
  }
}

// 基準モードの内部値を、context line で短く読める表示名へ変換する。
function referenceLabel(mode: OrbitReferenceMode): string {
  return REFERENCE_ITEMS.find(([id]) => id === mode)?.[1] ?? mode;
}

// 環境バーは最大値基準で 0..1 に収め、危険域は既存 widget と同じ danger class を使う。
function syncEnvironmentMeter(fill: HTMLElement | null, ratio: number, danger: boolean): void {
  if (fill === null) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  fill.style.width = `${clamped * 100}%`;
  fill.classList.toggle('danger', danger);
  const track = fill.parentElement;
  track?.setAttribute('aria-valuemin', '0');
  track?.setAttribute('aria-valuemax', '100');
  track?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
}
