// 未来表示の操作パネル。未来/過去の期間ピル、目盛り表記の切り替え、表示時刻のスクラバーと
// 目盛り列を持つ。
import {
  Button, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, DurationPillRow,
  Slider, ToggleSwitch, ToggleValueEdit,
  type CollapseToggleLabels,
} from '../../../hud/widgets';
import type { PanelCollapse } from '../panel-shell';
import { fmtDateTime, fmtDuration } from '../../../hud/utils';
import type { DisplayTick } from '../orbit/tick-scale';
import {
  APERIODIC_ARC_DURATION, DISPLAY_DURATION_MAX,
} from '../../viewer/display-timeline-selection';
import type {
  DisplayDurationKey, DisplayPastDurationKey, TickLabelMode,
} from '../../viewer/display-timeline-selection';

// 手動レンジで指定できる表示期間の下限 [s]。表示期間は予測列の保持窓でもあり、0 では
// サンプルが1件も残らず、どの時刻も引けない列になる。
const DISPLAY_DURATION_MIN = 3600;

// ピルで選べる期間。手動レンジ('custom')だけは入力欄が受け持つ。
type FixedDurationKey = Exclude<DisplayDurationKey, 'custom'>;
type FixedPastDurationKey = Exclude<DisplayPastDurationKey, 'custom'>;

const FIXED_DURATIONS: readonly (readonly [FixedDurationKey, string])[] = [
  ['orbit', '1周'],
  ['day', '1日'],
  ['tenDay', '10日'],
  ['month', '1ヶ月'],
  ['threeMonth', '3ヶ月'],
];

const FIXED_PAST_DURATIONS: readonly (readonly [FixedPastDurationKey, string])[] = [
  ['none', 'なし'],
  ...FIXED_DURATIONS,
];

// マップビュー下部のタイムラインバー用トグルの見た目。
const TIMELINE_TOGGLE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '下部パネルを閉じる',
  collapsedTitle: '下部パネルを開く',
};

// タイムラインパネルが1フレームに映す値。
interface DisplayTimelinePanelState {
  readonly visible: boolean;
  readonly durationKey: DisplayDurationKey;
  readonly pastDurationKey: DisplayPastDurationKey;
  readonly pastDuration: number;
  readonly tickLabelMode: TickLabelMode;
  readonly showElementTimes: boolean;
  readonly showTicks: boolean;
  readonly duration: number;
  readonly displayTime: number;
  // ランの元期(simTime=0)の unix 秒相当。displayTime を足すと絶対日時になる。
  readonly epochUnixSec: number;
  readonly sliderSteps: number;
  readonly sliderT: number;
  readonly predictionRatio: number;
  readonly ticks: readonly DisplayTick[];
}

export class DisplayTimelinePanel {
  public onDurationSelect: ((key: FixedDurationKey) => void) | null = null;
  public onCustomDurationConfirm: ((sec: number) => void) | null = null;
  public onPastDurationSelect: ((key: FixedPastDurationKey) => void) | null = null;
  public onPastCustomDurationConfirm: ((sec: number) => void) | null = null;
  public onTickLabelModeChange: ((mode: TickLabelMode) => void) | null = null;
  public onShowElementTimesChange: ((show: boolean) => void) | null = null;
  public onShowTicksChange: ((show: boolean) => void) | null = null;
  public onSliderChange: ((t: number) => void) | null = null;
  public onResetToNow: (() => void) | null = null;
  public onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly timelineElapsed: HTMLElement;
  private readonly timelineAbsolute: HTMLElement;
  private readonly timelinePrediction: HTMLElement;
  private readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
  private readonly pastDurationRow: DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>;
  private readonly tickLabelModeSwitch: ToggleSwitch;
  private readonly showTicksSwitch: ToggleSwitch;
  private readonly showElementTimesSwitch: ToggleSwitch;
  private readonly slider: Slider;
  private readonly absoluteLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly jumpToggle: ToggleValueEdit;
  private readonly ticks: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;
  private readonly occupancyObserver: ResizeObserver | null;

  private sliderSteps = 1000;
  private currentDuration = APERIODIC_ARC_DURATION;
  private lastTrackRatio = 1;

  // タイムラインパネルの DOM を組み立て、root へ追加する。collapse は折りたたみトグルの配線役。
  public constructor(root: HTMLElement, collapse: PanelCollapse) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel editorial-instrument';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'editorial-panel-head predict-head';
    head.innerHTML = '<span class="ui-section-code" aria-hidden="true">TML</span><h3 class="editorial-panel-title">ORBIT TIMELINE</h3>';
    this.panel.appendChild(head);

