// 計器シート。スマホ横持ち(粗いポインタかつ低い画面)では左右のレールを出さず、レールの中身を下から出る
// このシートへ移す。置き場の種類を増やさず、レールが coarse かつ short のときに取る別の姿として扱う —
// シートの本体は既存のレールとパネルの DOM そのもので、ここが持つのは「いまどのタブのパネルを見せるか」
// と、タブの列・閉じるボタンの組まれた頭だけ。開閉は OverlayManager の台帳に載せる(開いている間は仮想
// パッドが隠れ、ESC と外側のタップで閉じる)。
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import { SYSTEM_MODAL_GROUP } from '../../hud/overlay-manager';
import { createHudElement } from '../../hud/hud-element';
import { CloseButton } from '../../hud/widgets/close-button';
import { TabBar } from '../../hud/widgets/tab-bar';
import type { ViewMode } from '../view/view-mode';

// OverlayManager の台帳上の id。
const OVERLAY_ID = 'instrument-sheet';

// シートのタブ1枚。panels はそのタブで見せるレール上のパネルの id。
interface SheetTabDef {
  readonly id: string;
  readonly label: string;
  readonly panels: readonly string[];
}

// 戦闘ビューのタブ。軌道のタブは燃焼管理も、艦のタブはクリエイティブのステージ操作も受け持つ。
const COMBAT_TABS: readonly SheetTabDef[] = [
  { id: 'orbit', label: '軌道', panels: ['hud-orbit', 'burn-management-panel'] },
  { id: 'vessel', label: '艦', panels: ['hud-vessel-status', 'hud-stage-controls'] },
  { id: 'camera', label: '視点', panels: ['hud-combat-camera-controls'] },
  { id: 'target', label: 'ターゲット', panels: ['hud-target'] },
  { id: 'enemies', label: '敵', panels: ['hud-enemies'] },
];

// マップビューのタブ。時間のタブは、時間軸の表示範囲と目盛りの設定を受け持つ。
const MAP_TABS: readonly SheetTabDef[] = [
  { id: 'objects', label: '物体', panels: ['hud-physical-object-list'] },
  { id: 'time', label: '時間', panels: ['hud-time-pane'] },
  { id: 'orbit', label: '軌道', panels: ['hud-orbit', 'burn-management-panel', 'hud-plan', 'hud-stage-controls'] },
  { id: 'camera', label: '視点', panels: ['hud-camera-controls', 'hud-trajectory-frame'] },
  { id: 'display', label: '表示', panels: ['hud-view-options'] },
];

const TABS_OF: Readonly<Record<ViewMode, readonly SheetTabDef[]>> = { combat: COMBAT_TABS, map: MAP_TABS };

// ロック中のターゲットが無いとき、タブごと畳むタブの id(UI-DESIGN §8「ロック時のみ表示」)。
const TARGET_TAB_ID = 'target';

export class HudSheet implements OverlayHandle {
  private readonly head: HTMLElement;
  private readonly tabBar: TabBar<string>;
  // ビューごとに直前に開いていたタブ。次に開くときはそこから始める。
  private readonly lastTab: Record<ViewMode, string> = { combat: COMBAT_TABS[0]!.id, map: MAP_TABS[0]!.id };
  private view: ViewMode = 'combat';
  private hasTarget = false;
  // 最後に当てたパネルの見せ分け。変わったときだけ DOM を書き換える。
  private appliedKey = '';

  // root は #hud、overlayManager は開閉の台帳。頭の DOM は開くまで DOM へ挿さない。
  public constructor(private readonly overlayManager: OverlayManager, private readonly root: HTMLElement) {
    // 頭は [握り][タブの列][✕]。頭の中の押下はカメラのドラッグへ伝えない。
    this.head = document.createElement('div');
    this.head.id = 'hud-sheet-head';
    this.head.className = 'ui-surface-focus';
    this.head.setAttribute('role', 'dialog');
    this.head.setAttribute('aria-label', '計器');
    createHudElement('i', 'hud-sheet-grabber', this.head).setAttribute('aria-hidden', 'true');
    this.tabBar = new TabBar<string>(this.tabItems(), (id) => this.select(id));
    this.tabBar.element.setAttribute('aria-label', '計器の種類');
    this.head.append(this.tabBar.element, new CloseButton(() => this.close()).element);
    this.head.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  public get isOpen(): boolean { return this.overlayManager.isOverlayOpen(OVERLAY_ID); }

  // いま見せるビューとターゲットの有無を受ける。開いている間にこれが変わったら、タブとパネルを当て直す。
  public sync(view: ViewMode, hasTarget: boolean): void {
    if (view === this.view && hasTarget === this.hasTarget) return;
    this.view = view;
    this.hasTarget = hasTarget;
    if (this.isOpen) this.render();
  }

  // 開いていれば閉じ、閉じていれば開く。
  public toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  // 直前のタブでシートを開く。既に開いていれば何もしない。
  public open(): void {
    if (this.isOpen) return;
    this.head.style.display = 'flex';
    // 系のモーダルと同じ扱い(開いている間は仮想パッドが隠れる)。背後の世界は止めず、入力も遮らない。
    this.overlayManager.open(OVERLAY_ID, this.head, this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: true, gatesInput: false, dimsBackground: false,
      exclusiveGroup: SYSTEM_MODAL_GROUP,
    });
    this.render();
  }

  // シートを閉じる。既に閉じていれば何もしない。
  public close(): void {
    if (!this.isOpen) return;
    this.head.style.display = 'none';
    this.overlayManager.close(OVERLAY_ID);
    delete this.root.dataset['sheet'];
    this.appliedKey = '';
  }

  // 頭とレールの内側のタップは外側扱いにしない。
  public contains(target: Node): boolean {
    if (this.head.contains(target)) return true;
    const rails = this.root.querySelectorAll('.hud-view-root.active .hud-rail');
    return Array.from(rails).some((rail) => rail.contains(target));
  }

  // 見せられるタブ。ターゲットがロックされていなければ、ターゲットのタブは畳む。
  private tabItems(): readonly (readonly [string, string])[] {
    return TABS_OF[this.view]
      .filter((tab) => tab.id !== TARGET_TAB_ID || this.hasTarget)
      .map((tab) => [tab.id, tab.label] as const);
  }

  // タブ id を選んでパネルを見せ分ける。
  private select(id: string): void {
    this.lastTab[this.view] = id;
    this.render();
  }

  // タブの列と、選ばれたタブのパネルだけを見せる印を当て直す。選んでいたタブが畳まれていれば先頭へ戻す。
  private render(): void {
    // タブの列を先に確定させ、選択を有効なタブへ寄せてから、パネルの印を当てる。
    const items = this.tabItems();
    this.tabBar.setItems(items);
    let selected = this.lastTab[this.view];
    if (!items.some(([id]) => id === selected)) selected = items[0]![0];
    this.tabBar.setSelected(selected);
    this.root.dataset['sheet'] = this.view;
    const shown = TABS_OF[this.view].find((tab) => tab.id === selected)?.panels ?? [];
    const key = `${this.view}:${selected}`;
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    for (const panel of Array.from(this.root.querySelectorAll<HTMLElement>('.hud-rail > .panel'))) {
      panel.toggleAttribute('data-sheet-shown', shown.includes(panel.id));
    }
  }

  // 閉じて、頭の DOM を取り除く。
  public dispose(): void {
    this.close();
    this.head.remove();
  }
}
