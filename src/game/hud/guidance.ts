// 画面中央上部の案内: ステージ開始のブリーフィングのカードと、軌道計画の操作を段階で示す案内チップ。
// ブリーフィングは最初の操作・一定時間・警報の発生のどれかで畳み、案内チップは計画の間だけ出す。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { createKeyCap } from '../../hud/key-cap';
import { BriefingClock } from './briefing-clock';
import { MQ_COARSE } from '../../hud/breakpoints';

// 軌道計画の案内チップの段。計画が空・ノードがあるが編集していない・ノードを選択中・確定できる、の
// いずれか。段は案内チップを出す側が計画とノード選択の状態から決める。
export type PlanHintStage = 'place' | 'adjust' | 'edit' | 'confirm';

// 段ごとの案内のステップ列。keys はキーキャップに載せる操作、text は短い語。
const PLAN_HINT_STEPS: Record<PlanHintStage, readonly (readonly [readonly string[], string])[]> = {
  place: [
    [['クリック'], '軌道にノードを置く'],
  ],
  adjust: [
    [['ドラッグ'], '時刻を動かす'],
    [['矢印'], 'Δvを調整'],
    [['右クリック'], 'メニュー'],
  ],
  edit: [
    [[K.dvPrograde.label, K.dvRetrograde.label], '加減速'],
    [[K.dvNormal.label, K.dvAntinormal.label], '軌道面'],
    [[K.dvRadialIn.label, K.dvRadialOut.label], '高度'],
    [[K.deleteNode.label], '削除'],
  ],
  confirm: [
    [[K.toggleMapMode.label], '確定して戦闘へ'],
    [[K.autoWarpToNode.label], 'ノードへ自動ワープ'],
  ],
};

// タッチでは、クリック・矢印キー・M・N を指さず、指の語とマップの下端の取っ手の語で示す。キーで操作する
// 段(edit)は物理キーを前提にするので、タッチでも同じ列を出す。
const PLAN_HINT_STEPS_TOUCH: Record<PlanHintStage, readonly (readonly [readonly string[], string])[]> = {
  place: [
    [['タップ'], 'ノードを置く'],
  ],
  adjust: [
    [['ドラッグ'], '時刻'],
    [['長押し'], 'メニュー'],
  ],
  edit: PLAN_HINT_STEPS.edit,
  confirm: [
    [['戦闘へ'], '確定'],
    [['ノードへ'], '自動ワープ'],
  ],
};

export class Guidance {
  private readonly briefingClock = new BriefingClock();
  // hintEl に組んだ案内の段と、そのときの語彙(タッチかどうか)。変わったときだけ DOM を組み替える。
  private shownStage: PlanHintStage | null = null;
  private shownTouch = false;

  // briefingEl と hintEl は #hud に構築済みの案内の置き場。
  public constructor(private readonly briefingEl: HTMLElement, private readonly hintEl: HTMLElement) { }

  // ブリーフィング html(ステージが組んだ HTML)をカードに出す。
  public showBriefing(html: string): void {
    const code = document.createElement('span');
    code.className = 'ui-alert-level';
    code.textContent = 'MIS 作戦目標';
    const body = document.createElement('div');
    body.className = 'guidance-briefing-body';
    body.innerHTML = html;
    this.briefingEl.replaceChildren(code, body);
    this.briefingEl.classList.remove('hidden');
    this.briefingClock.show();
  }

  // ブリーフィングを畳む。
  public foldBriefing(): void {
    this.briefingClock.fold();
    this.briefingEl.classList.add('hidden');
  }

  // ブリーフィングの時間切れと警報の発生による折りたたみ、案内チップの出し入れを反映する。
  // stage は軌道計画の案内の段(出さないなら null)、alarmActive は警報が出ているか。
  // nowMs はフレームの実時刻 [ms]。
  public sync(stage: PlanHintStage | null, alarmActive: boolean, nowMs: number): void {
    if (this.briefingClock.update(alarmActive, nowMs)) this.foldBriefing();
    // 画面の向きや入力装置で変わりうるので、語彙は段を組むたびにその場で判定する。
    const touch = typeof matchMedia === 'function' && matchMedia(MQ_COARSE).matches;
    if (stage !== this.shownStage || touch !== this.shownTouch) {
      this.shownStage = stage;
      this.shownTouch = touch;
      this.hintEl.replaceChildren(...(stage === null ? [] : this.hintSteps(stage, touch)));
    }
    this.hintEl.classList.toggle('hidden', stage === null);
  }

  // 段 stage の案内のステップ列を組む。touch ならタッチの語で組む。
  private hintSteps(stage: PlanHintStage, touch: boolean): HTMLElement[] {
    return (touch ? PLAN_HINT_STEPS_TOUCH : PLAN_HINT_STEPS)[stage].map(([keys, text]) => {
      const step = document.createElement('span');
      step.className = 'ui-hint-step';
      step.append(...keys.map((key) => createKeyCap(key)), text);
      return step;
    });
  }
}