    const state = document.createElement('section');
    state.className = 'predict-state editorial-state';
    state.innerHTML = `
      <div class="editorial-state-hero">
        <span class="ui-data-label">DISPLAY TIME</span>
        <strong data-predict-state="elapsed">T+00:00</strong>
        <span class="ui-annotation" data-predict-state="absolute">—</span>
      </div>
      <div class="predict-state-progress">
        <span class="ui-data-label">PREDICTED</span>
        <span class="ui-data-secondary" data-predict-state="prediction">—</span>
      </div>`;
    this.panel.appendChild(state);
    this.timelineElapsed = state.querySelector<HTMLElement>('[data-predict-state="elapsed"]')!;
    this.timelineAbsolute = state.querySelector<HTMLElement>('[data-predict-state="absolute"]')!;
    this.timelinePrediction = state.querySelector<HTMLElement>('[data-predict-state="prediction"]')!;

    const controls = document.createElement('div');
    controls.className = 'predict-controls editorial-control-zone';
    this.panel.appendChild(controls);

    const durationRows = this.buildDurationRows(controls);
    this.durationRow = durationRows.durationRow;
    this.pastDurationRow = durationRows.pastDurationRow;

    const modeSwitches = this.buildModeRow(controls);
    this.tickLabelModeSwitch = modeSwitches.tickLabelModeSwitch;
    this.showTicksSwitch = modeSwitches.showTicksSwitch;
    this.showElementTimesSwitch = modeSwitches.showElementTimesSwitch;

    const scrubberRow = this.buildScrubberRow(controls);
    this.slider = scrubberRow.slider;
    this.absoluteLabel = scrubberRow.absoluteLabel;
    this.elapsedLabel = scrubberRow.elapsedLabel;
    this.jumpToggle = scrubberRow.jumpToggle;

    // 目盛り。スクラバーの直下に置く。
    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    controls.appendChild(this.ticks);

