// マップ上で「何が選べるか」を1フレーム分組み立てる。被選択物(ObjectPickable)の候補集合と、
// その回の表示可否(MapVisibilityPolicy)を答える。候補は2段のピック(SPEC/MAP.md
// 「クリックとピック」)に対応して2本あり、記号を出していない対象は本体段だけに残る。
import { objectPickableOf, ObjectPickable } from './object-pickable';
import { focusTargetId } from '../viewer/focus-target';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { NavTargetPresenter } from '../nav-target-presenter';
import type { FrameAnchorSource } from '../../physics/frame';
import type { MapCameraSource } from '../viewer/camera-selection';
import type { CelestialMarkers } from '../marker/celestial-markers';
import { PlanDisplay } from '../plan/plan-display';
import type { ControlSelection } from '../control-selection';
import { isOccluded } from '../../physics/occlusion';
import { NearbySystemTracker } from '../celestial/nearby-system-tracker';
import type { MapDisplayToggles } from '../map/display-toggles';
import { MapVisibilityPolicy } from '../map/visibility-policy';
import type { DisplayWindow } from '../display-window-manager';
import type { EquatorNodeManager } from '../marker/equator-node-manager';
import type { Vec3 } from '../../math/vec3';

export class ObjectPickables {
  private readonly candidateItems: ObjectPickable[] = [];
  private readonly markerItems: ObjectPickable[] = [];
  private readonly listItems: ObjectPickable[] = [];
  private _visibilityPolicy: MapVisibilityPolicy | null = null;
  private readonly nearbyTracker = new NearbySystemTracker();

  // このフレームの被選択物候補。refresh の後に読む。clear の後は空。
  public get pickables(): readonly ObjectPickable[] { return this.candidateItems; }

  // そのうち、マップに記号を出している対象。マーカー段のピックに当たる。
  public get markerPickables(): readonly ObjectPickable[] { return this.markerItems; }

  // 表示トグルの対象で、天体の背後に隠れているものも含む一覧用の候補。
  public get listPickables(): readonly ObjectPickable[] { return this.listItems; }

  // このフレームの表示・選択可否。refresh の前と clear の後は null。
  public get visibilityPolicy(): MapVisibilityPolicy | null { return this._visibilityPolicy; }

  // 候補の供給元を参照として受け取る。
  public constructor(
    private readonly controlSelection: ControlSelection,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly navTargetPresenter: NavTargetPresenter,
    private readonly camera: MapCameraSource,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly planDisplay: PlanDisplay,
    private readonly frameAnchors: FrameAnchorSource,
    private readonly equatorNodes: EquatorNodeManager,
  ) {}

  // 候補列と可視性ポリシーを空へ戻す。マップを離れるときに呼ぶ。
  public clear(): void {
    this.candidateItems.length = 0;
    this.markerItems.length = 0;
    this.listItems.length = 0;
    this._visibilityPolicy = null;
  }

  // 候補列と可視性ポリシーを組み直し、天体マーカーと航法ターゲットをこの表示時刻へ進める。
  // 候補は天体・ラグランジュ点・選択対象となる個体・航法ターゲット・AN/DN・近点。物理積分の
  // 後に呼ぶ — 前だと同フレームのメッシュと1ステップずれる。
  public refresh(displayWindow: DisplayWindow, mapDisplay: MapDisplayToggles, cameraPos: Vec3): void {
    const { displayTime } = displayWindow;
    // この回の可視性ポリシーを組み、マーカーと航法ターゲットをその時刻へ進める。
    const focusId = focusTargetId(this.camera.map.focus);
    // 候補の位置は表示時刻のものなので、遮蔽・系の判定もその時刻の天体位置で行う。
    const occluders = this.celestialBodies.celestialMotions;
    const visibilityPolicy = new MapVisibilityPolicy(
      this.celestialBodies,
      mapDisplay,
      focusId,
      this.nearbyTracker.membersAt(
        this.celestialBodies, cameraPos, displayTime),
    );
    this._visibilityPolicy = visibilityPolicy;
    this.celestialMarkers.update(displayTime, mapDisplay, visibilityPolicy);
    this.navTargetPresenter.update(
      this.controlSelection.current, this.roster, this.celestialBodies, displayWindow, this.frameAnchors);

    const controlled = this.controlSelection.current;
    // 候補1件を、消滅・位置の有無・所属系・可視性の順に一覧へ積む。遮蔽を効かせるかは
    // 候補自身が答え、一覧からは外さずマップ上のピック候補だけを絞る。記号を出している対象は、
    // あわせてマーカー段の候補にもする。
    const append = (item: ObjectPickable): void => {
      if (item.gone) return;
      const pos = item.posAt(displayTime);
      if (pos === null) return;
      if (item.onlyInFocusedSystem
        && !this.celestialBodies.isPositionInFocusedSystem(focusId, pos, displayTime)) return;
      const visibility = item.mapVisibility(visibilityPolicy, controlled);
      if (visibility.pickable) this.listItems.push(item);
      if (item.hiddenBehindBodies && isOccluded(cameraPos, pos, occluders, displayTime)) return;
      this.candidateItems.push(item);
      if (visibility.pickable) this.markerItems.push(item);
    };

    this.candidateItems.length = 0;
    this.markerItems.length = 0;
    this.listItems.length = 0;
    for (const body of this.celestialMarkers.bodyPickables) append(body);
    for (const entity of this.roster.all()) {
      const pickable = objectPickableOf(entity);
      if (pickable) append(pickable);
    }
    for (const node of this.navTargetPresenter.pickables()) append(node);
    for (const apsis of this.planDisplay.apsisMarkers) append(apsis);
    for (const node of this.equatorNodes.pickables) append(node);
  }
}
