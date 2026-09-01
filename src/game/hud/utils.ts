// HUD 表示用の数値整形と、data-id で引いた要素への書き込み。
import { julianDateToCalendarDate, TdbJulianDate } from '../../physics/time';
import { MAG_ROUNDS } from '../player/player-fire';

// data-id マップから id の要素を引き、表示中の文字列と異なるときだけ書き換える。
export function setElementText(els: ReadonlyMap<string, HTMLElement>, id: string, text: string): void {
  const element = els.get(id);
  if (element && element.textContent !== text) element.textContent = text;
}

// パネル用距離表記(例: "420 m" / "1.23 km" / "1.50 Mm")
export function fmtDist(m: number): string {
  if (!isFinite(m)) return '---';
  if (Math.abs(m) >= 1e6) return `${(m / 1e6).toFixed(2)} Mm`;
  if (Math.abs(m) >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

// マーカーラベル用コンパクト距離表記(例: "420m" / "2.2km")
export function fmtMarkerDist(m: number, kmDecimals = 1): string {
  return Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(kmDecimals)}km` : `${m.toFixed(0)}m`;
}

// パネル用電力量表記(例: "820 kJ" / "1.50 MJ")
export function fmtEnergy(j: number): string {
  if (!isFinite(j)) return '---';
  if (Math.abs(j) >= 1e6) return `${(j / 1e6).toFixed(2)} MJ`;
  if (Math.abs(j) >= 1e3) return `${(j / 1e3).toFixed(0)} kJ`;
  return `${j.toFixed(0)} J`;
}

// パネル用速度表記(例: "7.80 km/s" / "12.3 m/s")
export function fmtSpeed(ms: number): string {
  if (!isFinite(ms)) return '---';
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(2)} km/s`;
  return `${ms.toFixed(1)} m/s`;
}

// ランの元期(simTime=0 が指す絶対時刻)を、fmtDateTime へ渡せる unix 秒相当へ写す。
// simTime を足せばその瞬間の表示用 unix 秒になる。**Date.UTC は西暦 0〜99 年を 1900+year
// へ写す**ので、年だけは setUTCFullYear で入れ直す — 開始日時は西暦0年以降を受ける。
export function epochUnixSeconds(epoch: TdbJulianDate): number {
  const c = julianDateToCalendarDate(epoch);
  const date = new Date(0);
  date.setUTCFullYear(c.year, c.month - 1, c.day);
  date.setUTCHours(c.hour, c.minute, c.second, 0);
  return date.getTime() / 1000;
}

// UTC 絶対時刻を ISO 8601 (例: "2026-08-08T14:16:00") で表記する。toISOString() の
// 拡張年表記(4桁を超える年に符号を前置する形式)は遠未来の年代と噛み合わないので使わず、
// 各成分を直接取り出して組む。
export function fmtDateTime(unixSec: number): string {
  if (!isFinite(unixSec)) return '-------------------';
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// 経過秒 sec を単位付きで表記する(例: "0Y-01M-02D-03h-04m-05s")。年だけ自由桁、
// 月日時分秒は2桁固定。1970-01-01T00:00:00 UTC を経過0とする換算(年月日は暦通りの繰り上がり)。
export function fmtElapsedUnits(sec: number): string {
  if (!isFinite(sec)) return '--';
  const d = new Date(Math.max(0, sec) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear() - 1970;
  const mo = pad(d.getUTCMonth());
  const day = pad(d.getUTCDate() - 1);
  return `${y}Y-${mo}M-${day}D-${pad(d.getUTCHours())}h-${pad(d.getUTCMinutes())}m-${pad(d.getUTCSeconds())}s`;
}

// 経過秒 sec を、目盛り間隔 unitHintSec が示す単位で表記する
// (1時間未満なら分、1日未満なら時間、30日未満なら日、それ以上は1ヶ月=30日換算の月)。
// 例: "30m" / "6h" / "10d" / "3mo"
export function fmtDuration(sec: number, unitHintSec: number): string {
  if (!isFinite(sec)) return '--';
  if (sec === 0) return '0';
  if (unitHintSec < 3600) return `${Math.round(sec / 60)}m`;
  if (unitHintSec < 86400) return `${Math.round(sec / 3600)}h`;
  if (unitHintSec < 30 * 86400) return `${Math.round(sec / 86400)}d`;
  return `${Math.round(sec / (30 * 86400))}mo`;
}

// 弾薬状態の表記(例: "RELOADING..." / "弾切れ" / "18/32 +2連")。バレル交換中は
// 装弾数によらずリロード表示を優先する。
export function fmtAmmoStatus(roundsInMag: number, magsLeft: number, reloadTimer: number): string {
  if (reloadTimer > 0) return 'RELOADING...';
  if (roundsInMag <= 0 && magsLeft <= 0) return '弾切れ';
  return `${roundsInMag}/${MAG_ROUNDS} +${magsLeft}連`;
}

// "HH:MM:SS"
export function fmtTime(s: number): string {
  if (!isFinite(s)) return '--:--:--';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