    // トグルとバー本体を1つの縦積み flex にまとめ、バーを畳んでもトグルだけがその場に残るようにする。
    this.wrap = document.createElement('div');
    this.wrap.id = 'hud-predict-wrap';
    this.wrap.appendChild(this.panel);
    this.unsubscribeCollapsedView = collapse.wire({
      toggleRoot: this.wrap,
      toggleId: 'hud-predict-toggle',
      toggleClassName: '',
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

  // 未来と過去、それぞれの期間ピル行を組む。過去は「なし」も選べる。
  private buildDurationRows(container: HTMLElement): {
    readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
    readonly pastDurationRow: DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>;
  } {
    // 未来の期間。
    const durationRow = new DurationPillRow<FixedDurationKey, DisplayDurationKey>(
      '未来', FIXED_DURATIONS,
      (key) => this.onDurationSelect?.(key),
      (sec) => this.onCustomDurationConfirm?.(sec),
      DISPLAY_DURATION_MIN, DISPLAY_DURATION_MAX,
    );
    container.appendChild(durationRow.element);
    // 過去の期間。
    const pastDurationRow = new DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>(
      '過去', FIXED_PAST_DURATIONS,
      (key) => this.onPastDurationSelect?.(key),
      (sec) => this.onPastCustomDurationConfirm?.(sec),
      DISPLAY_DURATION_MIN, DISPLAY_DURATION_MAX,
    );
    pastDurationRow.element.classList.add('predict-past');
    container.appendChild(pastDurationRow.element);
    return { durationRow, pastDurationRow };
  }

  // 目盛りラベルの表記(UTC カレンダー / 現在からの経過時間)、目盛り行そのものの表示有無、
  // 軌道要素の時刻の表示有無を選ぶ行。
  private buildModeRow(container: HTMLElement): {
    readonly tickLabelModeSwitch: ToggleSwitch;
    readonly showTicksSwitch: ToggleSwitch;
    readonly showElementTimesSwitch: ToggleSwitch;
  } {
    const modeRow = document.createElement('div');
    modeRow.className = 'predict-row1';
    const tickLabelModeSwitch = new ToggleSwitch(
      '目盛りを相対表記',
      (on) => this.onTickLabelModeChange?.(on ? 'relative' : 'absolute'),
    );
    modeRow.appendChild(tickLabelModeSwitch.element);
    const showTicksSwitch = new ToggleSwitch(
      '目盛りを表示',
      (on) => this.onShowTicksChange?.(on),
    );
    modeRow.appendChild(showTicksSwitch.element);
    const showElementTimesSwitch = new ToggleSwitch(
      '軌道要素の時刻を表示',
      (on) => this.onShowElementTimesChange?.(on),
    );
    modeRow.appendChild(showElementTimesSwitch.element);
    container.appendChild(modeRow);
    return { tickLabelModeSwitch, showTicksSwitch, showElementTimesSwitch };
  }

  // 現在に戻すボタン + スクラバー + T+読み値(クリックで直接ジャンプ入力に変わる)の行。
  private buildScrubberRow(container: HTMLElement): {
    readonly slider: Slider;
    readonly absoluteLabel: HTMLElement;
    readonly elapsedLabel: HTMLElement;
    readonly jumpToggle: ToggleValueEdit;
  } {
    const row2 = document.createElement('div');
    row2.className = 'predict-row2';
    const resetBtn = new Button('⏮', () => this.onResetToNow?.());
    resetBtn.element.classList.add('predict-reset', 'w-btn--icon');
    resetBtn.element.title = '現在に戻す';
    resetBtn.element.setAttribute('aria-label', '現在に戻す');
    row2.appendChild(resetBtn.element);

    // 表示時刻を選ぶスクラバー本体。
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'predict-slider-wrap';
    const slider = new Slider(
      { min: 0, max: this.sliderSteps },
      (value) => this.onSliderChange?.(value / this.sliderSteps),
    );
    slider.element.title = 'ドラッグ、またはトラックをクリックして未来位置を選ぶ';
    sliderWrap.appendChild(slider.element);
    row2.appendChild(sliderWrap);

    const absoluteLabel = document.createElement('span');
    absoluteLabel.className = 'predict-absolute';
    row2.appendChild(absoluteLabel);

    // T+読み値。クリックするとジャンプ入力欄(jumpToggle)へ差し替わる。
    const elapsedLabel = document.createElement('span');
    elapsedLabel.className = 'predict-elapsed';
    elapsedLabel.title = 'クリックして時刻へジャンプ';
    elapsedLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
    elapsedLabel.addEventListener('click', () => this.jumpToggle.open(
      this.currentDuration * (slider.getValue() / this.sliderSteps), 0, this.currentDuration,
    ));
    row2.appendChild(elapsedLabel);

    const jumpEditEl = document.createElement('span');
    jumpEditEl.className = 'predict-value-input hidden';
    const jumpToggle = new ToggleValueEdit(elapsedLabel, jumpEditEl, 'hour', (sec) => this.onJumpToTime?.(sec));
    jumpEditEl.appendChild(jumpToggle.inputEl);
    row2.appendChild(jumpEditEl);
    container.appendChild(row2);

    return { slider, absoluteLabel, elapsedLabel, jumpToggle };
  }

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  public render(state: DisplayTimelinePanelState): void {
    this.setVisible(state.visible);
    if (!state.visible) return;
    // 期間はジャンプ入力の上限にもなるので控えておく。
    this.currentDuration = state.duration;
    this.durationRow.render(state.durationKey, state.duration);
    this.pastDurationRow.render(state.pastDurationKey, state.pastDuration);
    this.tickLabelModeSwitch.setOn(state.tickLabelMode === 'relative');
    this.showTicksSwitch.setOn(state.showTicks);
    this.showElementTimesSwitch.setOn(state.showElementTimes);
    this.renderSlider(state.sliderSteps, state.sliderT, state.predictionRatio);
    this.renderAbsoluteLabel(state.epochUnixSec + state.displayTime);
    if (!this.jumpToggle.editing) this.renderElapsedLabel(state.sliderT * state.duration);
    const elapsed = state.sliderT * state.duration;
    this.timelineElapsed.textContent = `T+${fmtDuration(elapsed, elapsed)}`;
    this.timelineAbsolute.textContent = fmtDateTime(state.epochUnixSec + state.displayTime);
    this.timelinePrediction.textContent = `${Math.round(state.predictionRatio * 100)}%`;
    this.ticks.classList.toggle('hidden', !state.showTicks);
    this.renderTicks(state.ticks);
  }

  // パネル本体を出し入れする。折りたたみトグルは外側に残る。
  private setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // パネルの DOM を取り除き、折りたたみ状態変化の購読を解除する。
  public dispose(): void {
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
      // <input type=range> はトラック上の区間ごとに色を分けられないので、
      // 背景グラデーションで未予測区間の減光を表す。
      this.slider.setGradient(predictionRatio);
    }
  }

  // 表示時刻を UTC の絶対日時で出す。T+ 表記は目盛りと同じ粗い単位なので、
  // 正確な時刻はこちらが受け持つ。
  private renderAbsoluteLabel(displayUnixSec: number): void {
    const text = fmtDateTime(displayUnixSec);
    if (this.absoluteLabel.textContent !== text) this.absoluteLabel.textContent = text;
  }

  // T+ 表記の経過時間を表示する。
  private renderElapsedLabel(elapsedSec: number): void {
    const text = `T+${fmtDuration(elapsedSec, elapsedSec)}`;
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
