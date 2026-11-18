// 写しの凡例。figure の下の箱へ、いまの写しの色の読み方を 1 行と色見本で出す。
// 天気図は地図の中に凡例を持つので、この箱は写しのあいだだけ出す。
import type { ViewLegend } from './views';

// 凡例の箱へ写しの読み方を出す関数を返す。null を渡すと箱を隠す。
export function createViewLegend(box: HTMLElement): (legend: ViewLegend | null) => void {
  return (legend) => {
    box.replaceChildren();
    box.style.display = legend === null ? 'none' : '';
    if (legend === null) return;
    const text = document.createElement('span');
    text.textContent = legend.text;
    box.appendChild(text);
    for (const [css, label] of legend.swatches ?? []) {
      const item = document.createElement('span');
      const chip = document.createElement('i');
      chip.className = 'chip';
      chip.style.background = css;
      item.append(chip, label);
      box.appendChild(item);
    }
  };
}
