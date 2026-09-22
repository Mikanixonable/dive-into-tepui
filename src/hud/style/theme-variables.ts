// 配色と寸法のトークンを :root へ適用するモジュール。#hud の外の要素からも参照できるよう :root に設定する。
import { themeCssVariables } from '../../theme';
import type { ThemePalette } from '../../theme';

// palette のトークン一式を :root のカスタムプロパティとして設定・反映する。何度呼んでもよく、
// 呼ぶたびに直前の配色を上書きする。
export function applyThemeVariables(palette: ThemePalette): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeCssVariables(palette))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = palette.tone;
  root.dataset['theme'] = palette.id;
}
