// 軌道分析パネル: 高度・接近・投影の3タブを束ねるドラッグ可能ウィンドウ。選べるタブを毎 sync
// 選び直してタブバーへ出し、選択中のタブへ描画を委ねる。戦闘ビューでも未来の軌道が伸び続ける
// よう、操作対象と接近タブのターゲットに analysisPanelReader を立てるのもここが持つ。
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

// 旧対象の analysisPanelReader を降ろし、新対象に立て直す。
function applyReader(prev: DynamicEntity | null, next: DynamicEntity | null): DynamicEntity | null {
  if (prev === next) return prev;
  if (prev) prev.analysisPanelReader = false;
  if (next) next.analysisPanelReader = true;
  return next;
}

// 現在の航法ターゲットを、接近・投影タブが扱える形(艦・基地 or 天体)へ解決する。
// ラグランジュ点など質量を持たない対象は解決しない。
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

  // ESC・外側クリック・✕ ボタンのどの経路で閉じても発火する。
  public onClose: (() => void) | null = null;

  // ウィンドウとタブバーを組み立て、3つのタブの要素を積む(見えるのは選択中の1つだけ)。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number,
    overlayManager: OverlayManager, tempWindowGroup: string,
  ) {
    injectOnce('orbit-analysis-window', STYLE);
    this.win = new DraggableWindow(
      root, clientX, clientY, { title: '軌道分析', initiallyClipped: true, tempWindowGroup }, overlayManager,
    );
    this.win.element.classList.add('orbit-analysis');
    this.win.onClose = () => this.onClose?.();

    this.tabs = [this.altitudeTab, new ApproachTab(), new ProjectionTab()];
    this.tabBar = new TabBar<AnalysisTab>([[this.altitudeTab, this.altitudeTab.label]], (tab) => this.select(tab));
    this.win.body.appendChild(this.tabBar.element);
    for (const tab of this.tabs) this.win.body.appendChild(tab.element);
    this.select(this.altitudeTab);
  }

  // 呼び出し側から見た「引き上げて最前面へ」— Orbit パネルのボタンが2枚目を開かないために使う。
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

  // 操作対象とターゲットを解決し、選べるタブを出し直してから、選択中のタブへ描画を委ねる。
  public sync(game: Game): void {
    if (!this.throttle.due()) return;
    const entity = game.activeControllableEntity;
    // 別の対象を見ることになるので、各タブの表示範囲を開き直す。
    if (entity !== this.readerEntity) {
      for (const tab of this.tabs) tab.resetView();
    }
    this.readerEntity = applyReader(this.readerEntity, entity);
    if (!entity) {
      this.readerTargetEntity = applyReader(this.readerTargetEntity, null);
      this.offerTabs([this.altitudeTab]);
      this.altitudeTab.drawMessage('操作対象がありません');
      return;
    }

    const target = resolveApproachTarget(game);
    this.readerTargetEntity = applyReader(
      this.readerTargetEntity, target?.kind === 'entity' ? target.entity : null,
    );
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
