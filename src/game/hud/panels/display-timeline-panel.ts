// 未来表示の時間軸と、その期間・表示オプションを操作するパネル。
import {
  Button, DurationPillRow, EDGE_GRIP_HORIZONTAL_CLASS,
  Slider, ToggleSwitch, ToggleValueEdit,
  type CollapseToggleLabels,
} from '../../../hud-kit/widgets';
import { bindActivation } from '../../../hud-kit/widgets/widget-base';
import type { PanelCollapse } from '../panel-chrome';
import type { OverlayHandle, OverlayManager } from '../../../hud-kit/overlay-manager';
import { fmtDateTime, fmtDuration } from '../../../hud-kit/format';
import type { DisplayTick } from '../../../hud-kit/tick-scale';
import {
  APERIODIC_ARC_DURATION, DISPLAY_DURATION_MAX,
} from '../../viewer/display-timeline-selection';
import type {
  DisplayDurationKey, TickLabelMode,
} from '../../viewer/display-timeline-selection';

// 手動レンジで指定できる表示期間の下限 [s]。表示期間は予測列の保持窓でもあり、0 では
// サンプルが1件も残らず、どの時刻も引けない列になる。
const DISPLAY_DURATION_MIN = 3600;

// ピルで選べる期間。手動レンジ('custom')だけは入力欄が受け持つ。
type FixedDurationKey = Exclude<DisplayDurationKey, 'custom'>;

const FIXED_DURATIONS: readonly (readonly [FixedDurationKey, string])[] = [
  ['orbit', '1周'],
  ['day', '1日'],
  ['tenDay', '10日'],
  ['month', '1ヶ月'],
  ['threeMonth', '3ヶ月'],
];

// マップビュー下部のタイムラインバーの収納グリップの字形と読み上げ名。字形は押したときにバーが動く向き。
const TIMELINE_TOGGLE_LABELS: CollapseToggleLabels = {
  expandedGlyph: '▼',
  collapsedGlyph: '▲',
  expandedTitle: '下部パネルを閉じる',
  collapsedTitle: '下部パネルを開く',
};

// 帯を広げる行の2種。
type ExpandSection = 'range' | 'options';

// OverlayManager の台帳上の id。広げている行は1つまでなので1つで兼ねる。
const EXPAND_OVERLAY_ID = 'predict-expand';

// タイムラインパネルが1フレームに映す値。
interface DisplayTimelinePanelState {
  readonly visible: boolean;
  readonly durationKey: DisplayDurationKey;
  readonly tickLabelMode: TickLabelMode;
  readonly showElementTimes: boolean;
  readonly showTicks: boolean;
  // 表示期間 [s]。時間軸は T−duration 〜 T+duration で、中央が現在時刻。
  readonly duration: number;
  readonly displayTime: number;
  // ランの元期(simTime=0)の unix 秒相当。displayTime を足すと絶対日時になる。
  readonly epochUnixSec: number;
  readonly sliderSteps: number;
  // スクラブ位置。時間軸全域に対する位置で、0.5 が現在。
  readonly sliderT: number;
  // 予測が届いている先の、時間軸全域に対する位置(0.5..1)。これより右は未予測で減光する。
  readonly predictionRatio: number;
  readonly ticks: readonly DisplayTick[];
}

export class DisplayTimelinePanel {
  public onDurationSelect: ((key: FixedDurationKey) => void) | null = null;
  public onCustomDurationConfirm: ((sec: number) => void) | null = null;
  public onTickLabelModeChange: ((mode: TickLabelMode) => void) | null = null;
  public onShowElementTimesChange: ((show: boolean) => void) | null = null;
  public onShowTicksChange: ((show: boolean) => void) | null = null;
  public onSliderChange: ((t: number) => void) | null = null;
  public onResetToNow: (() => void) | null = null;
  public onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly durationButton: Button;
  private readonly optionsButton: Button;
  private readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
  private readonly rangeRow: HTMLElement;
  private readonly optionsRow: HTMLElement;
  private readonly tickLabelModeSwitch: ToggleSwitch;
  private readonly showTicksSwitch: ToggleSwitch;
  private readonly showElementTimesSwitch: ToggleSwitch;
  private readonly slider: Slider;
  private readonly absoluteLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly predictionLabel: HTMLElement;
  private readonly jumpToggle: ToggleValueEdit;
  private readonly ticks: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;
  private readonly occupancyObserver: ResizeObserver | null;

