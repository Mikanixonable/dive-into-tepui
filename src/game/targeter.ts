// 戦闘ターゲットの選定と、戦闘対象・弾薬・燃料の画面マーカーの同期。ターゲットに紐づく
// 表示(方位マーカー・見越し点・的通過マーク)もここが受け持つ。
import { add, addScaled, dot, len, lenSq, norm, scale, sub, v3, Vec3 } from '../math/vec3';
import { Enemy } from './dynamic/dynamic-entity/enemy';
import { isBullet } from './dynamic/dynamic-entity/bullet';
import { bulletReactionOf } from './dynamic/dynamic-entity/bullet-reaction';
import { isAmmoPickup, isRcsFuelPickup } from './dynamic/dynamic-entity/pickup';
import { ProteinEnemy } from './dynamic/dynamic-entity/protein-enemy';
import type { EntityRoster } from './dynamic/entity-roster';
import { Player } from './player/player';
import { isCombatTarget, type CombatTarget } from './dynamic/dynamic-entity/combat-target';
import { Input } from '../input/input';
import type { CameraFrame } from '../render/camera/camera-frame';
import type { Viewport } from '../render/viewport';
import { GroupedMarkers, withTargetRole, type GroupedMarkerItem } from './marker/grouped-markers';
import { LeadMarkers } from './marker/lead-markers';
import type { ActiveCelestialLabel } from './marker/celestial-markers';
import { MARKER_PRIORITY } from './marker/marker-priority';
import { directionPlacement, pointPlacement } from './marker/marker-placement';
import type { MarkerDeclaration } from '../marker/marker-declaration';
import type { MarkerDevice } from '../marker/marker-device';
import type { MarkerSink } from '../marker/marker-sink';
import { DIRECTION_GLYPH, COLOR_MARKER_ENEMY } from './marker/marker-identity';
import { pickNearest } from './pickable/object-pickable';
import { fmtMarkerDist } from '../hud/utils';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { MapVisibility, MapVisibilityPolicy } from './map/visibility-policy';
import { mapPlanetFadeOpacity, nearestPlanetDistance } from './celestial/planet-distance';
import { isOccluded } from '../physics/occlusion';
import type { NavTarget } from './nav-target';
import type { CelestialBody } from '../physics/celestial-body';
import type { OrbitingObject } from './dynamic/dynamic-entity/orbiting-object';
import type { ProjectFn } from '../math/projection';

// ターゲット位置に自機側を向けて置いた仮想標的面(的)を弾が通過した点のマーカー。
const BOARD_MARK_LIFETIME = 5.0; // 表示時間 [s]
const MAX_BOARD_MARKS = 1; // 同時に出す通過点の数。増やすと照準の目安として紛らわしい
const BOARD_RADIUS = 4000; // 的の半径 [m](これ以遠の通過は記録しない)

// マップ上の弾薬・燃料マーカーが薄れ始める/消える、自機からの距離 [m]。
const MAP_AMMO_FADE_START = 5e7;
const MAP_AMMO_FADE_END = 1e8;

const PROTEIN_SITE_MARKER_RANGE = 3000; // タンパク質敵の機能部位マーカーを表示する距離上限 [m]

// マップ上の弾薬・燃料マーカーの不透明度。MAP_AMMO_FADE_START から薄れ、MAP_AMMO_FADE_END で消える。
function ammoFadeOpacity(distance: number): number {
  return Math.max(0, Math.min(1, (MAP_AMMO_FADE_END - distance) / (MAP_AMMO_FADE_END - MAP_AMMO_FADE_START)));
}

export class Targeter {
  // 毎フレーム組み直す作業用配列。
  private readonly aliveScratch: CombatTarget[] = [];
  private readonly markerItemScratch: GroupedMarkerItem[] = [];
  // 照準に属するマーカー(的通過マーク・ターゲット方向・タンパク質の機能部位)の宣言。
  private readonly declarations: MarkerDeclaration[] = [];
  private readonly aimGroup: MarkerSink;

  // 画面上で近接するものをまとめる戦闘対象のマーカー集合。
  public readonly combatMarkers: GroupedMarkers;
  // 自機と敵の両方から解く見越し点のマーカー。
  private readonly leadMarkers: LeadMarkers;

