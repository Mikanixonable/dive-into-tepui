// 警報(状態)の評価器。物理量の測定値から項目ごとの段を境界で明滅しないように判定し、
// 警報の確認・並び・件数・警報音の出しどころ・警告の解除を1フレームごとの結果として持つ。
// 警報の状態は測定値から導かれるもので、保存しない。
import type { AlarmLevel } from '../../hud/alarm-level';
import {
  altitudeAlarmLevel, ammoAlarmLevel, dynamicPressureAlarmLevel, fuelAlarmLevel, temperatureAlarmLevel,
} from './alarm-level';

// 警報の項目。
export type AlarmItem = 'fuel' | 'temperature' | 'dynamicPressure' | 'altitude' | 'ammo';

// 未確認の警告が続くあいだ、警報音を繰り返す間隔 [ms]。
const WARNING_SOUND_INTERVAL_MS = 2000;

// 操作対象の測定値。持たない装備・環境は null。
export interface AlarmMeasurements {
  readonly temperatureK: number;
  readonly maxTemperatureK: number;
  // 大気を受けない操作対象では null。
  readonly dynamicPressurePa: number | null;
  readonly maxDynamicPressurePa: number;
  readonly fuel: number;
  readonly maxFuel: number;
  // 機関砲を積まない操作対象では null。roundsInMag は装填中の弾倉の残弾、magsLeft は予備の弾倉の数。
  readonly ammo: { readonly roundsInMag: number; readonly magsLeft: number } | null;
  // 大気天体の高度を測れない操作対象では null。descentRateMps は下降が負、descending は降下率の警告。
  readonly altitude: {
    readonly meters: number; readonly descentRateMps: number; readonly descending: boolean;
  } | null;
}

// 警報の段(平常を除く)。
export type RaisedAlarmLevel = Exclude<AlarmLevel, 'normal'>;

// 出ている警報1件。項目ごとに高々1件で、同じ項目が昇格したら段だけが上がる。
export interface ActiveAlarm {
  readonly item: AlarmItem;
  readonly level: RaisedAlarmLevel;
  readonly acknowledged: boolean;
  // 項目の主な測定値(温度 [K]・動圧 [Pa]・燃料の残り割合 0〜1・高度 [m]・予備の弾倉数)。
  readonly value: number;
  // 項目の補助の測定値(高度の下降率 [m/s]・装填中の残弾)。持たない項目は null。
  readonly secondaryValue: number | null;
}

// 項目ごとの内部記録。seq は出た(昇格した)順で、新しいほど大きい。
interface AlarmRecord {
  level: RaisedAlarmLevel;
  seq: number;
  acknowledged: boolean;
  reachedWarning: boolean;
  value: number;
  secondaryValue: number | null;
}

const LEVEL_RANK: Readonly<Record<AlarmLevel, number>> = { normal: 0, caution: 1, warning: 2 };

// 項目 item の測定値から求めた段・主な測定値・補助の測定値。測れない項目は normal。
function judge(
  item: AlarmItem, m: AlarmMeasurements, previous: AlarmLevel,
): { level: AlarmLevel; value: number; secondaryValue: number | null } {
  switch (item) {
    case 'temperature':
      return {
        level: temperatureAlarmLevel(m.temperatureK, m.maxTemperatureK, previous),
        value: m.temperatureK, secondaryValue: null,
      };
    case 'dynamicPressure': {
      if (m.dynamicPressurePa === null) return { level: 'normal', value: 0, secondaryValue: null };
      return {
        level: dynamicPressureAlarmLevel(m.dynamicPressurePa, m.maxDynamicPressurePa, previous),
        value: m.dynamicPressurePa, secondaryValue: null,
      };
    }
    case 'fuel':
      return {
        level: fuelAlarmLevel(m.fuel, m.maxFuel, previous),
        value: m.maxFuel > 0 ? Math.max(0, m.fuel / m.maxFuel) : 0, secondaryValue: null,
      };
    case 'altitude': {
      if (m.altitude === null) return { level: 'normal', value: 0, secondaryValue: null };
      return {
        level: altitudeAlarmLevel(m.altitude.meters, m.altitude.descending, previous),
        value: m.altitude.meters, secondaryValue: m.altitude.descentRateMps,
      };
    }
    case 'ammo': {
      if (m.ammo === null) return { level: 'normal', value: 0, secondaryValue: null };
      return {
        level: ammoAlarmLevel(m.ammo.roundsInMag, m.ammo.magsLeft),
        value: m.ammo.magsLeft, secondaryValue: m.ammo.roundsInMag,
      };
    }
  }
}

const ITEMS: readonly AlarmItem[] = ['fuel', 'temperature', 'dynamicPressure', 'altitude', 'ammo'];

