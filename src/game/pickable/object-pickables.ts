// マップ上で「何が選べるか」を1フレーム分組み立てる。被選択物(ObjectPickable)の候補集合と、
// その回の表示可否(MapVisibilityPolicy)を答える。
import { objectPickableOf, ObjectPickable } from './object-pickable';
import { focusTargetId } from '../camera/focus-target';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { NavTarget } from '../nav-target';
import type { FrameAnchorSource } from '../../physics/frame';
import { CameraSystem } from '../camera/camera-system';
import type { CelestialMarkers } from '../marker/celestial-markers';
import { PlanDisplay } from '../plan/plan-display';
import type { ControlSelection } from '../control-selection';
import { isOccluded } from '../../physics/occlusion';
import { NearbySystemTracker } from '../celestial/nearby-system-tracker';
import type { MapDisplayToggles } from '../map/display-toggles';
import { MapVisibilityPolicy } from '../map/visibility-policy';
import type { DisplayWindow } from '../display-window-manager';
import type { EquatorNodeManager } from '../marker/equator-node-manager';

export class ObjectPickables {
  private readonly candidateItems: ObjectPickable[] = [];
  private _lastSimTime = 0;
  private _lastDisplayTime = 0;
  private _visibilityPolicy: MapVisibilityPolicy | null = null;
  private readonly nearbyTracker = new NearbySystemTracker();

  // このフレームの被選択物候補。refresh の後に読む。clear の後は空。
  public get pickables(): readonly ObjectPickable[] { return this.candidateItems; }

  // このフレームの表示・選択可否。refresh の前と clear の後は null。
  public get visibilityPolicy(): MapVisibilityPolicy | null { return this._visibilityPolicy; }

  // 直近の refresh が受け取った simTime。時刻依存の項目(通過時刻等)はこの時刻で求め直す。
  public get lastSimTime(): number { return this._lastSimTime; }

  // 直近の refresh が候補の位置を求めた表示時刻。候補の位置を引き直すときはこの時刻を渡す。
  public get lastDisplayTime(): number { return this._lastDisplayTime; }

  // 候補の供給元を参照として受け取る。
  public constructor(
    private readonly controlSelection: ControlSelection,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly planDisplay: PlanDisplay,
    private readonly frameAnchors: FrameAnchorSource,
    private readonly equatorNodes: EquatorNodeManager,
  ) {}

  // 候補列と可視性ポリシーを空へ戻す。マップを離れるときに呼ぶ。
  public clear(): void {
    this.candidateItems.length = 0;
    this._visibilityPolicy = null;
  }

  // 候補列と可視性ポリシーを組み直し、天体マーカーと航法ターゲットをこの表示時刻へ進める。
  // 候補は表示中の天体・ラグランジュ点・被選択物を名乗る個体・航法ターゲット・AN/DN・近点で、
  // 表示で隠した対象は外れる。物理積分の後に呼ぶ — 前だと同フレームのメッシュと1ステップずれる。
  public refresh(displayWindow: DisplayWindow, mapDisplay: MapDisplayToggles): void {
    const { simTime, displayTime } = displayWindow;
    this._lastSimTime = simTime;
    this._lastDisplayTime = displayTime;
    // この回の可視性ポリシーを組み、マーカーと航法ターゲットをその時刻へ進める。
    const focusId = focusTargetId(this.cameraSystem.mapCamera.focus);
    // 候補の位置は表示時刻のものなので、遮蔽・系の判定もその時刻の天体位置で行う。
    const occluders = this.celestialBodies.celestialMotions;
    const visibilityPolicy = new MapVisibilityPolicy(
      this.celestialBodies,
      mapDisplay,
      focusId,
      this.nearbyTracker.membersAt(
        this.celestialBodies, this.cameraSystem.activeCameraPos, displayTime),
    );
    this._visibilityPolicy = visibilityPolicy;
    this.celestialMarkers.update(displayTime, mapDisplay, visibilityPolicy);
    this.navTarget.update(
      this.controlSelection.current, this.roster, this.celestialBodies, displayWindow, this.frameAnchors);

    const controlled = this.controlSelection.current;
    // 候補1件を、消滅・表示トグル・位置の有無・所属系・遮蔽の順に通して積む。所属系と遮蔽を
    // 効かせるかは候補自身が答える。
    const append = (item: ObjectPickable): void => {
      if (item.gone || !item.mapVisibility(visibilityPolicy, controlled).pickable) return;
      const pos = item.posAt(displayTime);
      if (pos === null) return;
      if (item.onlyInFocusedSystem
        && !this.celestialBodies.isPositionInFocusedSystem(focusId, pos, displayTime)) return;
      if (item.hiddenBehindBodies
        && isOccluded(this.cameraSystem.activeCameraPos, pos, occluders, displayTime)) return;
      this.candidateItems.push(item);
    };

    this.candidateItems.length = 0;
    for (const body of this.celestialMarkers.bodyPickables) append(body);
    for (const entity of this.roster.all()) {
      const pickable = objectPickableOf(entity);
      if (pickable) append(pickable);
    }
    for (const node of this.navTarget.pickables()) append(node);
    for (const apsis of this.planDisplay.apsisMarkers) append(apsis);
    for (const node of this.equatorNodes.pickables) append(node);
  }
}
