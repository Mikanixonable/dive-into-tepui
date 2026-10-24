// 画面全体の1行の全体ステータスバー(#hud-topbar)の同期: 日時と T+・NODE WARP・時間加速・警報灯・
// 見せ方トグル。自機の有無に関係なく常に出す画面全体の状態。ステージ名・ビュー切替は ViewBadge が持つ。
import { SyncThrottle } from '../sync-throttle';
import { fmtDateTime, fmtElapsedBrief, fmtTime } from '../../../hud/utils';
import type { HudEls } from '../hud-els';
import { MAX_PHYS_SIM_SPEED, SIM_SPEED_LEVELS } from '../../dynamic/sim-speed-manager';
import { Button } from '../../../hud/widgets';
import { RENDER_STYLES, type RenderStyle } from '../../../render/render-style';
import { ContextMenu, type MenuItem } from '../windows/context-menu';
import type { OverlayManager } from '../../../hud/overlay-manager';
import type { ViewMode } from '../../view/view-mode';

const SYNC_INTERVAL_MS = 100;

// ビューごとに直接押せる時間加速の段。戦闘は射撃・推進が効く最上位までの段、マップは移動に使う段を足す。
const DIRECT_SPEEDS: Readonly<Record<ViewMode, readonly number[]>> = {
  combat: [1, MAX_PHYS_SIM_SPEED],
  map: [1, MAX_PHYS_SIM_SPEED, 64, 1024],
};

// 見せ方トグルが入り切りする見せ方。もう一方は写実。
const TOGGLED_STYLE: RenderStyle = 'schematic';
const DEFAULT_STYLE: RenderStyle = 'realistic';

// トップバーが1フレームに表示する値と、操作ハンドラ。
export interface TopBarViewModel {
  // ランの元期の unix 秒。simTime を足すと表示用の日時になる。
  readonly epochUnixSec: number;
  readonly simTime: number;
  readonly simSpeed: number;
  readonly isPaused: boolean;
  readonly view: ViewMode;
  // ノード自動ワープが終わるまでの実時間 [s]。自動ワープしていなければ null。
  readonly autoWarpRealRemainSec: number | null;
  // 次のノードまでの残りシミュレーション時間 [s]。ノードが無ければ null。
  readonly nodeWarpRemainSec: number | null;
  // ノードへ自動ワープしているか。
  readonly isAutoWarping: boolean;
  readonly cautionCount: number;
  readonly warningCount: number;
  // 未確認の警告があるか。警告灯の点滅はこのあいだ続く。
  readonly hasUnacknowledgedWarning: boolean;
  readonly renderStyle: RenderStyle;
  setSimSpeed(speed: number): void;
  setRenderStyle(style: RenderStyle): void;
}

// 時間加速の段の表示。
function speedLabel(speed: number): string {
  return `×${speed}`;
}

export class TopBar {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly warpEl: HTMLElement;
  private readonly warpButtons = new Map<number, Button>();
  private readonly warpMoreButton: Button;
  private readonly warpMenu: ContextMenu<true, `${number}`>;
  private readonly nodeWarpEl: HTMLElement;
  private readonly nodeWarpValueEl: HTMLElement;
  private readonly cautionLamp: HTMLElement;
  private readonly warningLamp: HTMLElement;
  private readonly styleButton: Button;
  // 直近の sync が受けた値。ボタン・メニューの操作はフレームの外で起きるので、その時点の口をここから引く。
  private view: TopBarViewModel | null = null;

  // 時間加速のボタン列・見せ方トグルを差し込み、警報灯と NODE WARP の要素を引く。時間加速の残りの段は
  // overlayManager に登録するメニューで選ぶ。
  public constructor(private readonly els: HudEls, overlayManager: OverlayManager) {
    this.warpEl = this.els.get('sim-speed');
    this.warpMenu = new ContextMenu<true, `${number}`>(overlayManager);
    this.warpMenu.onSelect = (act) => this.view?.setSimSpeed(Number(act));
    this.warpMenu.onClose = () => this.warpMoreButton.element.setAttribute('aria-expanded', 'false');
    this.warpMoreButton = new Button('▾', () => this.openWarpMenu(), undefined, ['dense', 'icon']);
    this.warpMoreButton.element.setAttribute('aria-haspopup', 'menu');
    this.warpMoreButton.element.setAttribute('aria-expanded', 'false');
    this.warpMoreButton.element.setAttribute('aria-label', '時間加速の段を選ぶ');
    this.warpEl.append(this.warpMoreButton.element);

    this.nodeWarpEl = this.els.get('node-warp');
    this.nodeWarpValueEl = this.els.get('node-warp-remain');
    const lamps = this.els.get('alarm-lamps');
    this.cautionLamp = lamps.querySelector<HTMLElement>('[data-lamp="caution"]')!;
    this.warningLamp = lamps.querySelector<HTMLElement>('[data-lamp="warning"]')!;

    this.styleButton = new Button(
      RENDER_STYLES.find(([id]) => id === TOGGLED_STYLE)![1],
      () => this.view?.setRenderStyle(this.view.renderStyle === TOGGLED_STYLE ? DEFAULT_STYLE : TOGGLED_STYLE),
      undefined, 'dense',
    );
    this.styleButton.element.setAttribute('aria-label', '画面全体の見せ方を模式図にする');
    this.els.get('style-toggle').append(this.styleButton.element);
  }

