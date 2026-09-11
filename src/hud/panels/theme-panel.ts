import { currentThemePalette, THEME_PRESETS } from '../../theme';
import { Button } from '../widgets';

// 配色の設定面。テーマプリセットをボタン一覧で並べ、選ばれた配色の id を onSelect で外へ返す。
// 選択状態はボタン自身の点灯で持つ。
export class ThemePanel {
  public readonly element: HTMLElement;

  // 配色が選ばれたときに呼ばれる。
  public onSelect: ((id: string) => void) | null = null;

  // 現在適用中のテーマを検出し、プリセットの一覧をボタン化して並べる。
  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'sv-theme-options';

    const themeButtons = new Map<string, Button>();
    // 点灯を id の指すボタン1つへ寄せる。
    const lightOnly = (activeId: string): void => {
      for (const [id, button] of themeButtons) button.setOn(id === activeId);
    };
    // プリセットごとにボタンを1つ作る。押すと点灯を移し、選ばれた id を外へ返す。
    for (const palette of THEME_PRESETS) {
      const previewColors = [palette.page, palette.surface1, palette.title, palette.accent, palette.signal];
      const preview = `<span class="sv-theme-preview">${previewColors
        .map((color) => `<span class="sv-theme-swatch" style="background-color: ${color}"></span>`)
        .join('')}</span>`;
      const themeButton = new Button(
        palette.name,
        () => {
          lightOnly(palette.id);
          this.onSelect?.(palette.id);
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
    lightOnly(currentThemePalette().id);
  }
}
