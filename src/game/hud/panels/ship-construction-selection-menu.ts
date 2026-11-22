// 選択中モジュールの近くに操作メニューを表示し、選択位置に追従させる。
import { Button } from '../../../hud-kit/widgets';
import { clampOverlayPosition } from '../../../hud-kit/layout';
import { injectOnce } from '../../../hud-kit/inject-style';
import { KEY_MAPPING as K } from '../../../input-devices/key-mapping';
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

// 選択メニュー1フレーム分の表示内容。(x, y) は追従先のモジュールの画面座標 [px]。
interface ConstructionSelectionMenuSpec extends Projected {
  // 回転・向きを反転・付け替え・撤去を出すか(編集できる選択のときだけ)。
  readonly canEdit: boolean;
}

// メニューの操作を建造セッションへ渡す口。
interface ShipConstructionSelectionMenuCallbacks {
  readonly onRotate: (delta: 1 | -1) => void;
  readonly onSwapEnds: () => void;
  readonly onReattach: () => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
}

export class ShipConstructionSelectionMenu {
  private readonly root: HTMLElement;
  private readonly rollLeft: Button;
  private readonly rollRight: Button;
  private readonly swapEnds: Button;
  private readonly reattach: Button;
  private readonly remove: Button;
  private readonly duplicate: Button;

  // 追従 DOM を marker レイヤ配下へ組み、操作を callbacks へ配線する。
  public constructor(parent: HTMLElement, callbacks: ShipConstructionSelectionMenuCallbacks) {
    injectOnce('construction-selection-menu', STYLE);
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
      '向きを反転', () => callbacks.onSwapEnds(), undefined, 'secondary', K.constructionSwapEnds.label,
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

    const actions = document.createElement('div');
    actions.className = 'construction-selection-menu-actions';
    actions.append(
      this.rollLeft.element, this.rollRight.element, this.swapEnds.element,
      this.reattach.element, this.remove.element, this.duplicate.element,
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

    // 投影位置が画面外でもメニューは見える範囲へ寄せる。
    const height = this.root.offsetHeight;
    const pos = clampOverlayPosition(
      { x: spec.x + MENU_GAP_PX, y: spec.y - height / 2 },
      { width: this.root.offsetWidth, height },
      { width: window.innerWidth, height: window.innerHeight },
      VIEWPORT_MARGIN_PX,
    );
    this.root.style.left = `${pos.x}px`;
    this.root.style.top = `${pos.y}px`;
  }

  // 追従 DOM を取り除く。
  public dispose(): void {
    this.root.remove();
  }
}
