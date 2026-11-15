// 時刻の単位。モデルは秒で時間を進め、画面は時で扱う。換算と周期の定数はここだけに置く。
export const SECONDS_PER_HOUR = 3600;
export const HOURS_PER_DAY = 24;
// 再生は 1 年で頭へ戻る。モデルは暦を持たないので、年は区切りの長さにすぎない。
export const YEAR_HOURS = 365 * HOURS_PER_DAY;

export const wrapYear = (hours: number): number => ((hours % YEAR_HOURS) + YEAR_HOURS) % YEAR_HOURS;
