// 建造ワークスペースの手元バー。「手に持っている」「モジュールを選んでいる」
// 「どちらでもない」の3状態を1行で言い切る。操作ボタンを持つのは手持ちの状態だけで、
// 選択中は選んだモジュールの名前と、操作はそのモジュールの脇に出るメニューにある
// という案内を示す。「置く」は押せないとき無効化し、理由をバーの中へ示す。
import { Button, SegmentedControl } from '../../../hud/widgets';
import { createKeyCap } from '../../../hud/key-cap';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { formatConstructionOrientation } from './ship-construction-format';
import type { ConstructionSymmetry, ShipConstructionPanelModel } from '../../ship/ship-construction-types';
import type { HudEls } from '../hud-els';

// 対称数のセグメントの選択肢。通知口(onCycleSymmetry)は1歩進める巡回なので、
// 現在値からの歩数ぶん呼んで選んだ値へ合わせる。
const SYMMETRY_STEPS: readonly ConstructionSymmetry[] = [1, 2, 4];

// 手元バーの操作を建造セッションへ渡す口。
export interface ShipConstructionHandCallbacks {
  readonly onPlace: () => void;
  readonly onRelease: () => void;
  readonly onRotate: (delta: 1 | -1) => void;
  readonly onSwapEnds: () => void;
  readonly onCycleSymmetry: () => void;
}

export class ShipConstructionHand {
  private readonly state: HTMLElement;
  private readonly name: HTMLElement;
  private readonly orientation: HTMLElement;
  private readonly reason: HTMLElement;
  private readonly note: HTMLElement;
  private readonly rollLeft: Button;
  private readonly rollRight: Button;
  private readonly swapEnds: Button;
  private readonly symmetry: SegmentedControl<ConstructionSymmetry>;
  private readonly confirm: Button;
  private readonly release: Button;
  private currentSymmetry: ConstructionSymmetry = 1;

  // 静的な手元バーの枠へ、状態に応じて出し入れする操作部品を差し込む。
  public constructor(els: HudEls, callbacks: ShipConstructionHandCallbacks) {
    this.state = els.get('construction-hand-state');
    this.name = els.get('construction-hand-name');
    this.orientation = els.get('construction-hand-orientation');
    this.reason = els.get('construction-hand-reason');
    this.note = els.get('construction-hand-note');

    // 回転・反転・対称数・確定・手放しの操作部品を組む。
    this.rollLeft = new Button('左へ回す', () => callbacks.onRotate(-1), '⟲', 'secondary', K.constructionRollLeft.label);
    this.rollRight = new Button('右へ回す', () => callbacks.onRotate(1), '⟳', 'secondary', K.constructionRollRight.label);
    this.swapEnds = new Button(
      '向きを反転', () => callbacks.onSwapEnds(), undefined, 'secondary', K.constructionSwapEnds.label,
    );
    this.symmetry = new SegmentedControl<ConstructionSymmetry>('対称数', SYMMETRY_STEPS.map(s => [s, String(s)] as const), (value) => {
      const steps = (SYMMETRY_STEPS.indexOf(value) - SYMMETRY_STEPS.indexOf(this.currentSymmetry) + 3) % 3;
      for (let i = 0; i < steps; i++) callbacks.onCycleSymmetry();
    });
    this.symmetry.element.querySelector('.w-group-title')?.after(createKeyCap(K.constructionSymmetry.label));
    this.confirm = new Button('置く', () => callbacks.onPlace(), undefined, 'primary', K.constructionPlace.label);
    this.release = new Button('手放す', () => callbacks.onRelease(), undefined, 'secondary');

    els.get('construction-hand-actions').append(
      this.rollLeft.element, this.rollRight.element, this.swapEnds.element, this.symmetry.element,
      this.confirm.element, this.release.element,
    );
  }

  // 3状態の言い切りと、各状態で効く操作の出し分けを表示モデルへ揃える。
  // 手持ちと選択が同時にあるとき(選択中のモジュールを掴んだ状態)は手持ちを優先する。
  public sync(model: ShipConstructionPanelModel): void {
    const held = model.held;
    const selection = held === null ? model.selection : null;
    const show = (el: HTMLElement, visible: boolean): void => { el.classList.toggle('hidden', !visible); };

    this.state.textContent = held !== null ? '置く:'
      : selection !== null ? '選択:'
      : 'カードを押して手に取る · 船体のモジュールを押して選ぶ';
    const name = held?.name ?? selection?.name ?? null;
    this.name.textContent = name ?? '';
    show(this.name, name !== null);
    const orientation = held?.orientation ?? null;
    this.orientation.textContent = orientation === null ? '' : formatConstructionOrientation(orientation);
    show(this.orientation, orientation !== null);

    // 操作ボタンを持つのは手持ちの状態だけ。選択中の操作はモジュール脇のメニューが持つ。
    show(this.rollLeft.element, held !== null);
    show(this.rollRight.element, held !== null);
    show(this.swapEnds.element, held !== null);
    show(this.symmetry.element, held !== null);
    this.confirm.setEnabled(model.canPlace);
    show(this.confirm.element, held !== null);
    show(this.release.element, held !== null);

    const reasonText = held !== null ? model.placeBlockReason : null;
    this.reason.textContent = reasonText ?? '';
    this.reason.classList.toggle('hidden', reasonText === null);
    const noteText = selection === null ? null
      : selection.canEdit
        ? '操作は選んだモジュールの脇のメニューにあります'
        : '接舷中の接続の先は編集できません · 操作は選んだモジュールの脇のメニューにあります';
    this.note.textContent = noteText ?? '';
    this.note.classList.toggle('hidden', noteText === null);

    if (held !== null) {
      this.currentSymmetry = held.symmetry;
      this.symmetry.setSelected(held.symmetry);
    }
  }
}