  private expand: ExpandSection | null = null;
  private sliderSteps = 1000;
  private currentDuration = APERIODIC_ARC_DURATION;
  private lastTrackRatio = 1;

  // タイムラインパネルの DOM を組み立て、root へ追加する。collapse は折りたたみトグルの配線役、
  // overlayManager は帯を広げる行の ESC・外側クリックでの自動クローズを引き受ける役。
  public constructor(
    root: HTMLElement, collapse: PanelCollapse, private readonly overlayManager: OverlayManager,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel editorial-instrument';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    // 1行の帯本体。
    const strip = document.createElement('div');
    strip.className = 'predict-strip';
    this.panel.appendChild(strip);

    const head = document.createElement('div');
    head.className = 'editorial-panel-head predict-head';
    head.innerHTML = '<span class="ui-section-code" aria-hidden="true">TML</span><h3 class="editorial-panel-title">ORBIT TIMELINE</h3>';
    strip.appendChild(head);

    // 期間操作。現在の表示期間を常に示し、押すと帯を広げる期間選択行が開く。
    this.durationButton = new Button('期間', () => this.setExpand('range'));
    this.durationButton.element.classList.add('predict-expando');
    this.durationButton.element.title = '表示期間を選ぶ';
    strip.appendChild(this.durationButton.element);

    // 表示オプション操作。目盛りの表記・目盛りの表示・軌道要素の時刻を帯の展開行で切り替える。
    this.optionsButton = new Button('表示', () => this.setExpand('options'));
    this.optionsButton.element.classList.add('predict-expando');
    this.optionsButton.element.title = '目盛りと時刻の表示オプション';
    strip.appendChild(this.optionsButton.element);

    // 時間軸。目盛り列はスクラバーの直上に同居させる。
    const axis = document.createElement('div');
    axis.className = 'predict-axis';
    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    axis.appendChild(this.ticks);
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'predict-slider-wrap';
    this.slider = new Slider(
      { min: 0, max: this.sliderSteps },
      (value) => this.onSliderChange?.(value / this.sliderSteps),
    );
    this.slider.element.title = 'ドラッグ、またはトラックをクリックして表示時刻を選ぶ';
    sliderWrap.appendChild(this.slider.element);
    axis.appendChild(sliderWrap);
    strip.appendChild(axis);

    const resetBtn = new Button('⏮', () => this.onResetToNow?.());
    resetBtn.element.classList.add('predict-reset', 'w-btn--icon');
    resetBtn.element.title = '現在に戻す';
    resetBtn.element.setAttribute('aria-label', '現在に戻す');
    strip.appendChild(resetBtn.element);

    // 表示時刻の読み出し。T± 読み値はクリックで直接ジャンプ入力に変わる。
    const readout = document.createElement('div');
    readout.className = 'predict-readout';
    this.elapsedLabel = document.createElement('strong');
    this.elapsedLabel.className = 'predict-elapsed';
    this.elapsedLabel.title = 'クリックして時刻へジャンプ';
    this.elapsedLabel.setAttribute('role', 'button');
    this.elapsedLabel.tabIndex = 0;
    this.elapsedLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
    bindActivation(this.elapsedLabel, () => this.jumpToggle.open(
      (this.slider.getValue() / this.sliderSteps) * 2 * this.currentDuration - this.currentDuration,
      -this.currentDuration, this.currentDuration,
    ));
    readout.appendChild(this.elapsedLabel);
    this.absoluteLabel = document.createElement('span');
    this.absoluteLabel.className = 'predict-absolute';
    readout.appendChild(this.absoluteLabel);
    const jumpEditEl = document.createElement('span');
    jumpEditEl.className = 'w-duration-input hidden';
    this.jumpToggle = new ToggleValueEdit(this.elapsedLabel, jumpEditEl, 'hour', (sec) => this.onJumpToTime?.(sec));
    jumpEditEl.appendChild(this.jumpToggle.inputEl);
    readout.appendChild(jumpEditEl);
    strip.appendChild(readout);

    // 予測が届いている割合。
    this.predictionLabel = document.createElement('span');
    this.predictionLabel.className = 'predict-pct';
    this.predictionLabel.title = '予測の届いている割合';
    strip.appendChild(this.predictionLabel);

    // 帯を広げる行: 期間選択。
    this.rangeRow = document.createElement('div');
    this.rangeRow.className = 'predict-expand hidden';
    this.durationRow = new DurationPillRow<FixedDurationKey, DisplayDurationKey>(
      '期間', FIXED_DURATIONS,
      (key) => this.onDurationSelect?.(key),
      (sec) => this.onCustomDurationConfirm?.(sec),
      DISPLAY_DURATION_MIN, DISPLAY_DURATION_MAX,
    );
    this.rangeRow.appendChild(this.durationRow.element);
    this.panel.appendChild(this.rangeRow);

    // 帯を広げる行: 表示オプション。
    this.optionsRow = document.createElement('div');
    this.optionsRow.className = 'predict-expand hidden';
    const modeRow = document.createElement('div');
    modeRow.className = 'w-pill-row';
    this.tickLabelModeSwitch = new ToggleSwitch(
      '目盛りを相対表記',
      (on) => this.onTickLabelModeChange?.(on ? 'relative' : 'absolute'),
    );
    modeRow.appendChild(this.tickLabelModeSwitch.element);
    this.showTicksSwitch = new ToggleSwitch(
      '目盛りを表示',
      (on) => this.onShowTicksChange?.(on),
    );
    modeRow.appendChild(this.showTicksSwitch.element);
    this.showElementTimesSwitch = new ToggleSwitch(
      '軌道要素の時刻を表示',
      (on) => this.onShowElementTimesChange?.(on),
    );
    modeRow.appendChild(this.showElementTimesSwitch.element);
    this.optionsRow.appendChild(modeRow);
    this.panel.appendChild(this.optionsRow);

    // トグルとバー本体を1つの縦積み flex にまとめ、バーを畳んでもトグルだけがその場に残るようにする。
    this.wrap = document.createElement('div');
    this.wrap.id = 'hud-predict-wrap';
    this.wrap.appendChild(this.panel);
    this.unsubscribeCollapsedView = collapse.wire({
      toggleRoot: this.wrap,
      toggleId: 'hud-predict-toggle',
      toggleClassName: EDGE_GRIP_HORIZONTAL_CLASS,
      target: this.panel,
      labels: TIMELINE_TOGGLE_LABELS,
      storageId: 'hud-predict',
    });
    root.appendChild(this.wrap);

    // compactではこのパネルを下部sheetとして扱うため、wrapの上端から画面下端までの実占有量を
    // map rootへ公開する。高さだけでなくbottom offsetも含め、touch UIの下端予約にも追従する。
    const syncOccupancy = (): void => {
      const rootRect = root.getBoundingClientRect();
      const wrapRect = this.wrap.getBoundingClientRect();
      root.style.setProperty(
        '--hud-predict-bottom-occupied',
        `${Math.max(0, Math.ceil(rootRect.bottom - wrapRect.top))}px`,
      );
    };
    syncOccupancy();
    requestAnimationFrame(syncOccupancy);
    if (typeof ResizeObserver !== 'undefined') {
      this.occupancyObserver = new ResizeObserver(syncOccupancy);
      this.occupancyObserver.observe(root);
      this.occupancyObserver.observe(this.wrap);
    } else {
      this.occupancyObserver = null;
    }
  }

