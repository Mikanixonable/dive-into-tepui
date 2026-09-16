// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度、および基準切替のセグメントコントロール。戦闘/マップ共通。
import { fmtDist, fmtSpeed, fmtTime, setElementText } from '../../../hud/utils';
import { SyncThrottle } from '../sync-throttle';
import type { OrbitReferenceMode } from '../../orbit-reference';
import { Button, SegmentedControl } from '../../../hud/widgets';

import { getApsisLabelSpec } from './orbit-labels';

const SYNC_INTERVAL_MS = 100;

const REFERENCE_ITEMS: readonly (readonly [OrbitReferenceMode, string])[] = [
  ['auto', '自動'],
  ['earth', '地球'],
  ['moon', '月'],
  ['target', '航法ターゲット'],
];

export interface OrbitPanelViewModel {
  readonly centerName: string;
  readonly centerId: string;
  readonly alt: number;
  readonly spd: number;
  readonly apAlt: number;
  readonly peAlt: number;
  readonly incDeg: number;
  readonly period: number;
  readonly altitudeWarning: boolean;
  readonly dynamicPressure: number | null;
  readonly dynamicPressureWarning: boolean;
  readonly temperatureK: number;
  readonly temperatureWarning: boolean;
  readonly referenceMode: OrbitReferenceMode;
  readonly onReferenceModeChange: (mode: OrbitReferenceMode) => void;
}

export class OrbitPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly referenceControl: SegmentedControl<OrbitReferenceMode>;
  // 軌道分析パネルの開閉は Hud が持つため、ここでは押されたことだけを伝える。ボタン構築時には
  // まだ配線されていないので、VesselPanel.setInput と同じ late injection にする。
  private openAnalysis: (() => void) | null = null;

  // 基準切替のセグメントコントロールと軌道分析ボタンを els が指す DOM へ組み込む。
  public constructor(private readonly els: Map<string, HTMLElement>) {
    this.referenceControl = new SegmentedControl('基準', REFERENCE_ITEMS, (mode) => {
      this.onReferenceModeChange?.(mode);
    });
    this.els.get('reference-row')?.appendChild(this.referenceControl.element);
    this.buildActionButtons();
  }

  // Hud から軌道分析パネルの開閉ハンドラを受け取る。
  public setOpenAnalysisHandler(handler: () => void): void {
    this.openAnalysis = handler;
  }

  // 軌道分析パネルを開くボタンを els が指す DOM へ組み込む。
  private buildActionButtons(): void {
    const container = this.els.get('orbit-actions');
    if (!container) return;
    const button = new Button('軌道分析', () => this.openAnalysis?.());
    container.appendChild(button.element);
  }

  private onReferenceModeChange: ((mode: OrbitReferenceMode) => void) | null = null;

  // 操作対象の基準・高度・速度・遠地点/近地点・傾斜角・周期・動圧・機体温度を DOM へ反映する。
  public sync(view: OrbitPanelViewModel | null): void {
    const el = this.els.get('hud-orbit');
    if (!view) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.remove('hidden');

    if (!this.throttle.due()) return;

    this.referenceControl.setSelected(view.referenceMode);
    this.onReferenceModeChange = view.onReferenceModeChange;
    const apSpec = getApsisLabelSpec('ap', view.centerId);
    const peSpec = getApsisLabelSpec('pe', view.centerId);
    setElementText(this.els, 'center', view.centerName);
    setElementText(this.els, 'alt', fmtDist(view.alt));
    this.els.get('alt')?.classList.toggle('warn-hot', view.altitudeWarning);
    setElementText(this.els, 'spd', fmtSpeed(view.spd));
    setElementText(this.els, 'ap-label', `${apSpec.nameJa} ${apSpec.short}`);
    setElementText(this.els, 'pe-label', `${peSpec.nameJa} ${peSpec.short}`);
    setElementText(this.els, 'ap', fmtDist(view.apAlt));
    setElementText(this.els, 'pe', fmtDist(view.peAlt));
    setElementText(this.els, 'inc', isFinite(view.incDeg) ? `${view.incDeg.toFixed(2)}°` : '---');
    setElementText(this.els, 'prd', fmtTime(view.period));
    // 動圧・機体温度は閾値超過で警告表示にする。動圧は大気を受ける操作対象だけが持つ。
    const qEl = this.els.get('qdyn');
    if (qEl) {
      if (view.dynamicPressure !== null) {
        qEl.textContent = view.dynamicPressure >= 10 ? `${(view.dynamicPressure / 1000).toFixed(2)} kPa` : '0.00 kPa';
        qEl.classList.toggle('warn-hot', view.dynamicPressureWarning);
      } else {
        qEl.textContent = '---';
        qEl.classList.remove('warn-hot');
      }
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${view.temperatureK.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', view.temperatureWarning);
    }
  }
}
