// 軌道分析のドラッグ可能ウィンドウ。高度・接近・投影の3タブのうち、いま選べるものをタブバーへ
// 出し、選択中のタブへ描画を委ねる。見ている個体(操作対象と接近タブのターゲット)へ
// analysisPanelReader を立て、戦闘ビューでもその軌道が伸び続けるようにするのもここが持つ。
import { SyncThrottle } from '../sync-throttle';
import { DraggableWindow } from '../../../hud/windows/draggable-window';
import { MQ_COMPACT } from '../../../hud/breakpoints';
import { TabBar, injectOnce } from '../../../hud/widgets';
import { AltitudeTab } from './orbit-altitude-tab';
import { ApproachTab } from './orbit-approach-tab';
import { ProjectionTab } from './orbit-projection-tab';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { OverlayManager } from '../../../hud/overlay-manager';
import type { ApproachTargetSource } from './orbit-analysis-data';
import type { AnalysisTab } from './orbit-analysis-tab';

const SYNC_INTERVAL_MS = 250;

const STYLE = `
#hud .dg-window.orbit-analysis { max-width: 420px; }
@media ${MQ_COMPACT} {
  #hud .dg-window.orbit-analysis { max-width: 100%; }
}
`;

// analysisPanelReader を prev から降ろして next へ立て、いま立てている側(next)を返す。
function applyReader(prev: DynamicEntity | null, next: DynamicEntity | null): DynamicEntity | null {
  if (prev === next) return prev;
  if (prev) prev.analysisPanelReader = false;
  if (next) next.analysisPanelReader = true;
  return next;
}

// 現在の航法ターゲットを、接近・投影タブが扱える形(天体 or 個体)へ解決する。
// 質量を持たない対象(ラグランジュ点など)と、ターゲット未選択のときは null。
function resolveApproachTarget(game: Game): ApproachTargetSource | null {
  const id = game.navTarget.id;
  if (id === null) return null;
  const body = game.celestialSystem.find(id)?.motion;
  if (body !== undefined) return { kind: 'celestialBody', body };
  const entity = game.dynamicSystem.findAliveCombatTarget(id);
  return entity ? { kind: 'entity', entity } : null;
}

export class OrbitAnalysisWindow {
  private readonly win: DraggableWindow;
  private readonly tabBar: TabBar<AnalysisTab>;
  // 高度タブは常に選べるので、他のタブが選べなくなったときの戻り先になる。
  private readonly altitudeTab = new AltitudeTab();
  private readonly tabs: readonly AnalysisTab[];
  private selected: AnalysisTab = this.altitudeTab;
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // analysisPanelReader を立てている個体(操作対象・接近/投影タブのターゲット)。
  private readerEntity: DynamicEntity | null = null;
  private readerTargetEntity: DynamicEntity | null = null;
  // 直前に描いた操作対象。切り替わったフレームでタブの表示範囲を開き直す。
  private drawnEntity: DynamicEntity | null = null;

  // ESC・外側クリック・✕ ボタンのどの経路で閉じても発火する。
  public onClose: (() => void) | null = null;

  // (clientX, clientY) にウィンドウを開き、高度タブを選んだ状態にする。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number,
    overlayManager: OverlayManager, tempWindowGroup: string,
  ) {
    // ウィンドウの器。
    injectOnce('orbit-analysis-window', STYLE);
    this.win = new DraggableWindow(
      root, clientX, clientY, { title: '軌道分析', initiallyClipped: true, tempWindowGroup }, overlayManager,
    );
    this.win.element.classList.add('orbit-analysis');
    this.win.onClose = () => this.onClose?.();

    // 3タブを積み、選択中の1つだけが見える状態にする。
    this.tabs = [this.altitudeTab, new ApproachTab(), new ProjectionTab()];
    this.tabBar = new TabBar<AnalysisTab>([[this.altitudeTab, this.altitudeTab.label]], (tab) => this.select(tab));
    this.win.body.appendChild(this.tabBar.element);
    for (const tab of this.tabs) this.win.body.appendChild(tab.element);
    this.select(this.altitudeTab);
  }

  // ウィンドウを最前面へ持ち上げる。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  // ウィンドウを閉じ、立てていた analysisPanelReader フラグをすべて降ろす。
  public dispose(): void {
    this.readerEntity = applyReader(this.readerEntity, null);
    this.readerTargetEntity = applyReader(this.readerTargetEntity, null);
    this.win.dispose();
    for (const tab of this.tabs) tab.dispose();
  }

  // 見ている個体へ analysisPanelReader を立て、外れた個体から降ろす。予測の伸長対象は
  // このフラグで決まるので、予測を進める前に呼ぶ。
  public update(game: Game): void {
    const entity = game.activeControllableEntity;
    this.readerEntity = applyReader(this.readerEntity, entity);
    const target = entity ? resolveApproachTarget(game) : null;
    this.readerTargetEntity = applyReader(
      this.readerTargetEntity, target?.kind === 'entity' ? target.entity : null,
    );
  }

  // 選べるタブを出し直してから、選択中のタブへ描画を委ねる。
  public sync(game: Game): void {
    if (!this.throttle.due()) return;
    const entity = game.activeControllableEntity;
    // 別の対象を見ることになるので、各タブの表示範囲を開き直す。
    if (entity !== this.drawnEntity) {
      for (const tab of this.tabs) tab.resetView();
    }
    this.drawnEntity = entity;
    if (!entity) {
      this.offerTabs([this.altitudeTab]);
      this.altitudeTab.drawMessage('操作対象がありません');
      return;
    }

    const target = resolveApproachTarget(game);
    const reference = game.orbitReference.resolve(
      entity.state.r, game.celestialSystem.celestialMotions, game.navTarget,
      game.dynamicSystem, game.celestialSystem, entity.state.t,
    );
    this.offerTabs(this.tabs.filter((tab) => tab.available(game, entity, reference, target)));
    this.selected.draw(game, entity, reference, target);
  }

  // 選べるタブだけをタブバーへ出し、選択中が選べなくなっていたら高度タブへ戻す。
  private offerTabs(selectable: readonly AnalysisTab[]): void {
    this.tabBar.setItems(selectable.map((tab) => [tab, tab.label] as const));
    if (selectable.includes(this.selected)) this.tabBar.setSelected(this.selected);
    else this.select(this.altitudeTab);
  }

  // タブを切り替え、表示範囲を開いた時点の状態へ戻し、そのタブの要素だけを見せる。
  private select(tab: AnalysisTab): void {
    this.selected = tab;
    tab.resetView();
    this.tabBar.setSelected(tab);
    for (const other of this.tabs) other.element.classList.toggle('hidden', other !== tab);
  }
}
