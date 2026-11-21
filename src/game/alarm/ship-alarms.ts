// 操作艦の警報(状態)の評価と「確認済み」の記憶。鳴る条件と段の閾値は alarm-level.ts、
// 見せ方(警報灯・警報帯・警報音・確認)は UI-DESIGN.md「警報と通知」が正本。
import { type AlarmLevel, worstAlarmLevel } from '../../hud-kit/alarm-level';
import { MAX_HULL_TEMP } from '../dynamic/dynamic-entity/combat-ship-entity';
import { temperatureAlarmLevelHeld } from './alarm-level';

// 警報を識別する id。評価する条件が増えたときに足す。
export type ShipAlarmId = 'hullTemperature';

// 警報灯・警報帯が読む、鳴っている警報の1件。
export interface ShipAlarm {
  readonly id: ShipAlarmId;
  // 鳴っている段なので 'normal' は来ない。
  readonly level: Exclude<AlarmLevel, 'normal'>;
  // 警告として確認済みか。注意の段に確認は無い。
  readonly acknowledged: boolean;
}

export class ShipAlarms {
  private temperatureLevel: AlarmLevel = 'normal';
  private temperatureAcknowledged = false;

  // このフレームの操作艦の物理量から、鳴っている警報を組み直す。操作艦がいなければ全解除。
  // temperatureK は船体温度 [K]。
  public update(temperatureK: number | null): void {
    const level = temperatureK === null
      ? 'normal'
      : temperatureAlarmLevelHeld(this.temperatureLevel, temperatureK, MAX_HULL_TEMP);
    // 警告に新しく入るときと、警告以外へ出るときは、次の警告のために確認を戻す。
    if (level !== 'warning' || this.temperatureLevel !== 'warning') {
      this.temperatureAcknowledged = false;
    }
    this.temperatureLevel = level;
  }

  // 鳴っている警報の一覧。重い段が先。
  public get entries(): readonly ShipAlarm[] {
    const level = this.temperatureLevel;
    return level === 'normal'
      ? []
      : [{
        id: 'hullTemperature',
        level,
        acknowledged: this.temperatureAcknowledged,
      }];
  }

  // 鳴っている警報の件数。警報灯が集計に使う。
  public get count(): number {
    return this.entries.length;
  }

  // 鳴っている警報の最も重い段。鳴っていなければ 'normal'。
  public get worst(): AlarmLevel {
    return worstAlarmLevel(...this.entries.map((alarm) => alarm.level));
  }

  // 未確認の警告が鳴っていれば真。警報音と警報帯の点滅が読む。
  public get unacknowledgedWarning(): boolean {
    return this.entries.some((alarm) => alarm.level === 'warning' && !alarm.acknowledged);
  }

  // 鳴っている警告をすべて確認済みにする。確認しても警報は条件が戻るまで残る。
  public acknowledge(): void {
    if (this.temperatureLevel === 'warning') this.temperatureAcknowledged = true;
  }
}
