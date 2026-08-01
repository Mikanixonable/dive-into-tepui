// HUD 表示用の数値整形。

// パネル用距離表記(例: "420 m" / "1.23 km" / "1.50 Mm")
export function fmtDist(m: number): string {
  if (!isFinite(m)) return '---';
  if (Math.abs(m) >= 1e6) return `${(m / 1e6).toFixed(2)} Mm`;
  if (Math.abs(m) >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

// マーカーラベル用コンパクト距離表記(例: "420m" / "2.2km")
export function fmtMarkerDist(m: number, kmDecimals = 1): string {
  return m >= 1000 ? `${(m / 1000).toFixed(kmDecimals)}km` : `${m.toFixed(0)}m`;
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

// "HH:MM:SS"
export function fmtTime(s: number): string {
  if (!isFinite(s)) return '--:--:--';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