  // 標的面(自機の方を向いた仮想の的)を弾が通過した点。的に貼り付いて見えるよう、
  // ターゲット相対のオフセットで持つ。
  private boardMarks: { off: Vec3; age: number; }[] = [];

  // 照準・戦闘対象・見越し点の3つの群を装置から確保する。畳むのは dispose。
  public constructor(
    markers: MarkerDevice,
    private readonly navTarget: NavTarget, private readonly roster: EntityRoster,
    private readonly celestialBodies: readonly CelestialBody[],
  ) {
    this.aimGroup = markers.createGroup();
    this.combatMarkers = new GroupedMarkers(markers.createGroup());
    this.leadMarkers = new LeadMarkers(markers.createGroup());
  }

  // 所有するマーカー群を取り除く。
  public dispose(): void {
    this.aimGroup.dispose();
    this.combatMarkers.dispose();
    this.leadMarkers.dispose();
  }

  // 航法ターゲットを生存中の敵・自艦・基地として解決したもの。戦闘対象になれない対象
  // (天体・ラグランジュ点)や撃破済みなら null。
  public get aliveTarget(): CombatTarget | null {
    return this.navTarget.resolveCombatTarget(this.roster);
  }

  // Tキーで、照準中心にもっとも近い対象をターゲットにする。操作中の艦自身は候補から外す。
  public handleTargetSelectKey(input: Input, viewer: OrbitingObject, project: ProjectFn, viewport: Viewport): void {
    if (!input.takeKey(K.targetSelect)) return;
    const targets = this.roster.all()
      .filter(isCombatTarget).filter((e) => e.motion.alive && e !== viewer);
    this.navTarget.setCombatTarget(pickNearest(
      targets, (target) => project(target.motion.state.r),
      viewport.width * 0.5, viewport.height * 0.5, Infinity));
  }

