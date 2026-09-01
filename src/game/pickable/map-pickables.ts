// マップ上で「何が選べるか」を1フレーム分組み立てる。被選択物(MapPickable)の候補集合と、
// その回の表示可否(MapVisibilityPolicy)を答える。
import { MapPickable } from './map-pickable';
import { focusTargetId } from '../camera/focus-target';
import { DynamicSystem } from '../dynamic/dynamic-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import { NavTarget } from '../nav-target';
import type { FrameAnchorSource } from '../../physics/frame';
import { CameraSystem } from '../camera/camera-system';
import type { CelestialMarkers } from '../marker/celestial-markers';
import { PlanEditor } from '../plan/plan-editor';
import type { ActivePlayerController } from '../active-controllable-controller';
import { isOccluded } from '../../physics/occlusion';
import { NearbySystemTracker } from '../celestial/nearby-system-tracker';
import { MapVisibilityPolicy } from '../map/visibility-policy';
import type { DisplayWindow } from '../display-window-manager';
import type { PerfCounts } from '../../perf-meter';

export class MapPickables {
  private readonly candidateItems: MapPickable[] = [];
  private _lastSimTime = 0;
  private _lastDisplayTime = 0;
  private _visibilityPolicy: MapVisibilityPolicy | null = null;
  private readonly nearbyTracker = new NearbySystemTracker();

  // このフレームの被選択物候補。refresh の後に読む。マップ視点でないフレームは空。
  get pickables(): readonly MapPickable[] { return this.candidateItems; }

  // このフレームの表示・選択可否。マップビュー以外では null。
  get visibilityPolicy(): MapVisibilityPolicy | null { return this._visibilityPolicy; }

  // 直近の refresh が受け取った simTime。ヒットテスト側が時刻依存の項目(通過時刻等)を
  // 同じ時刻で求め直すために読む。
  get lastSimTime(): number { return this._lastSimTime; }

  // 直近の refresh が候補の位置を求めた表示時刻。候補の位置を引き直すときはこの時刻を渡す。
  get lastDisplayTime(): number { return this._lastDisplayTime; }

  // 候補の供給元を参照として受け取る。
  constructor(
    private readonly activePlayers: ActivePlayerController,
    private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly editor: PlanEditor,
    private readonly frameAnchors: FrameAnchorSource,
  ) {}

  // マップの天体ラベル(表示のみ)と航法ターゲットの AN/DN を求め直したうえで、このフレームの
  // 候補列を組み直す(表示中の天体・ラグランジュ点 + 生存中の自艦・敵船・弾薬・基地 + AN/DN
  // アイコン + 近地点・遠地点アイコン)。天体側も表示と同じ MapVisibilityPolicy を通し、
  // 非表示にした対象を選べない状態にする。物理積分の後に呼ぶ: 積分前に組むと、同フレームで
  // sync されるメッシュと座標が1ステップずれる。
  refresh(displayWindow: DisplayWindow): void {
    if (!this.cameraSystem.overviewMode) {
      this.candidateItems.length = 0;
      this._visibilityPolicy = null;
      return;
    }
    const { simTime, displayTime } = displayWindow;
    this._lastSimTime = simTime;
    this._lastDisplayTime = displayTime;
    const focusId = focusTargetId(this.cameraSystem.mapCamera.focus);
    // 候補の位置は表示時刻のものなので、遮蔽・系の判定もその時刻の天体位置で行う。
    const celestialBodies = this.celestialSystem.celestialMotions;
    const visibilityPolicy = new MapVisibilityPolicy(
      this.celestialSystem,
      this.cameraSystem.mapDisplayToggles,
      focusId,
      this.nearbyTracker.membersAt(
        this.celestialSystem, this.cameraSystem.activeCameraPos, displayTime),
    );
    this._visibilityPolicy = visibilityPolicy;
    this.celestialMarkers.update(displayTime, this.cameraSystem.mapDisplayToggles, visibilityPolicy);
    this.navTarget.update(
      this.activePlayers.current, this.entities, this.celestialSystem, displayWindow, this.frameAnchors);

    const activePlayer = this.activePlayers.current;
    // 候補1件を、消滅・表示トグル・位置の有無・所属系・遮蔽の順に通してこのフレームの候補列へ積む。
    // 所属系と遮蔽をどう扱うかは候補自身が答える — 表示側と同じ判定なので、地球の裏側の
    // 自艦は表示・選択でき、土星系の自艦はどちらにも現れない。
    const append = (item: MapPickable): void => {
      if (item.gone || !item.mapVisibility(visibilityPolicy, activePlayer).pickable) return;
      const pos = item.mapPosAt(displayTime);
      if (pos === null) return;
      if (item.onlyInFocusedSystem
        && !this.celestialSystem.isPositionInFocusedSystem(focusId, pos, displayTime)) return;
      if (item.hiddenBehindBodies
        && isOccluded(this.cameraSystem.activeCameraPos, pos, celestialBodies, displayTime)) return;
      this.candidateItems.push(item);
    };

    this.candidateItems.length = 0;
    for (const body of this.celestialMarkers.bodyPickables) append(body);
    for (const ship of this.entities.players) append(ship);
    for (const enemy of this.entities.enemies) append(enemy);
    for (const ammoPickup of this.entities.ammoPickups) append(ammoPickup);
    for (const fuelPickup of this.entities.rcsFuelPickups) append(fuelPickup);
    for (const base of this.entities.bases) append(base);
    for (const node of this.navTarget.mapPickables()) append(node);
    for (const apsis of this.editor.planDisplay.apsisMarkers) append(apsis);
    for (const e of this.entities.all()) {
      if (e.equatorNodes) for (const node of e.equatorNodes.mapPickables()) append(node);
    }
  }

  // 負荷確認ウィンドウが読む、マップ視点かどうかとその候補列/ラベル数。
  perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    const overviewMode = this.cameraSystem.overviewMode;
    return {
      mapMode: overviewMode,
      mapItems: this.candidateItems.length,
      mapLabels: overviewMode ? this.celestialMarkers.shownLabelCount : 0,
    };
  }
}