  // 日時と T+ を毎フレーム、時間加速・NODE WARP・警報灯・見せ方トグルを間引いて反映する。
  // view が null(ランが無い)なら、掴んでいる口を落として何も書かない。
  public sync(view: TopBarViewModel | null, nowMs: number): void {
    this.view = view;
    if (!view) {
      this.nodeWarpEl.classList.add('hidden');
      return;
    }
    this.els.setText('met', fmtDateTime(view.epochUnixSec + view.simTime));
    this.els.setText('met-elapsed', `T+ ${fmtElapsedBrief(view.simTime)}`);

    if (!this.throttle.due(nowMs)) return;
    this.syncWarp(view);
    this.syncNodeWarp(view);
    this.syncLamp(this.cautionLamp, 'caution', view.cautionCount, false);
    this.syncLamp(this.warningLamp, 'warning', view.warningCount, view.warningCount > 0 && !view.hasUnacknowledgedWarning);
    this.styleButton.setOn(view.renderStyle === TOGGLED_STYLE);
  }

  // 直接押せる段のボタン列を、いまの段・ビューに合わせて組み、いまの段を点灯させる。
  private syncWarp(view: TopBarViewModel): void {
    const direct = DIRECT_SPEEDS[view.view];
    const shown = direct.includes(view.simSpeed) ? direct : [...direct, view.simSpeed].sort((a, b) => a - b);
    this.syncWarpButtons(shown);
    for (const [speed, button] of this.warpButtons) button.setOn(speed === view.simSpeed);
    this.warpEl.title = view.isPaused ? '一時停止中' : `時間加速 ${speedLabel(view.simSpeed)}`;
    this.warpEl.classList.toggle('is-paused', view.isPaused);
  }

  // 段 speeds のボタン列へ、足りない段のボタンを足し、要らない段のボタンを外す。残る段のボタンは
  // 作り直さない — 押したボタンのフォーカスを保つ。並びは段の昇順に揃える。
  private syncWarpButtons(speeds: readonly number[]): void {
    for (const [speed, button] of this.warpButtons) {
      if (speeds.includes(speed)) continue;
      button.element.remove();
      this.warpButtons.delete(speed);
    }
    for (const speed of speeds) {
      if (!this.warpButtons.has(speed)) this.warpButtons.set(speed, this.createWarpButton(speed));
    }
    let previous: Element | null = null;
    for (const speed of speeds) {
      const element = this.warpButtons.get(speed)!.element;
      if (element.previousElementSibling !== previous) {
        // 並びが合わないときだけ動かす。フォーカス中の要素を動かすとフォーカスが外れる。
        if (previous === null) this.warpEl.prepend(element);
        else previous.after(element);
      }
      previous = element;
    }
  }

  // 段 speed の時間加速ボタンを作る。
  private createWarpButton(speed: number): Button {
    const button = new Button(speedLabel(speed), () => this.view?.setSimSpeed(speed), undefined, 'dense');
    // 射撃・推進が効かない段は、効かないことを併記する(GAME.md「時間加速」)。
    if (speed > MAX_PHYS_SIM_SPEED) {
      button.element.title = `${speedLabel(speed)} — 自機の操作はワープ ×${MAX_PHYS_SIM_SPEED} 以下でのみ可能`;
    }
    return button;
  }

  // 直接押せない残りの段を、「▾」ボタンの下のメニューに開く。
  private openWarpMenu(): void {
    const view = this.view;
    if (view === null) return;
    const items: MenuItem<`${number}`>[] = SIM_SPEED_LEVELS
      .filter((speed) => !this.warpButtons.has(speed))
      .map((speed) => ({ label: speedLabel(speed), act: `${speed}` as const }));
    const rect = this.warpMoreButton.element.getBoundingClientRect();
    this.warpMoreButton.element.setAttribute('aria-expanded', 'true');
    this.warpMenu.open(rect.right, rect.bottom, true, items);
  }

  // 次のノードがあるあいだ NODE WARP の残り時間を併記し、自動ワープ中は自分の色で示す。
  private syncNodeWarp(view: TopBarViewModel): void {
    const remain = view.nodeWarpRemainSec;
    this.nodeWarpEl.classList.toggle('hidden', remain === null);
    this.nodeWarpEl.classList.toggle('ui-accent', view.isAutoWarping);
    if (remain === null) return;
    const warpRemain = view.autoWarpRealRemainSec !== null ? ` (残り ${fmtTime(view.autoWarpRealRemainSec)})` : '';
    this.nodeWarpEl.title = `次のノードまでの残りシミュレーション時間${warpRemain}`;
    const text = fmtTime(remain);
    if (this.nodeWarpValueEl.textContent !== text) this.nodeWarpValueEl.textContent = text;
  }

  // 警報灯1つの点灯・件数・確認済みの表示を反映する。件数が 0 なら消灯する。
  private syncLamp(lamp: HTMLElement, level: 'caution' | 'warning', count: number, acknowledged: boolean): void {
    lamp.classList.toggle(`is-${level}`, count > 0);
    lamp.classList.toggle('is-acked', acknowledged);
    lamp.querySelector<HTMLElement>('.ui-lamp-n')!.textContent = count > 0 ? `${count}` : '';
    lamp.setAttribute('aria-label', `${level === 'warning' ? 'WARNING' : 'CAUTION'} ${count} 件`);
  }
}
