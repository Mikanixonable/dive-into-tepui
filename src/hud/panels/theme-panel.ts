import { applyThemePalette, currentThemePalette, THEME_PRESETS } from '../../theme';
import { Button } from '../widgets';

// 設定ビューの「配色」タブ。テーマプリセットをボタン一覧で並べ、押したテーマを即座に適用する。
// 選択状態はボタン自身の点灯だけで持ち、専用のフィールドは持たない。
export class ThemePanel {
  public readonly element: HTMLElement;

  // 現在適用中のテーマを検出し、プリセットの一覧をボタン化して並べる。
  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'sv-theme-options';

    const themeButtons = new Map<string, Button>();
    let activeThemeId = currentThemePalette().id;
    // プリセットごとにボタンを1つ作る。押すと配色を切り替え、選択中のボタンだけを点灯させる。
    for (const palette of THEME_PRESETS) {
      const previewColors = [palette.page, palette.surface1, palette.title, palette.accent, palette.signal];
      const preview = `<span class="sv-theme-preview">${previewColors
        .map((color) => `<span class="sv-theme-swatch" style="background-color: ${color}"></span>`)
        .join('')}</span>`;
      const themeButton = new Button(
        palette.name,
        () => {
          if (!applyThemePalette(palette.id)) return;
          activeThemeId = palette.id;
          for (const [id, button] of themeButtons) button.setOn(id === activeThemeId);
        },
        `<span class="sv-theme-icon">${preview}</span>`,
      );
      themeButton.element.classList.add('sv-theme-button');
      themeButton.element.style.setProperty('--sv-theme-page', palette.page);
      themeButton.element.style.setProperty('--sv-theme-title', palette.title);
      themeButton.element.title = palette.description;
      themeButton.element.setAttribute('aria-label', `${palette.name}: ${palette.description}`);
      themeButtons.set(palette.id, themeButton);
      this.element.appendChild(themeButton.element);
    }
    // 起動時点で適用されているテーマのボタンを点灯させておく。
    for (const [id, button] of themeButtons) button.setOn(id === activeThemeId);
  }
}
