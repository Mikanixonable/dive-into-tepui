// マップ上の被選択物(MapPickable)の候補集合と、表示可否(MapVisibilityPolicy)を1フレーム分
// 組み立てる。「何が選べるか」だけを答え、選んだ結果どうするか(ヒットテスト・メニュー・
// プロパティウィンドウ)は map-context-actions.ts の MapContextActions が持つ。
import * as C from './const';
import { fmtDist, fmtSpeed } from './hud/utils';
import { celestialBodyName } from './hud/frame/frame-labels';
import { MapPickable } from './map-pickable';
import { focusTargetId } from './camera/focus-target';
import { EntityManager } from './simulation/entity-manager';
import { Ephemeris } from '../physics/ephemeris';
import { NavTarget } from './nav-target';
import type { FrameAnchorSource } from '../physics/frame';
import { CameraSystem } from './camera/camera-system';
import { PlanEditor } from './plan/plan-editor';
import type { ActivePlayerController } from './active-player-controller';
import { len, sub } from '../physics/vec3';
import { strongestAttractor } from '../physics/celestial-body';
import { isOccluded } from '../physics/occlusion';
import { apsisAltitudes } from '../physics/elements';
import { isPositionInFocusedSystem, NearbySystemTracker } from './celestial/body-visibility';
import { MapVisibilityPolicy } from './celestial/map-visibility';
import { MarkerManager } from './marker/marker-manager';
import type { DisplayWindow } from './display-window-manager';
import type { PerfCounts } from '../perf-meter';

type MutableMapPickable = { -readonly [K in keyof MapPickable]: MapPickable[K] };

export class MapPickables {
  private readonly candidateItems: MutableMapPickable[] = [];
  private readonly visibleItems: MutableMapPickable[] = [];
  private readonly itemRecords = new Map<string, MutableMapPickable>();
  private readonly activeRecordKeys = new Set<string>();
  private items: readonly MapPickable[] = this.candidateItems;
  private _lastSimTime = 0;
  private _visibilityPolicy: MapVisibilityPolicy | null = null;
  private readonly nearbyTracker = new NearbySystemTracker();

  // このフレームの被選択物候補。refresh の後に読む。
  get pickables(): readonly MapPickable[] { return this.items; }

  // このフレームの表示・選択可否。マップビュー以外では null。
  get visibilityPolicy(): MapVisibilityPolicy | null { return this._visibilityPolicy; }

  // 直近の refresh が受け取った simTime。ヒットテスト側が時刻依存の項目(通過時刻等)を
  // 同じ時刻で求め直すために読む。
  get lastSimTime(): number { return this._lastSimTime; }

  // 画面描画・マーカー同期完了後に、最新の可視性状態(ラベル・アイコン非表示)を
  // MapPickable.pickable へ反映する。
  syncVisibility(): void {
    const focusMarkers = this.cameraSystem.focusMarkers;
    const combatMarkers = this.markerManager.combatMarkers;
    for (const item of this.candidateItems) {
      if (item.kind === 'body') {
        item.pickable = focusMarkers.isBodyPickable(item.id);
      } else if (item.kind === 'player') {
        item.pickable = combatMarkers.isPickable(`player-${item.id}`);
      } else if (item.kind === 'ship') {
        item.pickable = combatMarkers.isPickable(`enemy-${item.id}`);
      } else if (item.kind === 'base') {
        item.pickable = combatMarkers.isPickable(`base-${item.id}`);
      }
    }
  }

  // 候補の供給元を参照として受け取る。
  constructor(
    private readonly activePlayers: ActivePlayerController,
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly markerManager: MarkerManager,
    private readonly frameAnchors: FrameAnchorSource,
  ) {}

