// 視点の根。遊ぶ人の選択のうちセーブごとに持つものの所有者を組み、セーブとの行き来と、
// 進行が記録した出来事に視点を合わせる規則を1か所に持つ(R4)。
import { NavTargetSelection } from './nav-target-selection';
import { OrbitGuideSelection } from './orbit-guide-selection';
import { OrbitReferenceSelection } from './orbit-reference-selection';
import { PredictPanelSelection } from './predict-panel-selection';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { RunEvent, RunEventSink } from '../run-events';
import type { GameSaveData } from '../save/save-data';

export class Viewer {
  // 航法ターゲットの選択。
  public readonly navTarget: NavTargetSelection;
  // 軌道要素の基準の選択。
  public readonly orbitReference = new OrbitReferenceSelection();
  // 軌道ガイドの選択。
  public readonly orbitGuide: OrbitGuideSelection;
  // 予測パネルの座標系・表示期間・表示時刻・時刻表記の選択。
  public readonly predictPanel: PredictPanelSelection;

  // saved のうち視点の分を戻して組む。saved が無ければ既定から始める。roster は復元した時点の
  // 顔ぶれで、所有者の命令の結果は events へ記録する。
  public constructor(
    saved: GameSaveData | undefined,
    roster: EntityRoster,
    events: RunEventSink,
    celestialBodies: CelestialBodies,
  ) {
    this.navTarget = new NavTargetSelection(saved?.navTarget, roster, events);
    this.orbitGuide = new OrbitGuideSelection(saved?.orbitGuide);
    this.predictPanel = new PredictPanelSelection(celestialBodies.frames, celestialBodies);
  }

  // セーブのうち視点の分。
  public serialize(): Pick<GameSaveData, 'navTarget' | 'orbitGuide'> {
    return { navTarget: this.navTarget.serialize(), orbitGuide: this.orbitGuide.settings };
  }

  // 進行が今ステップに記録した出来事 events と、現在表示を求めるビューへ視点を合わせる。
  // 進行の位相の末尾で、一時停止中も毎フレーム呼ぶ。
  public followProgress(events: readonly RunEvent[], forceCurrent: boolean): void {
    this.navTarget.followProgress(events);
    this.predictPanel.followProgress(forceCurrent);
  }
}
