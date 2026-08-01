// ダークテーマ色定数の唯一の定義元。
// フラットダークテーマ: ほぼ黒の面に単色グレー、アクセントはオレンジ 1 色のみ。
import * as C from './const';

export const ACCENT = C.COLOR_ACCENT;
export const ACCENT_RGB = '255, 106, 0';
export const ACCENT_SOFT = C.COLOR_ACCENT_SOFT;
export const SURFACE = 'rgba(13, 15, 18, 0.82)';
export const SURFACE_OPAQUE = 'rgba(13, 15, 18, 0.92)'; // main.ts の選択画面・ローディング用
export const EDGE = 'rgba(255, 255, 255, 0.09)';
export const BG = C.COLOR_BG;
export const TEXT = C.COLOR_TEXT;
export const TEXT_DIM = C.COLOR_TEXT_DIM;
export const FONT = "'JetBrains Mono', 'HackGen', monospace";
