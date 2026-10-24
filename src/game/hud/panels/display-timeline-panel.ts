// 未来表示の操作パネル。掴んで動かす1本の時間軸(過去・再生ヘッド・軌道上の事象の目盛り・
// 軸のラベル)と、その上段の読み値・次の事象・予測率を持つ。表示期間は時間軸の両端の
// 「過去」「未来」から開く1つの範囲選択で選び、目盛りの表記などの設定は「⋯」から開く。
import {
  Button, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, DurationPillRow,
  Slider, ToggleSwitch,
  type CollapseToggleLabels, type SliderMark, type ToggleValueEdit,
} from '../../../hud/widgets';
import {
  buildLegend, buildReadoutRow, buildSettingsButton, buildStatusRow, buildTrack, type TrackParts,
} from './display-timeline-parts';
import type { PanelCollapse } from '../panel-shell';
import type { OverlayManager } from '../../../hud/overlay-manager';
import { fmtDateTime, fmtDuration } from '../../../hud/utils';
import {
  fmtOffsetLabel, fmtSpanLabel, pastRegionFraction, type DisplayTick,
} from '../orbit/tick-scale';
import { TimelinePopover } from './display-timeline-popover';
import { ORBIT_POINT_GLYPH } from '../../marker/marker-identity';
import type { TimelineEvent, TimelineEventKind } from '../../map/timeline-event';
import {
  APERIODIC_ARC_DURATION, DISPLAY_DURATION_MAX,
} from '../../viewer/display-timeline-selection';
import type {
  DisplayDurationKey, DisplayPastDurationKey, TickLabelMode,
} from '../../viewer/display-timeline-selection';

// 手動レンジで指定できる表示期間の下限 [s]。表示期間は予測列の保持窓でもあり、0 では
// サンプルが1件も残らず、どの時刻も引けない列になる。
const DISPLAY_DURATION_MIN = 3600;

// 「次の事象」へ飛ぶとき、再生ヘッドの現在位置と同じ事象とみなす幅 [s]。
const NEXT_EVENT_MARGIN_SEC = 1;

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

// 事象の字形・色の持ち主。再接近はターゲット、ノードは自分の計画。
function markToneOf(kind: TimelineEventKind): SliderMark['tone'] {
  if (kind === 'closestApproach') return 'target';
  return kind === 'maneuverNode' ? 'own' : 'neutral';
}

// 表示期間の選択を、時間軸の端の掴み手に出す語にする。
function spanLabelOf(
  key: DisplayPastDurationKey, sec: number, fixed: readonly (readonly [string, string])[],
): string {
  return fixed.find(([fixedKey]) => fixedKey === key)?.[1] ?? fmtSpanLabel(sec);
}

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
  // 軸のラベル。位置はトラック全幅(過去の帯を含む)に対する割合。
  readonly ticks: readonly DisplayTick[];
  // 現在の simTime。事象の時刻を現在からの経過へ直すために使う。
  readonly simTime: number;
  readonly events: readonly TimelineEvent[];
}

// 時間軸の端に置く、「過去」「未来」の掴み手。押すと表示範囲の選択が開く。
interface RangeEnd {
  readonly button: Button;
  readonly value: HTMLElement;
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
  private readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
  private readonly pastDurationRow: DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>;
  private readonly tickLabelModeSwitch: ToggleSwitch;
  private readonly showTicksSwitch: ToggleSwitch;
  private readonly showElementTimesSwitch: ToggleSwitch;
  private readonly slider: Slider;
  private readonly absoluteLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly jumpToggle: ToggleValueEdit;
  private readonly predictionLabel: HTMLElement;
  private readonly nextButton: Button;
  private readonly nextLabel: HTMLElement;
  private readonly pastEnd: RangeEnd;
  private readonly futureEnd: RangeEnd;
  private readonly rangePopover: TimelinePopover;
  private readonly settingsPopover: TimelinePopover;
  private readonly track: TrackParts;
  private readonly wrap: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;
  private readonly occupancyObserver: ResizeObserver | null;

  private sliderSteps = 1000;
  private pastFraction = 0;
  private currentDuration = APERIODIC_ARC_DURATION;
  // 現在からの経過 [s] で並べた、未来側の範囲に収まる事象。目盛りと「次の事象」が共有する。
  private visibleEvents: readonly (readonly [TimelineEvent, number])[] = [];
  private nextEventSec: number | null = null;

