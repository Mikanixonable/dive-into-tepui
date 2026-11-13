// 建造中に選んだモジュールの脇へ追従する操作メニュー。回転(−90°/+90°)・端の入れ替え・
// 付け替え・撤去・複製・選択解除を持ち、毎フレーム渡される画面座標へ
// 置き直す。画面の端からはみ出さないよう画面内へ寄せて置き、モジュールが画面の外へ
// 出ても画面の縁へ寄せて残す。編集できない選択(接舷中の接続の先)では、効かない
// 回転・端の入れ替え・付け替え・撤去を出さない。
import { Button } from '../../../hud/widgets';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import type { Projected } from '../../../math/projection';

// モジュールの画面位置からメニューを離す横方向の隙間 [px]。
const MENU_GAP_PX = 16;
// 画面の縁へ寄せるときに空ける余白 [px]。
const VIEWPORT_MARGIN_PX = 8;

const STYLE = `
#construction-selection-menu {
  position: fixed; display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3); pointer-events: auto; user-select: none;
  -webkit-user-select: none;
}
#construction-selection-menu.hidden { display: none !important; }
#construction-selection-menu .construction-selection-menu-actions {
  display: flex; flex-wrap: wrap; gap: var(--space-2); max-width: 260px;
}
`;

let styleInjected = false;

function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 選択メニュー1フレーム分の表示内容。(x, y) は追従先のモジュールの画面座標 [px]。
export interface ConstructionSelectionMenuSpec extends Projected {
  // 回転・端の入れ替え・付け替え・撤去を出すか(編集できる選択のときだけ)。
  readonly canEdit: boolean;
}

// メニューの操作を建造セッションへ渡す口。パネルの on* へ委譲する。
export interface ShipConstructionSelectionMenuCallbacks {
  readonly onRotate: (delta: 1 | -1) => void;
  readonly onSwapEnds: () => void;
  readonly onReattach: () => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
  readonly onDeselect: () => void;
}

export class ShipConstructionSelectionMenu {
  private readonly root: HTMLElement;
  private readonly rollLeft: Button;
  private readonly rollRight: Button;
  private readonly swapEnds: Button;
  private readonly reattach: Button;
  private readonly remove: Button;
  private readonly duplicate: Button;
  private readonly deselect: Button;

  // 追従 DOM を marker レイヤ配下へ組み、操作を callbacks へ配線する。
  public constructor(parent: HTMLElement, callbacks: ShipConstructionSelectionMenuCallbacks) {
    injectStyle();
    this.root = document.createElement('div');
    this.root.id = 'construction-selection-menu';
    this.root.dataset.id = 'construction-selection-menu';
    this.root.className = 'ui-surface-focus hidden';
    // メニュー上のポインタ操作を船体のクリック・カメラ回転へ流さない。
    for (const type of ['pointerdown', 'pointerup', 'pointermove']) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    this.rollLeft = new Button(
      '左へ回す', () => callbacks.onRotate(-1), '⟲', 'secondary', K.constructionRollLeft.label,
    );
    this.rollLeft.element.dataset.id = 'construction-menu-roll-left';
    this.rollRight = new Button(
      '右へ回す', () => callbacks.onRotate(1), '⟳', 'secondary', K.constructionRollRight.label,
    );
    this.rollRight.element.dataset.id = 'construction-menu-roll-right';
    this.swapEnds = new Button(
      '端の入れ替え', () => callbacks.onSwapEnds(), undefined, 'secondary', K.constructionSwapEnds.label,
    );
    this.swapEnds.element.dataset.id = 'construction-menu-swap-ends';
    this.reattach = new Button('付け替える', () => callbacks.onReattach(), undefined, 'primary');
    this.reattach.element.dataset.id = 'construction-menu-reattach';
    this.remove = new Button('撤去', () => callbacks.onRemove(), undefined, 'secondary', K.constructionRemove.label);
    this.remove.element.dataset.id = 'construction-menu-remove';
    this.duplicate = new Button(
      '複製', () => callbacks.onDuplicate(), undefined, 'secondary', K.constructionDuplicate.label,
    );
    this.duplicate.element.dataset.id = 'construction-menu-duplicate';
    this.deselect = new Button('選択を解く', () => callbacks.onDeselect(), undefined, 'secondary');
    this.deselect.element.dataset.id = 'construction-menu-deselect';

    const actions = document.createElement('div');
    actions.className = 'construction-selection-menu-actions';
    actions.append(
      this.rollLeft.element, this.rollRight.element, this.swapEnds.element,
      this.reattach.element, this.remove.element, this.duplicate.element, this.deselect.element,
    );
    this.root.append(actions);
    parent.appendChild(this.root);
  }

  // メニューをモジュールの右脇の画面座標へ置き直す。spec が null の間は隠す。
  public sync(spec: ConstructionSelectionMenuSpec | null): void {
    if (spec === null) {
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');
    const show = (el: HTMLElement, visible: boolean): void => { el.classList.toggle('hidden', !visible); };
    show(this.rollLeft.element, spec.canEdit);
    show(this.rollRight.element, spec.canEdit);
    show(this.swapEnds.element, spec.canEdit);
    show(this.reattach.element, spec.canEdit);
    show(this.remove.element, spec.canEdit);

    // 画面からはみ出す向きへ出る分は画面内へ寄せる。カメラ背後(front=false)や
    // 画面外の投影もこの寄せで画面の縁に残る。
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const left = clampPx(spec.x + MENU_GAP_PX, VIEWPORT_MARGIN_PX, window.innerWidth - width - VIEWPORT_MARGIN_PX);
    const top = clampPx(spec.y - height / 2, VIEWPORT_MARGIN_PX, window.innerHeight - height - VIEWPORT_MARGIN_PX);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  // 追従 DOM を取り除く。
  public dispose(): void {
    this.root.remove();
  }
}

// value を [min, max] へ収める。max が min を下回る(画面よりメニューが大きい)ときは min 側へ寄せる。
function clampPx(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
