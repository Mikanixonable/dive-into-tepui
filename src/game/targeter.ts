import { add, addScaled, dot, len, lenSq, norm, scale, sub, v3, Vec3 } from '../math/vec3';
import { Enemy } from './dynamic/dynamic-entity/enemy';
import { ProteinEnemy } from './dynamic/dynamic-entity/protein-enemy';
import type { Base } from './dynamic/dynamic-entity/base';
import type { DynamicSystem } from './dynamic/dynamic-system';
import { Player } from './player/player';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { Input } from '../input/input';
import { CameraSystem, ProjectFn } from './camera/camera-system';
import type { GroupedMarkerItem } from './marker/grouped-markers';
import type { CelestialMarkers } from './marker/celestial-markers';
import { MARKER_PRIORITY } from './marker/crowding';
import type { MarkerManager } from './marker/marker-manager';
import { DIRECTION_GLYPH, COLOR_MARKER_ENEMY } from './marker/marker-identity';
import { pickNearest } from './pickable/object-pickable';
import type { CelestialSystem } from './celestial/celestial-system';
import type { FrameAnchorSource } from '../physics/frame';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { MapVisibility, MapVisibilityPolicy } from './map/visibility-policy';
import { mapPlanetFadeOpacity, nearestPlanetDistance } from './celestial/planet-distance';
import { isOccluded } from '../physics/occlusion';
import type { NavTarget } from './nav-target';

// ターゲット位置に自機側を向けて置いた仮想標的面(的)を弾が通過した点のマーカー。
const BOARD_MARK_LIFETIME = 5.0; // 表示時間 [s]
const MAX_BOARD_MARKS = 1; // 同時に出す通過点の数。増やすと照準の目安として紛らわしい
const BOARD_RADIUS = 4000; // 的の半径 [m](これ以遠の通過は記録しない)

const MAP_AMMO_FADE_START = 5e7;
const MAP_AMMO_FADE_END = 1e8;

const PROTEIN_SITE_MARKER_RANGE = 3000; // タンパク質敵の機能部位マーカーを表示する距離上限 [m]

export type CombatTarget = Enemy | Player | Base;

// マーカー上での対象の役割。ターゲットは色と字形が変わる。
export type MarkerRole = 'none' | 'primary';

// マップ上の弾薬・燃料マーカーの不透明度。MAP_AMMO_FADE_START から薄れ、MAP_AMMO_FADE_END で消える。
function ammoFadeOpacity(distance: number): number {
  return Math.max(0, Math.min(1, (MAP_AMMO_FADE_END - distance) / (MAP_AMMO_FADE_END - MAP_AMMO_FADE_START)));
}

export class Targeter {
  // 毎フレーム組み直す作業用配列。
  private readonly aliveScratch: CombatTarget[] = [];
  private readonly markerItemScratch: GroupedMarkerItem[] = [];

  // 標的面(自機の方を向いた仮想の的)を弾が通過した点。的に貼り付いて見えるよう、
  // ターゲット相対のオフセットで持つ。
  private boardMarks: { off: Vec3; age: number; }[] = [];

  constructor(
    private readonly markerManager: MarkerManager,
    private readonly navTarget: NavTarget, private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly celestialMarkers: CelestialMarkers,
  ) {}

  // 航法ターゲットを生存中の敵・自艦・基地として解決したもの。戦闘対象になれない対象
  // (天体・ラグランジュ点)や撃破済みなら null。
  get aliveTarget(): CombatTarget | null {
    return this.navTarget.resolveCombatTarget(this.entities);
  }

  // Tキーで、照準中心にもっとも近い対象をターゲットにする。
  handleTargetSelectKey(input: Input, targets: CombatTarget[], project: ProjectFn): void {
    if (!input.takeKey(K.targetSelect)) return;
    this.navTarget.setCombatTarget(pickNearest(
      targets.filter((e) => e.alive), (target) => project(target.state.r),
      window.innerWidth * 0.5, window.innerHeight * 0.5, Infinity));
  }

  // 戦闘ターゲットの赤道交点を、この表示時刻で解き直す。全件を伏せた
  // (DynamicSystem.clearEquatorNodes)後の update 位相で呼ぶ。
  updateEquatorNodes(
    displayTime: number, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
  ): void {
    this.aliveTarget?.ensureEquatorNodes(this.markerManager)
      .updateOnEllipse(displayTime, celestialSystem, frameAnchors);
  }

