// 視点の根。遊ぶ人の選択のうちセーブごとに持つものの所有者を組み、セーブとの行き来と、
// 進行が記録した出来事に視点を合わせる規則を1か所に持つ(R4)。
import { NavTargetSelection } from './nav-target-selection';
import { OrbitGuideSelection } from './orbit-guide-selection';
import { OrbitReferenceSelection } from './orbit-reference-selection';
import { PredictPanelSelection } from './predict-panel-selection';
import { ViewSelection, type ViewControlSource } from './view-selection';
import { CameraSelection, type CameraFrameSamples } from './camera-selection';
import { EntityDisplaySelection } from './entity-display-selection';
import { focusTargetId } from './focus-target';
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
  // 戦闘/マップのビュー選択。
  public readonly view: ViewSelection;
  // 戦闘/マップの2台のカメラ視点。
  public readonly camera: CameraSelection;
  // 実体ごとの表示設定。
  public readonly entityDisplay: EntityDisplaySelection;

  // saved のうち視点の分を戻して組む。saved が無ければ既定から始める。roster と control には
  // 復元と初期配置を終えた進行を渡し、所有者の命令の結果は events へ記録する。
  public constructor(
    saved: GameSaveData | undefined,
    roster: EntityRoster,
    control: ViewControlSource,
    events: RunEventSink,
    celestialBodies: CelestialBodies,
  ) {
    this.navTarget = new NavTargetSelection(saved?.navTarget, roster, events);
    this.orbitGuide = new OrbitGuideSelection(saved?.orbitGuide);
    this.view = new ViewSelection(saved?.camera?.view, control, events);
    this.camera = new CameraSelection(celestialBodies, events, saved?.camera);
    // 予測パネルの初期基準は、復元したマップ注視の登録天体から始まる。
    this.predictPanel = new PredictPanelSelection(
      celestialBodies.frames, celestialBodies, focusTargetId(this.camera.map.focus),
    );
    this.entityDisplay = new EntityDisplaySelection(saved?.entities);
  }

  // セーブのうち視点の分。
  public serialize(): Pick<GameSaveData, 'camera' | 'navTarget' | 'orbitGuide'> {
    return {
      camera: this.camera.serialize(this.view.current),
      navTarget: this.navTarget.serialize(),
      orbitGuide: this.orbitGuide.settings,
    };
  }

  // 進行が今ステップに記録した出来事と、現在表示を求めるビューへ各選択を合わせる。
  // 進行の位相の末尾で、一時停止中も毎フレーム呼ぶ。
  public followProgress(events: readonly RunEvent[]): void {
    this.navTarget.followProgress(events);
    this.predictPanel.followProgress(this.view.current !== 'map');
  }

  // 進行直後の姿勢・座標系と注視対象の生存状態へカメラ視点を合わせる。
  public followCameraProgress(events: readonly RunEvent[], samples: CameraFrameSamples): void {
    this.camera.followProgress(events, samples, this.view.current);
  }
}
