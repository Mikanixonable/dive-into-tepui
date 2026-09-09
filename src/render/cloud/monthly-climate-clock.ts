// Unix秒をUTCカレンダーの月番号と、その月から翌月への補間率へ変換する。

export interface MonthlyClimateClock {
  readonly monthIndex: number;
  readonly blend: number;
}

function monthStart(year: number, monthIndex: number): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, monthIndex, 1);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export function monthlyClimateClockAt(unixSeconds: number): MonthlyClimateClock {
  if (!Number.isFinite(unixSeconds)) throw new RangeError('Climate time must be finite');
  const date = new Date(unixSeconds * 1000);
  const start = monthStart(date.getUTCFullYear(), date.getUTCMonth());
  const next = monthStart(date.getUTCFullYear(), date.getUTCMonth() + 1);
  const span = next.getTime() / 1000 - start.getTime() / 1000;
  const blend = (unixSeconds - start.getTime() / 1000) / span;
  return { monthIndex: date.getUTCMonth(), blend };
}
