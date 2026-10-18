// 注意と警告の段。読み値・メーター・警報が同じ語彙で段を受け渡す。

// 正常は色を持たず、注意と警告だけが色と記号(△ ▲)を伴う。
export type AlarmLevel = 'normal' | 'caution' | 'warning';

// element の段を ui-caution / ui-warning で表す。normal ではどちらも外れる。
export function applyAlarmLevel(element: HTMLElement, level: AlarmLevel): void {
  element.classList.toggle('ui-caution', level === 'caution');
  element.classList.toggle('ui-warning', level === 'warning');
}

const LEVEL_RANK: Readonly<Record<AlarmLevel, number>> = { normal: 0, caution: 1, warning: 2 };

// levels のうち最も重い段を返す。空なら normal。
export function worstAlarmLevel(...levels: readonly AlarmLevel[]): AlarmLevel {
  return levels.reduce<AlarmLevel>((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), 'normal');
}
