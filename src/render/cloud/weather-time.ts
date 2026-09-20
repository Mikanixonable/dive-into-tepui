// 雲モデルが使うシミュレーション時刻の分解。日付や表示経路を直接雲の状態へ持ち込まず、
// 大きな浮動小数点値でも日周位相を安定して取り出す。

export const SIMULATION_DAY_SECONDS = 24 * 60 * 60;

export interface SimulationDayTime {
  readonly dayIndex: number;
  readonly secondsOfDay: number;
}

// シミュレーション秒を、負の時刻にも対応する日番号と 0..1 日の秒へ分解する。
export function splitSimulationTime(seconds: number): SimulationDayTime {
  if (!Number.isFinite(seconds)) return { dayIndex: 0, secondsOfDay: 0 };
  const dayIndex = Math.floor(seconds / SIMULATION_DAY_SECONDS);
  const secondsOfDay = seconds - dayIndex * SIMULATION_DAY_SECONDS;
  return { dayIndex, secondsOfDay };
}

// Unix epoch millisecondsを、シミュレーションの絶対時刻として扱うときの分解。時刻の大きさを
// そのまま shader へ渡さず、日番号と日内秒だけを渡すための境界関数。
export function splitEpochTime(epochUnixMs: number): SimulationDayTime {
  return splitSimulationTime(epochUnixMs / 1000);
}

// 2回の表示時刻から、1フレームで進んだシミュレーション時間を得る。時刻を逆向きに動かす
// scrub は時間LOD上では同じ幅の評価として扱う。
export function simulationSecondsPerFrame(previous: number | null, current: number): number {
  if (previous === null || !Number.isFinite(previous) || !Number.isFinite(current)) return 0;
  return Math.abs(current - previous);
}
