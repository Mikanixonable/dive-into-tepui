// 視点の根。遊ぶ人の選択のうちセーブごとに持つものの所有者を組み、直列化と復元と、
// 進行が記録した出来事に視点を合わせる規則を1か所に持つ(R4)。
import { NavTargetSelection, type SerializedNavTargetSelection } from './nav-target-selection';
import { OrbitGuideSelection } from './orbit-guide-selection';
import { OrbitReferenceSelection } from './orbit-reference-selection';
import { PredictPanelSelection } from './predict-panel-selection';
import { ViewSelection, type ViewControlSource } from './view-selection';
import { CameraSelection, type CameraFrameSamples, type SerializedCameraSelection } from './camera-selection';
import { EntityDisplaySelection } from './entity-display-selection';
import { focusTargetId } from './focus-target';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { RunEvent, RunEventSink } from '../run-events';
import type { ViewMode } from '../view/view-mode';
import type { OrbitGuideSettings } from './orbit-guide-settings';
import type { SerializedDynamicEntity } from '../dynamic/dynamic-entity/entity-dictionary';

export interface SerializedViewer {
  // 無ければ視点は既定のまま始まる。ビューの選択はカメラの記録に同居する。
  readonly camera?: SerializedCameraSelection & { readonly view: ViewMode };
  // 無ければターゲット未選択のまま始まる。
  readonly navTarget?: SerializedNavTargetSelection | null;
  // 無ければ既定の軌道ガイドで始まる。
  readonly orbitGuide?: OrbitGuideSettings;
}

export class Viewer {
  // 軌道要素の基準の選択。
  public readonly orbitReference = new OrbitReferenceSelection();
  // 予測パネルの座標系・表示期間・表示時刻・時刻表記の選択。
  public readonly predictPanel: PredictPanelSelection;

  // 各選択の所有者から組む。省いた所有者は新しいゲームの既定から始まる。control は復元と初期配置を
  // 終えた進行の操作対象、所有者の命令の結果は events へ記録する。
  private constructor(
    control: ViewControlSource,
    events: RunEventSink,
    celestialBodies: CelestialBodies,
    // 航法ターゲットの選択。
    public readonly navTarget = new NavTargetSelection(events),
    // 軌道ガイドの選択。
    public readonly orbitGuide = new OrbitGuideSelection(),
    // 戦闘/マップのビュー選択。
    public readonly view = new ViewSelection(control, events),
    // 戦闘/マップの2台のカメラ視点。
    public readonly camera = new CameraSelection(celestialBodies, events),
    // 実体ごとの表示設定。
    public readonly entityDisplay = new EntityDisplaySelection(),
  ) {
    // 予測パネルの初期基準は、マップ注視の登録天体から始まる。
    this.predictPanel = new PredictPanelSelection(
      celestialBodies.frames, celestialBodies, focusTargetId(camera.map.focus),
    );
  }

  // 新しいゲームの視点を既定から組む。
  public static create(control: ViewControlSource, events: RunEventSink, celestialBodies: CelestialBodies): Viewer {
    return new Viewer(control, events, celestialBodies);
  }

  // 直列化した形から視点を復元する。entities は直列化した実体の記録で、実体ごとの表示設定をそこから
  // 戻す。roster は復元を終えた顔ぶれ。
  public static deserialize(
    serialized: SerializedViewer & { readonly entities: readonly SerializedDynamicEntity[] },
    roster: EntityRoster,
    control: ViewControlSource,
    events: RunEventSink,
    celestialBodies: CelestialBodies,
  ): Viewer {
    const { navTarget, orbitGuide, camera } = serialized;
    return new Viewer(
      control,
      events,
      celestialBodies,
      navTarget === undefined ? undefined : NavTargetSelection.deserialize(navTarget, roster, events),
      orbitGuide === undefined ? undefined : OrbitGuideSelection.deserialize(orbitGuide),
      camera === undefined ? undefined : ViewSelection.deserialize(camera.view, control, events),
      camera === undefined ? undefined : CameraSelection.deserialize(camera, celestialBodies, events),
      EntityDisplaySelection.deserialize(serialized.entities),
    );
  }

  // 直列化した形のうち視点の分。
  public serialize(): SerializedViewer {
    return {
      camera: { view: this.view.current, ...this.camera.serialize() },
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