  // 展開行の開閉と、ESC・外側クリックで閉じる登録を同期する。
  private setExpand(section: ExpandSection | null): void {
    const next = this.expand === section ? null : section;
    this.expand = next;
    // 表示行と選択状態をそろえたあと、閉じる操作の登録を更新する。
    this.rangeRow.classList.toggle('hidden', next !== 'range');
    this.optionsRow.classList.toggle('hidden', next !== 'options');
    this.durationButton.setOn(next === 'range');
    this.optionsButton.setOn(next === 'options');
    if (next === null) this.overlayManager.close(EXPAND_OVERLAY_ID);
    else {
      this.overlayManager.openMode(EXPAND_OVERLAY_ID, this.expandHandle, {
        closeOnEscape: true, closeOnOutsideClick: true, gatesInput: false,
      });
    }
  }

  // 帯を広げる行のオーバーレイハンドル。パネルの外を押したときと ESC で閉じる。
  private readonly expandHandle: OverlayHandle = {
    contains: (target) => this.wrap.contains(target),
    close: () => this.setExpand(null),
  };

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  public render(state: DisplayTimelinePanelState): void {
    this.setVisible(state.visible);
    if (!state.visible) return;
    // 期間はジャンプ入力の上限にもなるので控えておく。
    this.currentDuration = state.duration;
    this.durationRow.sync(state.durationKey, state.duration);
    this.durationButton.setLabel(`期間 ${this.durationLabel(state)}`);
    this.tickLabelModeSwitch.setOn(state.tickLabelMode === 'relative');
    this.showTicksSwitch.setOn(state.showTicks);
    this.showElementTimesSwitch.setOn(state.showElementTimes);
    this.renderSlider(state.sliderSteps, state.sliderT, state.predictionRatio);
    this.renderAbsoluteLabel(state.epochUnixSec + state.displayTime);
    const elapsed = (state.sliderT * 2 - 1) * state.duration;
    if (!this.jumpToggle.editing) this.renderElapsedLabel(elapsed);
    this.predictionLabel.textContent = `${Math.round((state.predictionRatio * 2 - 1) * 100)}%`;
    this.ticks.classList.toggle('hidden', !state.showTicks);
    this.renderTicks(state.ticks);
  }

