// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度、および基準切替のセグメントコントロール。戦闘/マップ共通。
import { fmtDist, fmtSpeed, fmtTime, setElementText } from '../../../hud/utils';
import { SyncThrottle } from '../sync-throttle';
import { orbitInfo } from './orbit-info';
import type { Game } from '../../game';
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

export class OrbitPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly referenceControl: SegmentedControl<OrbitReferenceMode>;
  // 軌道分析パネルの開閉は Hud が持つため、ここでは押されたことだけを伝える。ボタン構築時には
  // まだ配線されていないので、VesselPanel.setInput と同じ late injection にする。
  private openAnalysis: (() => void) | null = null;

  // 基準切替のセグメントコントロールと軌道分析ボタンを els が指す DOM へ組み込む。
  public constructor(private readonly els: Map<string, HTMLElement>) {
    this.referenceControl = new SegmentedControl('基準', REFERENCE_ITEMS, (mode) => {
      this.game?.orbitReference.setMode(mode);
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

  private game: Game | null = null;

  // 操作対象の基準・高度・速度・遠地点/近地点・傾斜角・周期・動圧・機体温度を DOM へ反映する。
  public sync(game: Game): void {
    this.game = game;
    const celestialBodies = game.celestialSystem.celestialMotions;
    const entity = game.activeControllableEntity;
    const el = this.els.get('hud-orbit');
    if (!entity) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.remove('hidden');

    if (!this.throttle.due()) return;

    this.referenceControl.setSelected(game.orbitReference.selectedMode);
    const reference = game.orbitReference.resolve(
      entity.state.r, celestialBodies, game.navTarget, game.dynamicSystem, game.celestialSystem, entity.state.t,
    );
    const oi = orbitInfo(
      entity, reference, entity.state.t, (id: string) => game.celestialSystem.nameOf(id));
    const apSpec = getApsisLabelSpec('ap', oi.centerId);
    const peSpec = getApsisLabelSpec('pe', oi.centerId);
    // 航法ターゲット基準で対象が重力天体でない(艦・基地・ラグランジュ点)場合は、
    // celestialBodyName の生 ID フォールバックより航法ターゲットの表示名を優先する。
    const centerName = !reference.attractor && game.navTarget.name ? game.navTarget.name : oi.centerName;
    setElementText(this.els, 'center', centerName);
    setElementText(this.els, 'alt', fmtDist(oi.alt));
    this.els.get('alt')?.classList.toggle('warn-hot', entity.altitudeAlarm?.descendWarned ?? false);
    setElementText(this.els, 'spd', fmtSpeed(oi.spd));
    setElementText(this.els, 'ap-label', `${apSpec.nameJa} ${apSpec.short}`);
    setElementText(this.els, 'pe-label', `${peSpec.nameJa} ${peSpec.short}`);
    setElementText(this.els, 'ap', fmtDist(oi.apAlt));
    setElementText(this.els, 'pe', fmtDist(oi.peAlt));
    setElementText(this.els, 'inc', isFinite(oi.incDeg) ? `${oi.incDeg.toFixed(2)}°` : '---');
    setElementText(this.els, 'prd', fmtTime(oi.period));
    // 動圧・機体温度は閾値超過で警告表示にする。動圧は大気を受ける操作対象だけが持つ。
    const qEl = this.els.get('qdyn');
    const aero = entity.aero;
    if (qEl) {
      if (aero) {
        qEl.textContent = aero.qdyn >= 10 ? `${(aero.qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
        qEl.classList.toggle('warn-hot', aero.qdyn > 0.5 * MAX_DYN_PRESSURE);
      } else {
        qEl.textContent = '---';
        qEl.classList.remove('warn-hot');
      }
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${entity.temperature.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', entity.temperature > 0.7 * MAX_HULL_TEMP);
    }
  }
}