  // マップの天体ラベル(表示のみ)と航法ターゲットの AN/DN を求め直したうえで、このフレームの
  // 候補列を組み直す(表示中の天体・ラグランジュ点 + 生存中の自艦・敵船・弾薬・基地 + AN/DN
  // アイコン + 近地点・遠地点アイコン)。天体側も表示と同じ MapVisibilityPolicy を通し、
  // 非表示にした対象を選べない状態にする。物理積分の後に呼ぶ: 積分前に組むと、同フレームで
  // sync されるメッシュと座標が1ステップずれる。
  refresh(displayWindow: DisplayWindow): void {
    if (!this.cameraSystem.overviewMode) {
      this._visibilityPolicy = null;
      return;
    }
    const { simTime, displayTime } = displayWindow;
    this._lastSimTime = simTime;
    const focusId = focusTargetId(this.cameraSystem.mapCamera.focus);
    // 候補の位置は表示時刻のものなので、遮蔽・系の判定もその時刻の天体位置で行う。
    // 現在時刻の配列は「いまの自艦の軌道」を読む項目だけが使う。
    const celestialBodies = this.ephemeris.celestialBodiesAt(simTime);
    const displayCelestialBodies = this.ephemeris.celestialBodiesAt(displayTime);
    const visibilityPolicy = new MapVisibilityPolicy(
      this.ephemeris.registry,
      this.cameraSystem.bodyClassToggles,
      focusId,
      this.nearbyTracker.membersAt(this.ephemeris.registry, this.cameraSystem.activeCameraPos, displayCelestialBodies),
    );
    this._visibilityPolicy = visibilityPolicy;
    this.cameraSystem.focusMarkers.update(
      displayTime, focusId, this.cameraSystem.bodyClassToggles,
      this.cameraSystem.activeCameraPos, visibilityPolicy,
    );
    this.navTarget.update(this.activePlayers.current, this.entities, this.ephemeris, displayWindow, this.frameAnchors);

    // 船の位置は表示時刻の displayState — 機体メッシュや敵マーカーと同じ未来ゴースト位置に揃える。
    this.candidateItems.length = 0;
    this.visibleItems.length = 0;
    this.activeRecordKeys.clear();
    for (const item of this.cameraSystem.focusMarkers.bodyPickables(displayTime, visibilityPolicy)) {
      this.appendPickable(item);
    }
    for (const ship of this.entities.players) {
      const vPlayer = visibilityPolicy.entity('player', ship === this.activePlayers.current);
      if (!vPlayer.pickable) continue;
      const pos = ship.displayState(displayTime)?.r;
      if (pos) {
        const center = strongestAttractor(ship.state.r, celestialBodies);
        const el = ship.orbitalElementsAround(center);
        const pe = el ? fmtDist(apsisAltitudes(el).pe) : '—';
        this.addCandidate(
          ship.id, ship.name, pos, 'player',
          `HP ${Math.round(ship.hp)}/${Math.round(ship.maxHp)} · PE ${pe}`,
          ship === this.activePlayers.current ? -100 : 0,
          undefined, vPlayer.label,
        );
      }
    }
    for (const enemy of this.entities.enemies) {
      const vShip = visibilityPolicy.entity('ship');
      if (!enemy.alive || !vShip.pickable) continue;
      const pos = enemy.displayState(displayTime)?.r;
      if (pos) this.addCandidate(enemy.id, enemy.name, pos, 'ship', undefined, undefined, undefined, vShip.label);
    }
    for (const ammoPickup of this.entities.ammoPickups) {
      const vAmmo = visibilityPolicy.entity('ammo');
      if (!ammoPickup.alive || !vAmmo.pickable) continue;
      const pos = ammoPickup.displayState(displayTime)?.r;
      if (pos) this.addCandidate(ammoPickup.id, ammoPickup.name, pos, 'ammo', undefined, undefined, undefined, vAmmo.label);
    }
    for (const base of this.entities.bases) {
      const vBase = visibilityPolicy.entity('base');
      if (!base.alive || !vBase.pickable) continue;
      const pos = base.displayState(displayTime)?.r;
      if (pos) this.addCandidate(
        base.id, base.name, pos, 'base', `格納 ${base.baseState.dockedVessels.length} 艇`,
        undefined, undefined, vBase.label,
      );
    }
    for (const item of this.navTarget.mapPickables()) this.appendPickable(item);
    for (const item of this.editor.planDisplay.apsisMarkers) this.appendPickable(item);
    for (const e of this.entities.all()) {
      if (e.equatorNodes) for (const item of e.equatorNodes.mapPickables()) this.appendPickable(item);
    }

    // 太陽系順の並べ替え基準。恒星の無いレジストリでは undefined のまま(呼び出し側が
    // 自機距離へ委譲する)。
    const starPos = this.ephemeris.starId !== null ? this.ephemeris.positionOf(this.ephemeris.starId, displayTime) : null;
    if (starPos) for (const item of this.candidateItems) item.distanceFromStar = len(sub(item.pos, starPos));

    // 自艦からの距離は一覧の実用順と補助情報にだけ使う。軌道予測はここで増やさない。
    const viewer = this.activePlayers.current?.state;
    if (viewer) for (const item of this.candidateItems) {
      const d = len(sub(item.pos, viewer.r));
      // 相対速度は対の速度を持つ敵艦にだけ意味がある。
      const status = item.kind === 'ship' ? `${d < 2e5 ? '接近' : '距離'} ${fmtDist(d)} · ${fmtSpeed(len(sub(this.entities.findEnemy(item.id)?.state.v ?? viewer.v, viewer.v)))}` : item.kind === 'ammo' ? `${fmtDist(d)}${d <= C.AMMO_PICKUP_RADIUS ? ' · 回収可能' : ''}` : item.kind === 'base' ? `${fmtDist(d)} · ドック候補` : item.kind === 'body' ? `${fmtDist(d)} · ${celestialBodyName(strongestAttractor(item.pos, displayCelestialBodies).id)}` : item.detail;
      item.detail = status;
      item.distance = d;
      // 所属系は天体以外にしか意味を持たない(天体は系そのものを表す行として常に一覧へ出す)。
      // 判定は最強天体から親を辿るぶん高価なので、読まれない天体候補では省く。
      item.inFocusedSystem = item.kind === 'body'
        ? undefined
        : isPositionInFocusedSystem(this.ephemeris.registry, focusId, item.pos, displayCelestialBodies);
    }

    // マップビューでは player だけ、フォーカス天体の系に所属するかで候補を絞る。表示側と
    // 同じ判定なので、地球の裏側の player は表示・選択でき、土星系の player はどちらにも
    // 現れない。天体(body)は MapVisibilityPolicy が選んだ候補を維持する(カメラ遮蔽で
    // 一覧や被選択候補から除くと、小衛星ナマカのように公転・カメラ移動に伴い
    // 一覧の行が明滅してしまうため)。その他の候補(船・弾薬・基地・軌道点)は天体遮蔽で
    // ピック対象から除く。
    for (const item of this.candidateItems) {
      const included = item.kind === 'player'
        ? item.inFocusedSystem ?? isPositionInFocusedSystem(this.ephemeris.registry, focusId, item.pos, displayCelestialBodies)
        : item.kind === 'body'
          ? true
          : !isOccluded(this.cameraSystem.activeCameraPos, item.pos, displayCelestialBodies);
      if (included) this.visibleItems.push(item);
    }
    this.items = this.visibleItems;
    for (const key of this.itemRecords.keys()) {
      if (!this.activeRecordKeys.has(key)) this.itemRecords.delete(key);
    }
  }

