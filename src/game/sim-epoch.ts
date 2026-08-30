import {
  calendarDateToJulianDate, ephemerisSeconds, parseCalendarDate, TdbJulianDate,
} from '../physics/time';

// simTime=0 の元期。遠未来UTCは定義できないため、天体力学ではTDBとして解釈する。
// HUDは同じ暦フィールドを作中日時ラベルとして表示する。
export const SIM_EPOCH_TDB = '20115-05-14T06:00:00';

export const SIM_EPOCH_CALENDAR_TDB = parseCalendarDate(SIM_EPOCH_TDB, 'TDB');
// 元期はこの1つだけが正本。ET 秒が要る場所は ephemerisSeconds() で導く — 同じ瞬間を
// 2つ持つと、片方だけを差し替えたときに解析暦と暦パックが別々の時刻を答える。
export const SIM_EPOCH: TdbJulianDate = calendarDateToJulianDate(SIM_EPOCH_CALENDAR_TDB);

// "YYYY...-MM-DDTHH:MM:SS" を表示用の unix 秒相当へ変換する。年は4桁を超えてよい。
// Date.parse は ECMA-262 の拡張年表記(符号付き6桁)以外の 5桁以上の年を NaN にするため、
// Date.parse ではなく年ごと数値で取り出して Date.UTC へ渡す。
function parseDisplayIso(iso: string): number {
  const m = /^(\d+)-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
}

// simTime=0 に対応する絶対時刻 [unix s]。作中カレンダーの表示・日界線目盛用。
export const SIM_EPOCH_SEC = parseDisplayIso(SIM_EPOCH_TDB);

// クリエイティブモードの開始日時指定(GAME.md 9.0)向け: 拡張ISO風の日時文字列(TDB)を、
// SIM_EPOCH_TDB からのオフセット秒(= simTime の初期値)へ変換する。パースできない日時は null。
export function dateStringToSimTime(text: string): number | null {
  try {
    return ephemerisSeconds(parseCalendarDate(text, 'TDB')) - ephemerisSeconds(SIM_EPOCH);
  } catch {
    return null;
  }
}
