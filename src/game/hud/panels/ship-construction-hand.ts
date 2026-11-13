// 建造ワークスペースの手元バー。「手に持っている」「モジュールを選んでいる」
// 「どちらでもない」の3状態を1行で言い切り、その状態で効く操作だけを並べる。
// 効かない操作は無効化ではなく隠す。「置く」「付け替える」だけは押せないとき
// 無効化し、理由をバーの中へ示す。
import { Button, SegmentedControl, ValueInput } from '../../../hud/widgets';
import { createKeyCap } from '../../../hud/key-cap';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { formatConstructionOrientation } from './ship-construction-format';
import type { ConstructionSymmetry, ShipConstructionPanelModel } from '../../ship/ship-construction-types';
import type { HudEls } from '../hud-els';

// 対称数のセグメントの選択肢。セッション側は 1→2→4 の巡回口だけを持つので、
// 現在値からの歩数だけ巡回させて選んだ値へ合わせる。
const SYMMETRY_STEPS: readonly ConstructionSymmetry[] = [1, 2, 4];

// 手元バーの操作を建造セッションへ渡す口。パネルの on* へ委譲する。
export interface ShipConstructionHandCallbacks {
  readonly onPlace: () => void;
  readonly onRelease: () => void;
  readonly onDeselect: () => void;
  readonly onRotate: (delta: 1 | -1) => void;
  readonly onSwapEnds: () => void;
  readonly onCycleSymmetry: () => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
  readonly onSaveBlueprint: (name: string) => void;
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
  private readonly remove: Button;
  private readonly duplicate: Button;
  private readonly blueprintForm: HTMLElement;
  private readonly blueprintName: ValueInput;
  private readonly saveBlueprint: Button;
  private readonly deselect: Button;
  private currentSymmetry: ConstructionSymmetry = 1;

  // 静的な手元バーの枠へ、状態に応じて出し入れする操作部品を差し込む。
  public constructor(els: HudEls, callbacks: ShipConstructionHandCallbacks) {
    this.state = els.get('construction-hand-state');
    this.name = els.get('construction-hand-name');
    this.orientation = els.get('construction-hand-orientation');
    this.reason = els.get('construction-hand-reason');
    this.note = els.get('construction-hand-note');
    this.blueprintForm = els.get('construction-hand-blueprint');

    // 回転と端の入れ替えは、手持ちと編集できる選択のどちらの状態でも同じボタンが効く。
    this.rollLeft = new Button('左へ回す', () => callbacks.onRotate(-1), '⟲', 'secondary', K.constructionRollLeft.label);
    this.rollRight = new Button('右へ回す', () => callbacks.onRotate(1), '⟳', 'secondary', K.constructionRollRight.label);
    this.swapEnds = new Button(
      '端の入れ替え', () => callbacks.onSwapEnds(), undefined, 'secondary', K.constructionSwapEnds.label,
    );
    this.symmetry = new SegmentedControl<ConstructionSymmetry>('対称数', SYMMETRY_STEPS.map(s => [s, String(s)] as const), (value) => {
      const steps = (SYMMETRY_STEPS.indexOf(value) - SYMMETRY_STEPS.indexOf(this.currentSymmetry) + 3) % 3;
      for (let i = 0; i < steps; i++) callbacks.onCycleSymmetry();
    });
    this.symmetry.element.querySelector('.w-group-title')?.after(createKeyCap(K.constructionSymmetry.label));
    // 確定ボタンは状態で名前が変わる(手持ちは「置く」、選択中は「付け替える」)。
    this.confirm = new Button('置く', () => callbacks.onPlace(), undefined, 'primary', K.constructionPlace.label);
    this.release = new Button('手放す', () => callbacks.onRelease(), undefined, 'secondary');
    this.remove = new Button('撤去', () => callbacks.onRemove(), undefined, 'secondary', K.constructionRemove.label);
    this.duplicate = new Button('複製', () => callbacks.onDuplicate(), undefined, 'secondary', K.constructionDuplicate.label);
    this.blueprintName = new ValueInput({ type: 'text', placeholder: '設計図の名前' }, () => undefined);
    this.saveBlueprint = new Button(
      '設計図として保存', () => callbacks.onSaveBlueprint(this.blueprintName.element.value), undefined, 'secondary',
    );
    this.blueprintForm.append(this.blueprintName.element, this.saveBlueprint.element);
    this.deselect = new Button('選択を解く', () => callbacks.onDeselect(), undefined, 'secondary');

    els.get('construction-hand-actions').append(
      this.rollLeft.element, this.rollRight.element, this.swapEnds.element, this.symmetry.element,
      this.confirm.element, this.release.element, this.remove.element, this.duplicate.element,
      this.blueprintForm, this.deselect.element,
    );
  }

  // 3状態の言い切りと、各状態で効く操作の出し分けを表示モデルへ揃える。
  // 手持ちと選択が同時にあるとき(選択中のモジュールを掴んだ状態)は手持ちを優先する。
  public sync(model: ShipConstructionPanelModel): void {
    const held = model.held;
    const selection = held === null ? model.selection : null;
    const editable = selection?.canEdit === true;
    // 確定・回転・端の入れ替えが効く状態(手持ち、または編集できる選択)。
    const editableState = held !== null || editable;
    const show = (el: HTMLElement, visible: boolean): void => { el.classList.toggle('hidden', !visible); };

    this.state.textContent = held !== null ? '置く:'
      : selection !== null ? '選択:'
      : 'カードを押して手に取る · 船体のモジュールを押して選ぶ';
    const name = held?.name ?? selection?.name ?? null;
    this.name.textContent = name ?? '';
    show(this.name, name !== null);
    const orientation = held?.orientation ?? (editable ? selection?.orientation ?? null : null);
    this.orientation.textContent = orientation === null ? '' : formatConstructionOrientation(orientation);
    show(this.orientation, orientation !== null);

    show(this.rollLeft.element, editableState);
    show(this.rollRight.element, editableState);
    show(this.swapEnds.element, editableState);
    show(this.symmetry.element, held !== null);
    this.confirm.setLabel(held !== null ? '置く' : '付け替える');
    this.confirm.setEnabled(model.canPlace);
    show(this.confirm.element, editableState);
    show(this.release.element, held !== null);
    show(this.remove.element, editable);
    show(this.duplicate.element, editable);
    show(this.deselect.element, selection !== null);

    const canSave = editable && model.blueprintRecordReason === null;
    this.saveBlueprint.setEnabled(canSave);
    this.blueprintName.element.disabled = !canSave;
    show(this.blueprintForm, editable);

    const reasonText = editableState ? model.placeBlockReason : null;
    this.reason.textContent = reasonText ?? '';
    this.reason.classList.toggle('hidden', reasonText === null);
    const noteText = selection !== null && !editable ? '接舷中の接続の先は編集できません'
      : editable ? model.blueprintRecordReason
      : null;
    this.note.textContent = noteText ?? '';
    this.note.classList.toggle('hidden', noteText === null);

    if (held !== null) {
      this.currentSymmetry = held.symmetry;
      this.symmetry.setSelected(held.symmetry);
    }
  }
}