  // 発射弾が標的面を自機側から通過した点をターゲット相対で記録し、既存の記録の寿命を進める。
  updateBoardMarks(dt: number, viewer: Controllable | null): void {
    const target = this.aliveTarget;
    if (!viewer || !target) {
      this.boardMarks.length = 0;
      return;
    }
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < BOARD_MARK_LIFETIME;
    });
    const n = norm(sub(target.state.r, viewer.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    // 各弾について、前フレームと今フレームの位置が的面をどちら向きに跨いだかを見る。
    for (const b of this.entities.bullets) {
      if (b.type !== 'normal' || !b.alive) continue; // 的通過マーカーは通常弾のみ対象
      const prevR = b.prevState.r;
      const d0 = dot(sub(prevR, target.state.r), n);
      const d1 = dot(sub(b.state.r, target.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(prevR, sub(b.state.r, prevR), t);
      const off = sub(pos, target.state.r);
      if (lenSq(off) > BOARD_RADIUS * BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > MAX_BOARD_MARKS) this.boardMarks.shift();
    }
  }

  // ターゲットに紐づく表示物(的通過マーク・方位マーカー)と、全戦闘対象のマーカー集合を
  // まとめて更新する。
  sync(
    viewer: Controllable | null, cameraSystem: CameraSystem, displayTime: number, simTime: number,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const project = cameraSystem.activeCameraProjection;
    this.syncBoardMarkers(project);
    this.syncTargetDirMarkers(viewer, cameraSystem.view === 'map', project);
    this.syncTargetMarkers(viewer, displayTime, simTime, cameraSystem, visibilityPolicy);
  }

  // 全戦闘対象のマーカー集合(ターゲットの役割を含む)と LEAD マーカーを同期する。位置は
  // 機体メッシュと同じ stateAt — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
  private syncTargetMarkers(
    viewer: Controllable | null, displayTime: number, simTime: number, cameraSystem: CameraSystem,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    // マーカーは操作対象自身も他の船と同列に扱うので、ターゲット選定用(自分自身は除外)とは
    // 別に、除外なしの一覧を使う。
    const targets = this.entities.getCombatTargets(null);
    const ammoPickups = this.entities.ammoPickups;
    const fuelPickups = this.entities.rcsFuelPickups;
    const celestialBodies = this.celestialSystem.celestialMotions;
    const view = cameraSystem.view;
    const mapView = view === 'map';
    const project = cameraSystem.activeCameraProjection;
    const screenScale = cameraSystem.activeCameraScale;
    const viewerPos = viewer?.state.r ?? v3();
    this.aliveScratch.length = 0;
    this.markerItemScratch.length = 0;
    for (const tgt of targets) {
      if (!tgt.alive) continue;
      this.aliveScratch.push(tgt);
      const ds = tgt.stateAt(displayTime);
      if (!ds) continue;
      const visibility = visibilityPolicy?.entity(tgt.mapKind, tgt === viewer);
      if (visibility && !visibility.pickable) continue;
      // 戦闘ビューのカメラ直下にいる操作艦は、マーカーを重ねると視界を潰す。
      if (!mapView && tgt === viewer) continue;
      const role: MarkerRole = tgt === this.aliveTarget ? 'primary' : 'none';
      const item = tgt instanceof Player
        ? tgt.markerItem(role, viewerPos, ds.r, ds.v, view, tgt === viewer)
        : tgt.markerItem(role, viewerPos, ds.r, ds.v, view);
      const mapOccluded = mapView && isOccluded(cameraSystem.activeCameraPos, ds.r, celestialBodies, displayTime);
      const mapOpacity = mapOccluded
        ? 0
        : tgt instanceof Enemy && mapView
          ? mapPlanetFadeOpacity(nearestPlanetDistance(ds.r, celestialBodies, displayTime))
          : 1;
      this.pushMarkerItem(item, visibility, mapOpacity, mapOccluded);
    }
    // 部位マーカーは死んだ個体まで辿って確定する。上のループは生存個体しか通らないので、
    // ここで畳まないと撃破直後の部位マーカーが残る。
    for (const tgt of targets) {
      if (!(tgt instanceof ProteinEnemy)) continue;
      const ds = tgt.alive ? tgt.stateAt(displayTime) : null;
      this.syncProteinSiteMarkers(tgt, ds?.r ?? null, viewerPos, mapView, project, cameraSystem.activeCameraPos);
    }
    for (const ammo of ammoPickups) {
      if (!ammo.alive) continue;
      const visibility = visibilityPolicy?.entity('ammo');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = mapView && isOccluded(cameraSystem.activeCameraPos, ammo.state.r, celestialBodies, displayTime);
      const mapOpacity = mapOccluded ? 0 : mapView ? ammoFadeOpacity(len(sub(ammo.state.r, viewerPos))) : 1;
      this.pushMarkerItem(ammo.markerItem(viewerPos, view), visibility, mapOpacity, mapOccluded);
    }
    for (const fuel of fuelPickups) {
      if (!fuel.alive) continue;
      const visibility = visibilityPolicy?.entity('fuel');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = mapView && isOccluded(cameraSystem.activeCameraPos, fuel.state.r, celestialBodies, displayTime);
      const mapOpacity = mapOccluded ? 0 : mapView ? ammoFadeOpacity(len(sub(fuel.state.r, viewerPos))) : 1;
      this.pushMarkerItem(fuel.markerItem(viewerPos, view), visibility, mapOpacity, mapOccluded);
    }
    const celestialLabels = mapView ? this.celestialMarkers.activeLabels : [];
    this.markerManager.combatMarkers.sync(
      this.markerItemScratch, project, view, screenScale, celestialLabels, celestialBodies,
      cameraSystem.activeCameraPos,
    );
    // 見越し点は弾速から解くので、砲を積んでいる艦を操作している間だけ出る。
    if (viewer instanceof Player) {
      this.markerManager.leadMarkers.sync(viewer, this.aliveScratch, this.aliveTarget, simTime, view, project);
    }
  }

  // markerItemScratch へ、可視性設定(アイコン/名前の個別トグル)とマップ上のフェード/遮蔽を反映して積む。
  private pushMarkerItem(
    item: GroupedMarkerItem, visibility: MapVisibility | undefined, opacity: number, occluded: boolean,
  ): void {
    this.markerItemScratch.push(visibility ? {
      ...item,
      sym: visibility.icon ? item.sym : '',
      name: visibility.label ? item.name : '',
      detail: visibility.label ? item.detail : '',
      opacity,
      occluded,
    } : { ...item, opacity, occluded });
  }

  // タンパク質敵が自機から PROTEIN_SITE_MARKER_RANGE 以内にある間、通常の敵マーカーへ加えて
  // 各機能部位の HP・名称マーカーを表示する。
  private syncProteinSiteMarkers(
    enemy: ProteinEnemy, displayPos: Vec3 | null, viewerPos: Vec3, mapView: boolean, project: ProjectFn, cameraPos: Vec3,
  ): void {
    const inRange = !mapView && displayPos !== null && len(sub(displayPos, viewerPos)) <= PROTEIN_SITE_MARKER_RANGE;
    const sites = enemy.siteMarkers(displayPos ?? enemy.state.r);
    for (const site of sites) {
      const key = `psite-${enemy.id}-${site.id}`;
      if (!inRange) { this.markerManager.hide(key); continue; }
      const label = `${site.abbreviation} ${Math.max(0, Math.round(site.hp))}/${site.maxHp}`;
      const color = site.disabled ? 'var(--text-dim)' : site.attackable ? COLOR_MARKER_ENEMY : undefined;
      this.markerManager.setPosition(key, 'mk-protein-site', '●', site.worldPos, project, label, 1, color, undefined, false, false, MARKER_PRIORITY.PROTEIN_SITE, cameraPos);
    }
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  private syncBoardMarkers(project: ProjectFn): void {
    const target = this.aliveTarget;
    for (let i = 0; i < MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !target) {
        this.markerManager.hide(key);
        continue;
      }
      // 寿命の残りをそのまま濃さにする。
      const fade = 1 - m.age / BOARD_MARK_LIFETIME;
      this.markerManager.setPosition(key, 'mk-boardpass', '✦', add(target.state.r, m.off), project, '', 0.25 + 0.75 * fade);
    }
  }

  // ターゲットとその反対方向を指す方向マーカーを、自機位置を原点に置く。マップビューでは伏せる。
  private syncTargetDirMarkers(viewer: Controllable | null, mapView: boolean, project: ProjectFn): void {
    const tgt = this.aliveTarget;
    if (mapView || !tgt || !viewer) {
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
      return;
    }
    const tgtDir = norm(sub(tgt.state.r, viewer.state.r));
    this.markerManager.setDirection('tgtdir', 'mk-tgtdir', DIRECTION_GLYPH.target, viewer.state.r, tgtDir, project);
    this.markerManager.setDirection('atgdir', 'mk-tgtdir', DIRECTION_GLYPH.antiTarget, viewer.state.r, scale(tgtDir, -1), project);
  }
}
