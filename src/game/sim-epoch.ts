import * as C from './const';
import {
  calendarDateToJulianDate, ephemerisSeconds, parseCalendarDate,
} from '../physics/time';

export const SIM_EPOCH_CALENDAR_TDB = parseCalendarDate(C.SIM_EPOCH_TDB, 'TDB');
export const SIM_EPOCH_JD_TDB = calendarDateToJulianDate(SIM_EPOCH_CALENDAR_TDB).value;
export const SIM_EPOCH_ET = ephemerisSeconds(SIM_EPOCH_CALENDAR_TDB);

// クリエイティブモードの開始日時指定(GAME.md 9.0)向け: 拡張ISO風の日時文字列(TDB)を、
// SIM_EPOCH_TDB からのオフセット秒(= simTime の初期値)へ変換する。パースできない日時は null。
export function dateStringToSimTime(text: string): number | null {
  try {
    return ephemerisSeconds(parseCalendarDate(text, 'TDB')) - SIM_EPOCH_ET;
  } catch {
    return null;
  }
}