  // 発射弾が標的面を自機側から通過した点をターゲット相対で記録し、既存の記録の寿命を進める。
  public updateBoardMarks(dt: number, viewer: OrbitingObject | null): void {
    const target = this.aliveTarget;
    if (!viewer || !target) {
      this.boardMarks.length = 0;
      return;
    }
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < BOARD_MARK_LIFETIME;
    });
    const n = norm(sub(target.motion.state.r, viewer.motion.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    // 各弾について、前フレームと今フレームの位置が的面をどちら向きに跨いだかを見る。
    for (const b of this.roster.all().filter(isBullet)) {
      const bullet = bulletReactionOf(b.motion);
      if (bullet?.type !== 'normal' || !b.motion.alive) continue; // 的通過マーカーは通常弾のみ対象
      const prevR = b.motion.prevState.r;
      const d0 = dot(sub(prevR, target.motion.state.r), n);
      const d1 = dot(sub(b.motion.state.r, target.motion.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(prevR, sub(b.motion.state.r, prevR), t);
      const off = sub(pos, target.motion.state.r);
      if (lenSq(off) > BOARD_RADIUS * BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > MAX_BOARD_MARKS) this.boardMarks.shift();
    }
  }

  // ターゲットに紐づく表示物(的通過マーク・方位マーカー)と、全戦闘対象のマーカー集合を
  // まとめて更新する。celestialLabels は今フレームに描かれた天体ラベルで、マップでの重なりを
  // 避けるために読む。
  public sync(
    viewer: OrbitingObject | null, camera: CameraFrame, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null, celestialLabels: readonly ActiveCelestialLabel[],
    nowMs: number,
  ): void {
    const project = camera.project;
    this.declarations.length = 0;
    this.pushBoardMarkers(project);
    this.pushTargetDirMarkers(viewer, camera.mode === 'map', project);
    this.syncTargetMarkers(viewer, displayTime, camera, visibilityPolicy, celestialLabels, nowMs);
    this.aimGroup.sync(this.declarations, nowMs);
  }

  // 全戦闘対象のマーカー集合(ターゲットの役割を含む)と LEAD マーカーを同期する。位置は
  // 機体メッシュと同じ stateAt — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
  private syncTargetMarkers(
    viewer: OrbitingObject | null, displayTime: number, camera: CameraFrame,
    visibilityPolicy: MapVisibilityPolicy | null, celestialLabels: readonly ActiveCelestialLabel[],
    nowMs: number,
  ): void {
    // 戦闘対象(マップでは操作対象自身を含む)のマーカー。
    const targets = this.roster.all().filter(isCombatTarget);
    const ammoPickups = this.roster.all().filter(isAmmoPickup);
    const fuelPickups = this.roster.all().filter(isRcsFuelPickup);
    const view = camera.mode;
    const mapView = view === 'map';
    const project = camera.project;
    const viewerPos = viewer?.motion.state.r ?? v3();
    this.aliveScratch.length = 0;
    this.markerItemScratch.length = 0;
    for (const tgt of targets) {
      if (!tgt.motion.alive) continue;
      this.aliveScratch.push(tgt);
      const ds = tgt.motion.stateAt(displayTime);
      if (!ds) continue;
      const visibility = visibilityPolicy?.entity(tgt.mapKind, tgt === viewer);
      if (visibility && !visibility.pickable) continue;
      // 戦闘ビューのカメラ直下にいる操作艦は、マーカーを重ねると視界を潰す。
      if (!mapView && tgt === viewer) continue;
      const item = tgt.markerItem(viewerPos, ds.r, ds.v, view, tgt === viewer);
      const mapOccluded = mapView && isOccluded(camera.position, ds.r, this.celestialBodies, displayTime);
      const mapOpacity = mapOccluded
        ? 0
        : tgt instanceof Enemy && mapView
          ? mapPlanetFadeOpacity(nearestPlanetDistance(ds.r, this.celestialBodies, displayTime))
          : 1;
      this.pushMarkerItem(
        tgt === this.aliveTarget ? withTargetRole(item) : item,
        viewerPos, mapView, visibility, mapOpacity, mapOccluded);
    }
    // 部位マーカーは死んだ個体まで辿る — 生存個体だけだと撃破直後の部位マーカーが残る。
    for (const tgt of targets) {
      if (!(tgt instanceof ProteinEnemy)) continue;
      const ds = tgt.motion.alive ? tgt.motion.stateAt(displayTime) : null;
      this.pushProteinSiteMarkers(tgt, ds?.r ?? null, viewerPos, mapView, project, camera.position);
    }
    // 弾薬・燃料のマーカー。マップでは自機から遠いほど薄れる。
    for (const ammo of ammoPickups) {
      if (!ammo.motion.alive) continue;
      const visibility = visibilityPolicy?.entity('ammo');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = mapView && isOccluded(
        camera.position, ammo.motion.state.r, this.celestialBodies, displayTime,
      );
      const mapOpacity = mapOccluded
        ? 0
        : mapView ? ammoFadeOpacity(len(sub(ammo.motion.state.r, viewerPos))) : 1;
      this.pushMarkerItem(ammo.markerItem(), viewerPos, mapView, visibility, mapOpacity, mapOccluded);
    }
    for (const fuel of fuelPickups) {
      if (!fuel.motion.alive) continue;
      const visibility = visibilityPolicy?.entity('fuel');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = mapView && isOccluded(
        camera.position, fuel.motion.state.r, this.celestialBodies, displayTime,
      );
      const mapOpacity = mapOccluded
        ? 0
        : mapView ? ammoFadeOpacity(len(sub(fuel.motion.state.r, viewerPos))) : 1;
      this.pushMarkerItem(fuel.markerItem(), viewerPos, mapView, visibility, mapOpacity, mapOccluded);
    }
    this.combatMarkers.sync(
      this.markerItemScratch, camera, nowMs, celestialLabels, this.celestialBodies,
    );
    // 見越し点は弾速から解くので、砲を積んでいる艦を操作している間だけ出る。
    this.leadMarkers.sync(
      viewer instanceof Player ? viewer : null, this.aliveScratch, this.aliveTarget, view, project, nowMs);
  }

  // markerItemScratch へ、自機からの距離ラベル・可視性設定(アイコン/名前の個別トグル)・
  // マップ上のフェード/遮蔽を反映して積む。マップビューでは距離ラベルを出さない。
  private pushMarkerItem(
    item: GroupedMarkerItem, viewerPos: Vec3, mapView: boolean,
    visibility: MapVisibility | undefined, opacity: number, occluded: boolean,
  ): void {
    const detail = mapView ? '' : fmtMarkerDist(len(sub(item.pos, viewerPos)));
    this.markerItemScratch.push(visibility ? {
      ...item,
      sym: visibility.icon ? item.sym : '',
      name: visibility.label ? item.name : '',
      detail: visibility.label ? detail : '',
      opacity,
      occluded,
    } : { ...item, detail, opacity, occluded });
  }

  // タンパク質敵が自機から PROTEIN_SITE_MARKER_RANGE 以内にある間、通常の敵マーカーへ加えて
  // 各機能部位の HP・名称マーカーを表示する。
  private pushProteinSiteMarkers(
    enemy: ProteinEnemy, displayPos: Vec3 | null, viewerPos: Vec3, mapView: boolean, project: ProjectFn, cameraPos: Vec3,
  ): void {
    // 部位の HP は Entity の読み取り値、変形済みアンカーは View から同じ呼び出しで合成する。
    const inRange = !mapView && displayPos !== null && len(sub(displayPos, viewerPos)) <= PROTEIN_SITE_MARKER_RANGE;
    const sites = enemy.view.siteMarkers(
      displayPos ?? enemy.motion.state.r, enemy.motion.att.q, enemy.combatReadout.sites,
    );
    // 範囲外でも全部位を宣言し、前フレームのマーカーを確実に伏せる。
    for (const site of sites) {
      const base = {
        id: `psite-${enemy.id}-${site.id}`, cls: 'mk-protein-site', sym: '●',
        priority: MARKER_PRIORITY.PROTEIN_SITE,
      };
      if (!inRange) { this.declarations.push({ ...base, x: 0, y: 0, front: false }); continue; }
      this.declarations.push({
        ...base,
        ...pointPlacement(site.worldPos, project, cameraPos),
        label: `${site.abbreviation} ${Math.max(0, Math.round(site.hp))}/${site.maxHp}`,
        color: site.disabled ? 'var(--text-dim)' : site.attackable ? COLOR_MARKER_ENEMY : undefined,
      });
    }
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として宣言する。
  private pushBoardMarkers(project: ProjectFn): void {
    const target = this.aliveTarget;
    for (let i = 0; i < MAX_BOARD_MARKS; i++) {
      const base = {
        id: `bh${i}`, cls: 'mk-boardpass', sym: '✦',
        priority: MARKER_PRIORITY.ORBITAL_NODE, iconHidable: false,
      };
      const m = this.boardMarks[i];
      if (!m || !target) {
        this.declarations.push({ ...base, x: 0, y: 0, front: false });
        continue;
      }
      // 寿命の残りをそのまま濃さにする。
      const fade = 1 - m.age / BOARD_MARK_LIFETIME;
      this.declarations.push({
        ...base,
        ...pointPlacement(add(target.motion.state.r, m.off), project),
        opacity: 0.25 + 0.75 * fade,
      });
    }
  }

  // ターゲットとその反対方向を指す方向マーカーを、自機位置を原点に宣言する。マップビューでは伏せる。
  private pushTargetDirMarkers(viewer: OrbitingObject | null, mapView: boolean, project: ProjectFn): void {
    const tgt = this.aliveTarget;
    const dirs = [
      { id: 'tgtdir', sym: DIRECTION_GLYPH.target, sign: 1 },
      { id: 'atgdir', sym: DIRECTION_GLYPH.antiTarget, sign: -1 },
    ] as const;
    // ターゲット方向と、その反対方向の2本。
    const tgtDir = mapView || !tgt || !viewer
      ? null : norm(sub(tgt.motion.state.r, viewer.motion.state.r));
    for (const dir of dirs) {
      const base = {
        id: dir.id, cls: 'mk-tgtdir', sym: dir.sym,
        priority: MARKER_PRIORITY.NONE, iconHidable: false,
      };
      if (tgtDir === null || !viewer) this.declarations.push({ ...base, x: 0, y: 0, front: false });
      else {
        this.declarations.push({
          ...base,
          ...directionPlacement(viewer.motion.state.r, scale(tgtDir, dir.sign), project),
        });
      }
    }
  }
}