  // 期間ボタンへ示す現在の期間の短い表記。プリセットは和名、手動レンジは経過時間書式。
  private durationLabel(state: DisplayTimelinePanelState): string {
    const fixed = FIXED_DURATIONS.find(([key]) => key === state.durationKey);
    return fixed !== undefined ? fixed[1] : fmtDuration(state.duration, state.duration);
  }

  // パネル本体を出し入れする。折りたたみトグルは外側に残る。隠れるときは広げた行も畳む。
  private setVisible(visible: boolean): void {
    if (!visible) this.setExpand(null);
    this.panel.classList.toggle('hidden', !visible);
  }

  // パネルの DOM を取り除き、折りたたみ状態変化の購読と論理登録を解除する。
  public dispose(): void {
    this.overlayManager.close(EXPAND_OVERLAY_ID);
    this.unsubscribeCollapsedView();
    this.occupancyObserver?.disconnect();
    this.wrap.parentElement?.style.removeProperty('--hud-predict-bottom-occupied');
    this.wrap.remove();
  }

  // スライダーの段階数・つまみ位置・未予測区間の表示を反映する。
  private renderSlider(steps: number, t: number, predictionRatio: number): void {
    if (steps !== this.sliderSteps) {
      this.sliderSteps = steps;
      this.slider.element.max = String(steps);
    }
    const value = Math.round(t * this.sliderSteps);
    if (this.slider.getValue() !== value) this.slider.setValue(value);
    if (predictionRatio !== this.lastTrackRatio) {
      this.lastTrackRatio = predictionRatio;
      this.slider.setGradient(predictionRatio);
    }
  }

  // 表示時刻を UTC の絶対日時で出す。T± 表記は目盛りと同じ粗い単位なので、
  // 正確な時刻はこちらが受け持つ。
  private renderAbsoluteLabel(displayUnixSec: number): void {
    const text = fmtDateTime(displayUnixSec);
    if (this.absoluteLabel.textContent !== text) this.absoluteLabel.textContent = text;
  }

  // T± 表記の経過時間を表示する。
  private renderElapsedLabel(elapsedSec: number): void {
    const sign = elapsedSec < 0 ? '−' : '+';
    const text = `T${sign}${fmtDuration(Math.abs(elapsedSec), Math.abs(elapsedSec))}`;
    if (this.elapsedLabel.textContent !== text) this.elapsedLabel.textContent = text;
  }

  // 各目盛りをスライダー全域上の位置 t(0..1)へ置く。t は期間の等分ではなく、最後の目盛りが
  // 右端に来るとも限らないので、端からはみ出さないための寄せ方も t の値そのものから決める。
  private renderTicks(ticks: readonly DisplayTick[]): void {
    if (this.ticks.childElementCount !== ticks.length) {
      this.ticks.innerHTML = '';
      for (const _tick of ticks) {
        const tick = document.createElement('span');
        this.ticks.appendChild(tick);
      }
    }
    // 本数が変わらない限り要素は使い回し、変わった値だけ書く。
    let i = 0;
    for (const tick of ticks) {
      const el = this.ticks.children[i++];
      if (el === undefined || tick === undefined || !(el instanceof HTMLElement)) continue;
      if (el.textContent !== tick.label) el.textContent = tick.label;
      const left = `${tick.t * 100}%`;
      if (el.style.left !== left) el.style.left = left;
      const transform = tick.t < 0.02 ? 'none' : tick.t > 0.98 ? 'translateX(-100%)' : 'translateX(-50%)';
      if (el.style.transform !== transform) el.style.transform = transform;
    }
  }
}
