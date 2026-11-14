// 常設 TARGET パネル(#hud-target)の同期。ロック中ターゲットの名前・距離・接近速度・相対速度・
// 装甲を、ターゲットの固定中に表示する。距離と接近速度が答えで、残りは行に出す。
import { fmtDist, fmtDistParts, fmtSpeedParts } from '../../../hud/utils';
import { setReadout } from '../../../hud/readout';
import { SyncThrottle } from '../sync-throttle';
import type { HudEls } from '../hud-els';
import { Meter } from '../../../hud/widgets';
import { applyAlarmLevel } from '../../../hud/alarm-level';

const SYNC_INTERVAL_MS = 100;

// ロック中ターゲットの1フレーム分の状態と、パネル本体の右クリック通知コールバック。
export interface TargetPanelViewModel {
  readonly name: string;
  readonly distanceM: number;
  readonly closingMps: number; // 正 = 近づいている。
  readonly relativeSpeedMps: number;
  // 装甲を持たない対象(基地)では null。
  readonly hp: number | null;
  readonly maxHp: number | null;
  onSelectRight(clientX: number, clientY: number): void;
}

export class TargetPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly armorMeter: Meter;
  // 直近の sync で受け取った状態。右クリックはフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: TargetPanelViewModel | null = null;

  // els を保持し、装甲バーを Meter ウィジェットで組み込み、パネル本体の
  // 右クリックイベントを最新のコールバックへ中継する。
  public constructor(private readonly els: HudEls) {
    this.armorMeter = new Meter('ターゲットの装甲');
    els.get('tgt-armor-meter').appendChild(this.armorMeter.element);
    this.els.get('tgtbody').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.view?.onSelectRight(e.clientX, e.clientY);
    });
  }

  // 固定対象の有無を毎フレーム反映し、値の更新は間引く。view が null ならターゲットが無い。
  public sync(view: TargetPanelViewModel | null, nowMs: number): void {
    this.view = view;
    // 表示/非表示はターゲット固定の有無に直結するので、更新間隔とは別に毎フレーム反映する。
    this.els.get('hud-target').classList.toggle('hidden', view === null);

    if (!this.throttle.due(nowMs)) return;
    this.syncTarget(view);
  }

  // 値を既存の DOM へ書き込む。target が null なら名前を空欄にする。
  private syncTarget(target: TargetPanelViewModel | null): void {
    if (!target) {
      this.els.setText('tgtname', '—');
      this.els.setText('hud-target-summary', '—');
      applyAlarmLevel(this.els.get('hud-target-summary'), 'normal');
      return;
    }

    // 名前・距離・速度系の基本値。
    this.els.setText('tgtname', target.name);
    const distance = fmtDistParts(target.distanceM);
    setReadout(this.els.get('tgt-dist'), distance.value, distance.unit);
    const closing = fmtSpeedParts(target.closingMps);
    setReadout(this.els.get('tgt-closing'), closing.value, closing.unit);
    const relative = fmtSpeedParts(target.relativeSpeedMps);
    setReadout(this.els.get('tgt-relative-speed'), relative.value, relative.unit);
    this.els.setText('hud-target-summary', fmtDist(target.distanceM));
    applyAlarmLevel(this.els.get('hud-target-summary'), 'normal');

    // 装甲メーターと数値表示。装甲を持たない対象では行ごと畳む。
    const { hp, maxHp } = target;
    this.els.get('tgt-armor-row').classList.toggle('hidden', hp === null || maxHp === null);
    if (hp !== null && maxHp !== null) {
      const clampedHp = Math.max(0, Math.min(maxHp, hp));
      const armorValue = `${Math.floor(clampedHp)}`;
      const armorUnit = `/ ${maxHp}`;
      // 装甲は減るほど撃破に近づくので、段を持たない。
      this.armorMeter.setProgress(clampedHp, maxHp, `${armorValue} ${armorUnit}`, 'normal');
      setReadout(this.els.get('tgt-armor-value'), armorValue, armorUnit);
    }
  }
}