export class AlarmEvaluator {
  private readonly records = new Map<AlarmItem, AlarmRecord>();
  private nextSeq = 0;
  // 測定値を一度でも受けたか。最初の測定値で既に出ている警報は、確認済み・無音で引き継ぐ。
  private adopted = false;
  private lastWarningSoundMs = Number.NEGATIVE_INFINITY;
  private _alarms: readonly ActiveAlarm[] = [];
  private _sound: RaisedAlarmLevel | null = null;
  private _clearedWarnings: readonly AlarmItem[] = [];

  // 出ている警報。警告が先、同じ段では新しいものが先。
  public get alarms(): readonly ActiveAlarm[] { return this._alarms; }

  // 直近の update で鳴らすべき警報音の段。注意は出たとき1回、未確認の警告は確認まで繰り返す。
  // 鳴らさないなら null。
  public get sound(): RaisedAlarmLevel | null { return this._sound; }

  // 直近の update で、警告から戻って消えた項目。
  public get clearedWarnings(): readonly AlarmItem[] { return this._clearedWarnings; }

  // 注意の件数。
  public get cautionCount(): number { return this._alarms.filter((alarm) => alarm.level === 'caution').length; }

  // 警告の件数。
  public get warningCount(): number { return this._alarms.filter((alarm) => alarm.level === 'warning').length; }

  // 未確認の警告があるか。警報灯の点滅と警報音の繰り返しが続く間は true。
  public get hasUnacknowledgedWarning(): boolean {
    return this._alarms.some((alarm) => alarm.level === 'warning' && !alarm.acknowledged);
  }

  // 項目 item の現在の段。出ていなければ normal。
  public levelOf(item: AlarmItem): AlarmLevel {
    return this.records.get(item)?.level ?? 'normal';
  }

  // 出ている警報をすべて確認済みにする。警報は条件が戻るまで残る。
  public acknowledge(): void {
    for (const record of this.records.values()) record.acknowledged = true;
    this._alarms = this.sorted();
  }

  // 測定値 measurements(操作対象が無ければ null)から全項目の段を求め直す。nowMs は実時刻 [ms]。
  // null のときは警報をすべて、解除の通知も音も無しで取り下げる。
  public update(nowMs: number, measurements: AlarmMeasurements | null): void {
    this._sound = null;
    this._clearedWarnings = [];
    if (measurements === null) {
      this.records.clear();
      this._alarms = [];
      return;
    }
    const silentAdoption = !this.adopted;
    this.adopted = true;
    let raised: AlarmLevel = 'normal';
    const cleared: AlarmItem[] = [];
    for (const item of ITEMS) {
      const previous = this.records.get(item);
      const judged = judge(item, measurements, previous?.level ?? 'normal');
      if (judged.level === 'normal') {
        if (previous?.reachedWarning) cleared.push(item);
        this.records.delete(item);
        continue;
      }
      // 新しく出た・昇格した警報は未確認から始まる。降格は確認の状態を引き継ぐ。
      const escalated = previous === undefined || LEVEL_RANK[judged.level] > LEVEL_RANK[previous.level];
      this.records.set(item, {
        level: judged.level,
        seq: previous === undefined || escalated ? this.nextSeq++ : previous.seq,
        acknowledged: previous === undefined || escalated ? silentAdoption : previous.acknowledged,
        reachedWarning: judged.level === 'warning' || (previous?.reachedWarning ?? false),
        value: judged.value,
        secondaryValue: judged.secondaryValue,
      });
      if (escalated && !silentAdoption && LEVEL_RANK[judged.level] > LEVEL_RANK[raised]) raised = judged.level;
    }
    this._alarms = this.sorted();
    this._clearedWarnings = cleared;
    this._sound = this.soundDue(nowMs, raised);
  }

  // 今回の update で出た・昇格した最も重い段 raised から、鳴らす警報音を決める。
  private soundDue(nowMs: number, raised: AlarmLevel): RaisedAlarmLevel | null {
    const repeating = this.hasUnacknowledgedWarning && nowMs - this.lastWarningSoundMs >= WARNING_SOUND_INTERVAL_MS;
    if (raised === 'warning' || repeating) {
      this.lastWarningSoundMs = nowMs;
      return 'warning';
    }
    return raised === 'caution' ? 'caution' : null;
  }

  // 記録を、警告が先・同じ段では新しいものが先に並べた警報の列にする。
  private sorted(): readonly ActiveAlarm[] {
    return [...this.records.entries()]
      .sort(([, a], [, b]) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.seq - a.seq)
      .map(([item, record]) => ({
        item,
        level: record.level,
        acknowledged: record.acknowledged,
        value: record.value,
        secondaryValue: record.secondaryValue,
      }));
  }
}
