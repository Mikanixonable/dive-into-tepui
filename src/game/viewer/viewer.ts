// 視点の根。遊ぶ人の選択のうちセーブごとに持つものの所有者を組み、セーブとの行き来と、
// 進行が記録した出来事に視点を合わせる規則を1か所に持つ(R4)。
import { NavTargetSelection } from './nav-target-selection';
import { OrbitReferenceSelection } from './orbit-reference-selection';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { RunEvent, RunEventSink } from '../run-events';
import type { GameSaveData } from '../save/save-data';

export class Viewer {
  // 航法ターゲットの選択。
  public readonly navTarget: NavTargetSelection;
  // 軌道要素の基準の選択。
  public readonly orbitReference = new OrbitReferenceSelection();

  // saved のうち視点の分を戻して組む。saved が無ければ既定から始める。roster は復元した時点の
  // 顔ぶれで、所有者の命令の結果は events へ記録する。
  public constructor(saved: GameSaveData | undefined, roster: EntityRoster, events: RunEventSink) {
    this.navTarget = new NavTargetSelection(saved?.navTarget, roster, events);
  }

  // セーブのうち視点の分。
  public serialize(): Pick<GameSaveData, 'navTarget'> {
    return { navTarget: this.navTarget.serialize() };
  }

  // 進行が今ステップに記録した出来事 events に視点を合わせる。進行の位相の末尾で、一時停止中も
  // 毎フレーム呼ぶ。
  public followProgress(events: readonly RunEvent[]): void {
    this.navTarget.followProgress(events);
  }
}
