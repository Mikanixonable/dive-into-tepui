// 時間軸パネルの部品。上段の読み値・次の事象と予測率・「⋯」・凡例・トラックの DOM を組む。
import { Button, ToggleValueEdit, type Slider } from '../../../hud/widgets';
import { ORBIT_POINT_GLYPH } from '../../marker/marker-identity';

// 凡例の1項目: 字形・説明・時間軸の目盛りと同じ持ち主の色。
const LEGEND: readonly (readonly [string, string, 'neutral' | 'own' | 'target'])[] = [
  [ORBIT_POINT_GLYPH.apsis, '近点 / 遠点', 'neutral'],
  [`${ORBIT_POINT_GLYPH.ascendingNode}${ORBIT_POINT_GLYPH.descendingNode}`, '昇交点 / 降交点', 'neutral'],
  [ORBIT_POINT_GLYPH.closestApproach, '再接近(ターゲット)', 'target'],
  [ORBIT_POINT_GLYPH.maneuverNode, 'ノード', 'own'],
  ['▏', '現在', 'neutral'],
];

// 上段の読み値(T+ 経過時間・絶対日時・ジャンプ入力)。
export interface ReadoutRow {
  readonly element: HTMLElement;
  readonly elapsedLabel: HTMLElement;
  readonly absoluteLabel: HTMLElement;
  readonly jumpToggle: ToggleValueEdit;
}

// 上段の右側(次の事象・予測率)。
export interface StatusRow {
  readonly nextButton: Button;
  readonly nextLabel: HTMLElement;
  readonly predictionLabel: HTMLElement;
}

// 時間軸のトラック。bar は過去の帯とスライダーを横に並べ、その下に軸のラベルの層を置く。
export interface TrackParts {
  readonly element: HTMLElement;
  readonly bar: HTMLElement;
  readonly pastBand: HTMLElement;
  readonly ticks: HTMLElement;
}

// T+ 読み値と絶対日時を組む。T+ はクリックでジャンプ入力(jumpToggle)へ差し替わる。
// openSeed は入力を開くときの初期値と上限 [s] を返す。
export function buildReadoutRow(
  onJump: (sec: number) => void, openSeed: () => { readonly sec: number; readonly max: number },
): ReadoutRow {
  const element = document.createElement('div');
  element.className = 'tml-read';
  const elapsedLabel = document.createElement('span');
  elapsedLabel.className = 'tml-elapsed';
  elapsedLabel.title = 'クリックして時刻へジャンプ';
  elapsedLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
  const jumpEditEl = document.createElement('span');
  jumpEditEl.className = 'predict-value-input hidden';
  const jumpToggle = new ToggleValueEdit(elapsedLabel, jumpEditEl, 'hour', onJump);
  elapsedLabel.addEventListener('click', () => {
    const seed = openSeed();
    jumpToggle.open(seed.sec, 0, seed.max);
  });
  jumpEditEl.appendChild(jumpToggle.inputEl);
  const absoluteLabel = document.createElement('span');
  absoluteLabel.className = 'tml-date';
  element.append(elapsedLabel, jumpEditEl, absoluteLabel);
  return { element, elapsedLabel, absoluteLabel, jumpToggle };
}

// 次の事象へ飛ぶボタンと予測率の読み値を組む。
export function buildStatusRow(onNext: () => void): StatusRow {
  const nextLabel = document.createElement('span');
  const nextButton = new Button('', onNext, undefined, ['dense', 'secondary']);
  nextButton.element.title = '次の事象へ飛ぶ';
  nextButton.element.appendChild(nextLabel);
  const predictionLabel = document.createElement('span');
  predictionLabel.className = 'tml-pred';
  return { nextButton, nextLabel, predictionLabel };
}

// 「⋯」ボタン。
export function buildSettingsButton(onPress: (button: HTMLElement) => void): Button {
  const button = new Button('⋯', () => onPress(button.element));
  button.element.classList.add('w-btn--icon');
  button.element.title = '目盛りと凡例';
  button.element.setAttribute('aria-label', '目盛りと凡例');
  return button;
}

// 時間軸に載せる事象の字形と、その意味の凡例。
export function buildLegend(): HTMLElement {
  const legend = document.createElement('div');
  legend.className = 'tml-legend';
  for (const [glyph, text, tone] of LEGEND) {
    const item = document.createElement('span');
    item.className = `tml-legend-item is-${tone}`;
    const glyphEl = document.createElement('b');
    glyphEl.textContent = glyph;
    item.append(glyphEl, text);
    legend.appendChild(item);
  }
  return legend;
}

// トラックを組む。過去の帯(静的な履歴)・スライダー(未来側の値域)を横に並べ、軸のラベルの層を
// その下に敷く。過去の帯は過去を選ぶまで出さない。
export function buildTrack(slider: Slider): TrackParts {
  const element = document.createElement('div');
  element.className = 'tml-track';
  const bar = document.createElement('div');
  bar.className = 'tml-bar';
  const pastBand = document.createElement('div');
  pastBand.className = 'tml-past hidden';
  bar.append(pastBand, slider.frame);
  const ticks = document.createElement('div');
  ticks.className = 'slider-ticks';
  element.append(bar, ticks);
  return { element, bar, pastBand, ticks };
}
