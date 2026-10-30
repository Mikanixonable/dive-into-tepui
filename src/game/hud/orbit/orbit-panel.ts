// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度、および基準切替のセグメントコントロール。戦闘/マップ共通。
import { fmtDistParts, fmtSpeedParts, fmtTime, type ValueParts } from '../../../hud/utils';
import { setReadout } from '../../../hud/readout';
import { SyncThrottle } from '../sync-throttle';
import type { HudEls, HudElId } from '../hud-els';
import type { OrbitReferenceMode } from '../../viewer/orbit-reference-selection';
import { Button, Meter, SegmentedControl } from '../../../hud/widgets';
import { applyAlarmLevel, worstAlarmLevel, type AlarmLevel } from '../../../hud/alarm-level';
import {
  DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO,
  TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO,
  dynamicPressureAlarmLevel, temperatureAlarmLevel,
} from '../../alarm/alarm-level';

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
  // 「航行指令…」ボタン。現在の航法ターゲットへ向かう遷移候補の求解窓を開く。
  onOpenNavigationCommand(): void;
}

export class OrbitPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly referenceControl: SegmentedControl<OrbitReferenceMode>;
  private readonly qdynMeter: Meter;
  private readonly tempMeter: Meter;
  // 直近の sync で受け取った状態。基準切替はフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: OrbitPanelViewModel | null = null;

  // 基準切替のセグメントコントロール・環境負荷のメーター・軌道分析ボタンを els が指す DOM へ組み込む。
  // openAnalysis は軌道分析ボタンが押されたときに呼ぶコールバック。
  public constructor(
    private readonly els: HudEls,
    private readonly openAnalysis: () => void,
  ) {
    this.referenceControl = new SegmentedControl('基準', REFERENCE_ITEMS, (mode) => {
      this.view?.setReferenceMode(mode);
    });
    this.els.get('reference-row').appendChild(this.referenceControl.element);
    this.qdynMeter = this.mountMeter('qdyn-meter', '動圧');
    this.qdynMeter.setMarks(DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO);
    this.tempMeter = this.mountMeter('temp-meter', '機体温度');
    this.tempMeter.setMarks(TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO);
    this.buildActionButtons();
  }

  // Meter ウィジェットを容器要素へ差し込む。
  private mountMeter(containerId: HudElId, label: string): Meter {
    const meter = new Meter(label);
    this.els.get(containerId).appendChild(meter.element);
    return meter;
  }

  // 軌道分析・航行指令を開くボタンを els が指す DOM へ組み込む。
  private buildActionButtons(): void {
    const container = this.els.get('orbit-actions');
    const button = new Button('軌道分析', () => this.openAnalysis(), undefined, ['dense', 'secondary']);
    container.appendChild(button.element);
    const navigation = new Button(
      '航行指令…', () => this.view?.onOpenNavigationCommand(), undefined, ['dense', 'secondary'],
    );
    container.appendChild(navigation.element);
  }

  // 操作対象の基準・高度・速度・遠地点/近地点・傾斜角・周期・動圧・機体温度を DOM へ反映する。
  // view が null(操作対象が無い)ならパネルごと隠す。
  public sync(view: OrbitPanelViewModel | null, nowMs: number): void {
    this.view = view;
    const el = this.els.get('hud-orbit');
    if (!view) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');

    if (!this.throttle.due(nowMs)) return;

    this.referenceControl.setSelected(view.selectedMode);
    const apSpec = getApsisLabelSpec('ap', view.centerId);
    const peSpec = getApsisLabelSpec('pe', view.centerId);
    this.els.setText('hud-orbit-meta', `基準 ${view.centerName}`);

    // 主読み値(高度・速度)。降下の警告は高度の段で示す。
    const altitudeLevel: AlarmLevel = view.descendWarned ? 'caution' : 'normal';
    this.syncPrimary('alt', fmtDistParts(view.altitudeM), altitudeLevel);
    this.syncPrimary('spd', fmtSpeedParts(view.speedMps), 'normal');

    // 軌道の形(遠地点・近地点・傾斜角・周期)。
    setReadout(this.els.get('ap-label'), apSpec.nameJa, apSpec.short);
    setReadout(this.els.get('pe-label'), peSpec.nameJa, peSpec.short);
    this.syncRow('ap', fmtDistParts(view.apAltitudeM));
    this.syncRow('pe', fmtDistParts(view.peAltitudeM));
    this.syncRow('inc', { value: isFinite(view.inclinationDeg) ? `${view.inclinationDeg.toFixed(2)}°` : '---', unit: '' });
    this.syncRow('prd', { value: fmtTime(view.periodSec), unit: '' });

    // 動圧は大気を受ける機体だけ行自体を出す。閾値を越えた値は色と記号で示し、バーにも閾値を立てる。
    const qdyn = view.dynamicPressurePa;
    const qRow = this.els.get('orbit-qdyn-row');
    qRow.classList.toggle('hidden', qdyn === null);
    let qdynLevel: AlarmLevel = 'normal';
    if (qdyn !== null) {
      qdynLevel = dynamicPressureAlarmLevel(qdyn, MAX_DYN_PRESSURE);
      this.syncEnvironmentLevel(
        'qdyn', qRow, this.qdynMeter, qdyn, MAX_DYN_PRESSURE, qdynLevel,
        { value: qdyn >= 10 ? (qdyn / 1000).toFixed(2) : '0.00', unit: 'kPa' },
      );
    } else {
      this.syncEnvironmentLevel('qdyn', qRow, this.qdynMeter, 0, MAX_DYN_PRESSURE, 'normal', { value: '—', unit: '' });
    }

    const tempLevel = temperatureAlarmLevel(view.temperatureK, MAX_HULL_TEMP);
    this.syncEnvironmentLevel(
      'temp', this.els.get('temp-row'), this.tempMeter, view.temperatureK, MAX_HULL_TEMP, tempLevel,
      { value: view.temperatureK.toFixed(0), unit: 'K' },
    );

    // 畳んだ見出しには高度を出し、高度・動圧・船体温度のうち最も重い段を色と記号で残す。
    const altitude = fmtDistParts(view.altitudeM);
    this.els.setText('hud-orbit-summary', `${altitude.value} ${altitude.unit}`.trim());
    applyAlarmLevel(this.els.get('hud-orbit-summary'), worstAlarmLevel(altitudeLevel, qdynLevel, tempLevel));
  }

  // 主読み値(高度・速度)の要素へ値と単位、段を書く。
  private syncPrimary(id: 'alt' | 'spd', parts: ValueParts, level: AlarmLevel): void {
    const el = this.els.get(id);
    setReadout(el, parts.value, parts.unit);
    applyAlarmLevel(el, level);
  }

  // 行の値の要素へ値と単位を書く。
  private syncRow(id: HudElId, parts: ValueParts): void {
    setReadout(this.els.get(id), parts.value, parts.unit);
  }

  // 環境負荷1行ぶんの値・行・メーターへ段を反映する。警告のときだけ行に面が付く。
  private syncEnvironmentLevel(
    valueId: HudElId, rowEl: HTMLElement, meter: Meter, now: number, max: number, level: AlarmLevel,
    parts: ValueParts,
  ): void {
    const valueEl = this.els.get(valueId);
    setReadout(valueEl, parts.value, parts.unit);
    applyAlarmLevel(valueEl, level);
    rowEl.classList.toggle('ui-warning-fill', level === 'warning');
    meter.setProgress(now, max, null, level);
  }
}