  private appendPickable(item: MapPickable): void {
    this.addCandidate(
      item.id, item.name, item.pos, item.kind, item.detail, item.priority,
      item.time, item.pickable, item.ownerName,
    );
  }

  private addCandidate(
    id: string, name: string, pos: MapPickable['pos'], kind: MapPickable['kind'],
    detail?: string, priority?: number, time?: number, pickable?: boolean,
    ownerName?: string,
  ): void {
    const key = `${kind}:${id}`;
    this.activeRecordKeys.add(key);
    let item = this.itemRecords.get(key);
    if (item === undefined) {
      item = { id, name, pos, kind };
      this.itemRecords.set(key, item);
    } else {
      item.id = id;
      item.name = name;
      item.pos = pos;
      item.kind = kind;
    }
    // 候補が同じ id で別種別へ変わる場合や、前フレームだけ持っていた補助値が残らない
    // ように、候補へ追加するたびに全ての派生フィールドを上書きする。
    item.detail = detail;
    item.distance = undefined;
    item.distanceFromStar = undefined;
    item.priority = priority;
    item.time = time;
    item.inFocusedSystem = undefined;
    item.pickable = pickable;
    item.ownerName = ownerName;
    this.candidateItems.push(item);
  }

  // 負荷確認ウィンドウが読む、マップ視点かどうかとその候補列/ラベル数。
  perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    const overviewMode = this.cameraSystem.overviewMode;
    return {
      mapMode: overviewMode,
      mapItems: overviewMode ? this.items.length : 0,
      mapLabels: overviewMode ? this.cameraSystem.focusMarkers.shownLabelCount : 0,
    };
  }
}
