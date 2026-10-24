// 画面中央上部の案内: ステージ開始のブリーフィングのカードと、軌道計画の操作を段階で示す案内チップ。
// ブリーフィングは最初の操作・一定時間・警報の発生のどれかで畳み、案内チップは計画の間だけ出す。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { createKeyCap } from '../../hud/key-cap';
import { BriefingClock } from './briefing-clock';

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

export class Guidance {
  private readonly briefingClock = new BriefingClock();
  // hintEl に組んだ案内の段。段が変わったときだけ DOM を組み替える。
  private shownStage: PlanHintStage | null = null;

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
    if (stage !== this.shownStage) {
      this.shownStage = stage;
      this.hintEl.replaceChildren(...(stage === null ? [] : this.hintSteps(stage)));
    }
    this.hintEl.classList.toggle('hidden', stage === null);
  }

  // 段 stage の案内のステップ列を組む。
  private hintSteps(stage: PlanHintStage): HTMLElement[] {
    return PLAN_HINT_STEPS[stage].map(([keys, text]) => {
      const step = document.createElement('span');
      step.className = 'ui-hint-step';
      step.append(...keys.map((key) => createKeyCap(key)), text);
      return step;
    });
  }
}
