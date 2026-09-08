// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度、および基準切替のセグメントコントロール。戦闘/マップ共通。
import { fmtDist, fmtSpeed, fmtTime, setElementText } from '../../../hud/utils';
import { SyncThrottle } from '../sync-throttle';
import type { OrbitReferenceMode } from '../../orbit-reference';
import { Button, SegmentedControl } from '../../../hud/widgets';

import { getApsisLabelSpec } from './orbit-labels';
import { MAX_HULL_TEMP } from '../../dynamic/dynamic-entity/ship';
import { MAX_DYN_PRESSURE } from '../../player/aero-load';

const SYNC_INTERVAL_MS = 100;

const REFERENCE_ITEMS: readonly (readonly [OrbitReferenceMode, string])[] = [
  ['auto', '自動'],
  ['earth', '地球'],
  ['moon', '月'],
  ['target', '航法ターゲット'],
];

export interface OrbitPanelViewModel {
  readonly selectedMode: OrbitReferenceMode;
  readonly centerId: string;
  readonly centerName: string;
  readonly altitudeM: number;
  readonly speedMps: number;
  readonly apAltitudeM: number;
  readonly peAltitudeM: number;
  readonly inclinationDeg: number;
  readonly periodSec: number;
  readonly qdyn: number | null;
  readonly temperatureK: number;
  readonly altitudeWarning: boolean;
}

export interface OrbitPanelCommands {
  readonly setReferenceMode: (mode: OrbitReferenceMode) => void;
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
      this.commands.setReferenceMode(mode);
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

  private commands: OrbitPanelCommands = { setReferenceMode: () => {} };

  public setCommands(commands: OrbitPanelCommands): void {
    this.commands = commands;
  }

  // 操作対象の基準・高度・速度・遠地点/近地点・傾斜角・周期・動圧・機体温度を DOM へ反映する。
  public sync(view: OrbitPanelViewModel | null): void {
    const el = this.els.get('hud-orbit');
    if (!view) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.remove('hidden');

    if (!this.throttle.due()) return;

    this.referenceControl.setSelected(view.selectedMode);
    const apSpec = getApsisLabelSpec('ap', view.centerId);
    const peSpec = getApsisLabelSpec('pe', view.centerId);
    setElementText(this.els, 'center', view.centerName);
    setElementText(this.els, 'alt', fmtDist(view.altitudeM));
    this.els.get('alt')?.classList.toggle('warn-hot', view.altitudeWarning);
    setElementText(this.els, 'spd', fmtSpeed(view.speedMps));
    setElementText(this.els, 'ap-label', `${apSpec.nameJa} ${apSpec.short}`);
    setElementText(this.els, 'pe-label', `${peSpec.nameJa} ${peSpec.short}`);
    setElementText(this.els, 'ap', fmtDist(view.apAltitudeM));
    setElementText(this.els, 'pe', fmtDist(view.peAltitudeM));
    setElementText(this.els, 'inc', isFinite(view.inclinationDeg) ? `${view.inclinationDeg.toFixed(2)}°` : '---');
    setElementText(this.els, 'prd', fmtTime(view.periodSec));
    // 動圧・機体温度は閾値超過で警告表示にする。動圧は大気を受ける操作対象だけが持つ。
    const qEl = this.els.get('qdyn');
    if (qEl) {
      if (view.qdyn !== null) {
        qEl.textContent = view.qdyn >= 10 ? `${(view.qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
        qEl.classList.toggle('warn-hot', view.qdyn > 0.5 * MAX_DYN_PRESSURE);
      } else {
        qEl.textContent = '---';
        qEl.classList.remove('warn-hot');
      }
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${view.temperatureK.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', view.temperatureK > 0.7 * MAX_HULL_TEMP);
    }
  }
}