  // タイムラインパネルの DOM を組み立て、root へ追加する。collapse は折りたたみトグルの配線役、
  // overlayManager は表示範囲・設定の小窓の開閉を預ける。
  public constructor(root: HTMLElement, collapse: PanelCollapse, overlayManager: OverlayManager) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    // 上段: 現在に戻す・読み値・(空き)・次の事象・予測率・設定。
    const top = document.createElement('div');
    top.className = 'tml-top';
    this.panel.appendChild(top);
    const resetBtn = new Button('⏮', () => this.onResetToNow?.());
    resetBtn.element.classList.add('predict-reset', 'w-btn--icon');
    resetBtn.element.title = '現在に戻す';
    resetBtn.element.setAttribute('aria-label', '現在に戻す');
    const readout = buildReadoutRow(
      (sec) => this.onJumpToTime?.(sec),
      () => ({ sec: this.currentDuration * (this.slider.getValue() / this.sliderSteps), max: this.currentDuration }),
    );
    this.elapsedLabel = readout.elapsedLabel;
    this.absoluteLabel = readout.absoluteLabel;
    this.jumpToggle = readout.jumpToggle;
    const grow = document.createElement('span');
    grow.className = 'tml-grow';
    const status = buildStatusRow(() => {
      if (this.nextEventSec !== null) this.onJumpToTime?.(this.nextEventSec);
    });
    this.nextButton = status.nextButton;
    this.nextLabel = status.nextLabel;
    this.predictionLabel = status.predictionLabel;
    const settingsBtn = buildSettingsButton(
      (trigger) => this.settingsPopover.toggle(trigger, 'end', this.panel),
    );
    top.append(
      resetBtn.element, readout.element, grow, status.nextButton.element, status.predictionLabel, settingsBtn.element,
    );

    // 時間軸: [過去] [トラックと軸のラベル] [未来]。
    const scrub = document.createElement('div');
    scrub.className = 'tml-scrub';
    this.panel.appendChild(scrub);
    this.pastEnd = this.buildRangeEnd('過去', '過去の表示期間', 'start');
    this.futureEnd = this.buildRangeEnd('未来', '未来の表示期間', 'end');
    this.slider = new Slider({ min: 0, max: this.sliderSteps, marked: true }, (value) => this.handleSliderInput(value));
    this.slider.element.title = 'ドラッグ、またはトラックをクリックして未来位置を選ぶ';
    this.slider.element.setAttribute('aria-label', '表示時刻');
    this.track = buildTrack(this.slider);
    scrub.append(this.pastEnd.button.element, this.track.element, this.futureEnd.button.element);

