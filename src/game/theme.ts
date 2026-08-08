// ダークテーマ色定数の唯一の定義元。
// フラットダークテーマ: ほぼ黒の面に単色グレー、アクセントは基本オレンジ 1 色。
// 第二ターゲットの識別だけはオレンジと混同できないシアンを別アクセントとして使う。
import * as C from './const';

export const ACCENT = C.COLOR_ACCENT;
export const ACCENT_RGB = C.COLOR_ACCENT_RGB;
export const ACCENT_SOFT = C.COLOR_ACCENT_SOFT;
export const ACCENT_SECONDARY = C.COLOR_ACCENT_SECONDARY;
// 第一ターゲット・危険状態専用色。通常の操作アクセント(オレンジ)と意味を分離する。
export const WARNING = '#ff4f5e';
export const SURFACE = 'rgba(13, 15, 18, 0.82)';
export const SURFACE_OPAQUE = 'rgba(13, 15, 18, 0.92)'; // 背後を透過させたくない全画面表示用
export const EDGE = 'rgba(238, 235, 248, 0.22)';
export const BG = C.COLOR_BG;
export const TEXT = C.COLOR_TEXT;
export const TEXT_DIM = C.COLOR_TEXT_DIM;
export const FONT = "'JetBrains Mono', 'HackGen', monospace";