    // 表示範囲の選択(未来と過去の2行)と、目盛り・凡例の設定。
    this.rangePopover = new TimelinePopover(overlayManager, '表示範囲', 'tml-pop-range');
    this.durationRow = new DurationPillRow<FixedDurationKey, DisplayDurationKey>(
      '未来', FIXED_DURATIONS,
      (key) => this.onDurationSelect?.(key),
      (sec) => this.onCustomDurationConfirm?.(sec),
      DISPLAY_DURATION_MIN, DISPLAY_DURATION_MAX,
    );
    this.pastDurationRow = new DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>(
      '過去', FIXED_PAST_DURATIONS,
      (key) => this.onPastDurationSelect?.(key),
      (sec) => this.onPastCustomDurationConfirm?.(sec),
      DISPLAY_DURATION_MIN, DISPLAY_DURATION_MAX,
    );
    const rangeNote = document.createElement('div');
    rangeNote.className = 'tml-pop-note';
    rangeNote.textContent = '1時間〜1年。「1周」は自機の周期に追従し、過去は飛行履歴の範囲まで。';
    this.rangePopover.body.append(this.durationRow.element, this.pastDurationRow.element, rangeNote);
    this.settingsPopover = new TimelinePopover(overlayManager, '目盛りと凡例', 'tml-pop-settings');
    this.tickLabelModeSwitch = new ToggleSwitch(
      '目盛りを相対表記', (on) => this.onTickLabelModeChange?.(on ? 'relative' : 'absolute'),
    );
    this.showTicksSwitch = new ToggleSwitch('目盛りを表示', (on) => this.onShowTicksChange?.(on));
    this.showElementTimesSwitch = new ToggleSwitch(
      '軌道要素の時刻を表示', (on) => this.onShowElementTimesChange?.(on),
    );
    const toggles = document.createElement('div');
    toggles.className = 'tml-pop-toggles';
    toggles.append(
      this.tickLabelModeSwitch.element, this.showTicksSwitch.element, this.showElementTimesSwitch.element,
    );
    this.settingsPopover.body.append(toggles, buildLegend());

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
    this.occupancyObserver = this.observeOccupancy(root);
  }

  // compactではこのパネルを下部sheetとして扱うため、wrapの上端から画面下端までの実占有量を
  // map rootへ公開する。高さだけでなくbottom offsetも含め、touch UIの下端予約にも追従する。
  private observeOccupancy(root: HTMLElement): ResizeObserver | null {
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
    if (typeof ResizeObserver === 'undefined') return null;
    const observer = new ResizeObserver(syncOccupancy);
    observer.observe(root);
    observer.observe(this.wrap);
    return observer;
  }

  // 時間軸の端の掴み手を組む。押すと、その端に揃えて表示範囲の選択を開き、押した側の行を強調する。
  private buildRangeEnd(caption: string, title: string, align: 'start' | 'end'): RangeEnd {
    const button = new Button('', () => {
      this.rangePopover.toggle(button.element, align, this.panel);
      this.durationRow.element.classList.toggle('is-active', align === 'end');
      this.pastDurationRow.element.classList.toggle('is-active', align === 'start');
    });
    button.element.classList.add('tml-end');
    button.element.title = title;
    button.element.setAttribute('aria-haspopup', 'dialog');
    const captionEl = document.createElement('span');
    captionEl.className = 'tml-end-caption';
    captionEl.textContent = caption;
    const value = document.createElement('b');
    const caret = document.createElement('i');
    caret.textContent = COLLAPSE_EXPANDED_GLYPH;
    button.element.append(captionEl, value, caret);
    return { button, value };
  }

  // つまみの動きを表示時刻の比率へ直して通知する。値域は未来側だけで、ヘッドは現在より過去へ行かない。
  private handleSliderInput(value: number): void {
    this.onSliderChange?.(value / this.sliderSteps);
  }

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  public render(state: DisplayTimelinePanelState): void {
    const shown = state.visible && !this.panel.classList.contains('collapsed');
    this.setVisible(state.visible);
    // 見えないパネルの小窓だけが残ると、持ち主の無い窓が画面に浮く。
    if (!shown) this.closePopovers();
    if (!state.visible) return;
    // 期間はジャンプ入力の上限にもなるので控えておく。
    this.currentDuration = state.duration;
    this.durationRow.render(state.durationKey, state.duration);
    this.pastDurationRow.render(state.pastDurationKey, state.pastDuration);
    this.futureEnd.value.textContent = spanLabelOf(state.durationKey, state.duration, FIXED_DURATIONS);
    this.pastEnd.value.textContent = spanLabelOf(state.pastDurationKey, state.pastDuration, FIXED_PAST_DURATIONS);
    this.tickLabelModeSwitch.setOn(state.tickLabelMode === 'relative');
    this.showTicksSwitch.setOn(state.showTicks);
    this.showElementTimesSwitch.setOn(state.showElementTimes);
    this.renderTrack(state);
    const elapsed = state.sliderT * state.duration;
    this.renderText(this.absoluteLabel, fmtDateTime(state.epochUnixSec + state.displayTime));
    if (!this.jumpToggle.editing) this.renderText(this.elapsedLabel, `T+${fmtDuration(elapsed, elapsed)}`);
    this.renderText(this.predictionLabel, `予測 ${Math.round(state.predictionRatio * 100)}%`);
    this.track.ticks.classList.toggle('hidden', !state.showTicks);
    this.renderTicks(state.ticks);
    this.renderEvents(state, elapsed);
  }

  // パネル本体を出し入れする。折りたたみトグルは外側に残る。
  private setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // 開いている範囲選択・設定の小窓を閉じる。マップを抜けると render は呼ばれなくなるので、
  // 抜けるときは呼び出し側からも閉じる。
  public closePopovers(): void {
    if (this.rangePopover.isOpen) this.rangePopover.close();
    if (this.settingsPopover.isOpen) this.settingsPopover.close();
  }

  // パネルの DOM を取り除き、折りたたみ状態変化の購読を解除する。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.occupancyObserver?.disconnect();
    this.rangePopover.dispose();
    this.settingsPopover.dispose();
    this.wrap.parentElement?.style.removeProperty('--hud-predict-bottom-occupied');
    this.wrap.remove();
  }

  // トラックの値域・つまみ位置・過去の帯と未予測区間の帯を反映する。スライダーの値域は未来側
  // [0, sliderSteps] のままで、過去の帯はその左に別の領域として並ぶ(PLAN.md 9: 過去は静的な履歴線)。
  private renderTrack(state: DisplayTimelinePanelState): void {
    if (state.sliderSteps !== this.sliderSteps) this.slider.setRange(0, state.sliderSteps);
    this.sliderSteps = state.sliderSteps;
    const pastFraction = pastRegionFraction(state.pastDuration, state.duration);
    if (pastFraction !== this.pastFraction) {
      this.pastFraction = pastFraction;
      this.track.bar.style.setProperty('--tml-past-w', `${pastFraction * 100}%`);
      this.track.bar.classList.toggle('has-past', pastFraction > 0);
      this.track.pastBand.classList.toggle('hidden', pastFraction <= 0);
    }
    const value = Math.round(state.sliderT * state.sliderSteps);
    if (this.slider.getValue() !== value) this.slider.setValue(value);
    this.slider.setBands([{ to: state.predictionRatio, tone: 'normal' }, { to: 1, tone: 'dim' }]);
    const elapsed = state.sliderT * state.duration;
    this.slider.element.setAttribute('aria-valuetext', `T+${fmtDuration(elapsed, elapsed)}`);
  }

  // 未来側の範囲内の事象を目盛りとして載せ、再生ヘッドより先で最も近い事象を「次」のボタンへ出す。
  // 過去は静的な履歴線で覗き見る対象ではないので、過去の事象は載せない。
  private renderEvents(state: DisplayTimelinePanelState, headSec: number): void {
    const visible: (readonly [TimelineEvent, number])[] = [];
    for (const event of state.events) {
      const sec = event.time - state.simTime;
      if (sec >= 0 && sec <= state.duration) visible.push([event, sec]);
    }
    this.visibleEvents = visible;
    this.slider.setMarks(
      visible.map(([event, sec]) => ({
        at: sec / state.duration,
        glyph: ORBIT_POINT_GLYPH[event.kind],
        tone: markToneOf(event.kind),
        title: `${event.name} ${fmtOffsetLabel(sec)}`,
      })),
      (index) => {
        const sec = this.visibleEvents[index]?.[1];
        if (sec !== undefined) this.onJumpToTime?.(sec);
      },
    );
    const next = visible.find(([, sec]) => sec > headSec + NEXT_EVENT_MARGIN_SEC);
    this.nextEventSec = next === undefined ? null : next[1];
    this.nextButton.element.classList.toggle('hidden', next === undefined);
    if (next !== undefined) {
      this.renderText(this.nextLabel, `${ORBIT_POINT_GLYPH[next[0].kind]} 次 ${next[0].name} ${fmtOffsetLabel(next[1])}`);
    }
  }

  // 変わったときだけ文字を書く(毎フレームの再代入はレイアウト再計算を招く)。
  private renderText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  // 各目盛りをトラック全幅上の位置 t(0..1)へ置く。t は期間の等分ではなく、最後の目盛りが
  // 右端に来るとも限らないので、端からはみ出さないための寄せ方も t の値そのものから決める。
  private renderTicks(ticks: readonly DisplayTick[]): void {
    const layer = this.track.ticks;
    if (layer.childElementCount !== ticks.length) {
      layer.innerHTML = '';
      for (const _tick of ticks) {
        const tick = document.createElement('span');
        layer.appendChild(tick);
      }
    }
    // 本数が変わらない限り要素は使い回し、変わった値だけ書く。
    let i = 0;
    for (const tick of ticks) {
      const el = layer.children[i++];
      if (el === undefined || tick === undefined || !(el instanceof HTMLElement)) continue;
      if (el.textContent !== tick.label) el.textContent = tick.label;
      const left = `${tick.t * 100}%`;
      if (el.style.left !== left) el.style.left = left;
      // 過去の帯があるとき、現在の目盛りは帯の終端から右へ伸ばし、帯の中の過去の目盛りと重ねない。
      const atPastEdge = this.pastFraction > 0 && Math.abs(tick.t - this.pastFraction) < 1e-9;
      const transform = tick.t < 0.02 || atPastEdge ? 'none' : tick.t > 0.98 ? 'translateX(-100%)' : 'translateX(-50%)';
      if (el.style.transform !== transform) el.style.transform = transform;
    }
  }
}
