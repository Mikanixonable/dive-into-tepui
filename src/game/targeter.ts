// 戦闘ターゲットの選定と、戦闘対象・弾薬・燃料の画面マーカーの同期。ターゲットに紐づく
// 表示(方位マーカー・見越し点・的通過マーク)もここが受け持つ。
import type { Vec3 } from '../math/vec3';
import { add, len, norm, scale, sub } from '../math/vec3';
import { Enemy } from './dynamic/dynamic-entity/enemy';
import { isAmmoPickup, isRcsFuelPickup } from './dynamic/dynamic-entity/pickup';
import { ProteinEnemy } from './dynamic/dynamic-entity/protein-enemy';
import type { EntityRoster } from './dynamic/entity-roster';
import { ModularShip } from './ship/modular-ship';
import { aliveCombatTarget, isCombatTarget, type CombatTarget } from './dynamic/dynamic-entity/combat-target';
import type { CameraFrame } from '../render/camera/camera-frame';
import type { Viewport } from '../render/viewport';
import { GroupedMarkers, withTargetRole, type GroupedMarkerItem } from './marker/grouped-markers';
import type { ThemePalette } from '../theme';
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
import type { MapVisibility, MapVisibilityPolicy } from './map/visibility-policy';
import { mapPlanetFadeOpacity, nearestPlanetDistance } from './celestial/planet-distance';
import { isOccluded } from '../physics/occlusion';
import type { CelestialBody } from '../physics/celestial-body';
import type { OrbitingObject } from './dynamic/dynamic-entity/orbiting-object';
import type { ProjectFn } from '../math/projection';
import type { RunEvent } from './run-events';
import type { NavTargetSource } from './viewer/nav-target-selection';
import type { NavTargetCommands } from './viewer/nav-target-commands';
import type { ViewMode } from './view/view-mode';

// ターゲット位置に自機側を向けて置いた仮想標的面(的)を弾が通過した点のマーカー。
const BOARD_MARK_LIFETIME = 5.0; // 表示時間 [s]
const MAX_BOARD_MARKS = 1; // 同時に出す通過点の数。増やすと照準の目安として紛らわしい

// マップ上の弾薬・燃料マーカーが薄れ始める/消える、視点からの距離 [m]。
const MAP_AMMO_FADE_START = 5e7;
const MAP_AMMO_FADE_END = 1e8;

const PROTEIN_SITE_MARKER_RANGE = 3000; // タンパク質敵の機能部位マーカーを表示する距離上限 [m]

// マップ上の弾薬・燃料マーカーの不透明度。視点から MAP_AMMO_FADE_START で薄れ始め、MAP_AMMO_FADE_END で消える。
function ammoFadeOpacity(pos: Vec3, viewerPos: Vec3 | null): number {
  if (!viewerPos) return 0;
  const distance = len(sub(pos, viewerPos));
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
  private readonly combatMarkers: GroupedMarkers;
  // ターゲットへの見越し点のマーカー。
  private readonly leadMarkers: LeadMarkers;

  // 標的面(自機の方を向いた仮想の的)を弾が通過した点。的に貼り付いて見えるよう、
  // ターゲット相対のオフセットで持つ。寿命は通過時刻と表示時刻の差で決まる(R5)。
  private boardMarks: { off: Vec3; simTime: number }[] = [];
  // 最後に読んだ出来事の通し番号。同じ通過を二度マークにしないために持つ。
  private lastBoardSeq = -1;

  // 照準・戦闘対象・見越し点の3つの群を装置から確保する。畳むのは dispose。ターゲットは navTarget から
  // 読み、選び直しは navTargetCommands へ積む。
  public constructor(
    markers: MarkerDevice,
    private readonly navTarget: NavTargetSource,
    private readonly navTargetCommands: NavTargetCommands,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: readonly CelestialBody[],
  ) {
    this.aimGroup = markers.createGroup();
    this.combatMarkers = new GroupedMarkers(markers);
    this.leadMarkers = new LeadMarkers(markers);
  }

  // 直前の sync で、戦闘対象のマーカー集合が天体ラベルへラベルを譲った項目。
  public get hiddenMarkerItems(): readonly GroupedMarkerItem[] {
    return this.combatMarkers.getHiddenItems();
  }

  // 所有するマーカー群を取り除く。
  public dispose(): void {
    this.aimGroup.dispose();
    this.combatMarkers.dispose();
    this.leadMarkers.dispose();
  }

  // [T] の要求を受けてから、カメラ更新後の選定で消費するまでのあいだ立つ。
  private targetSelectRequested = false;

  // 航法ターゲットを生存中の敵・自艦・基地として解決したもの。戦闘対象になれない対象
  // (天体・ラグランジュ点)や撃破済みなら null。
  public get aliveTarget(): CombatTarget | null {
    const id = this.navTarget.id;
    return id === null ? null : aliveCombatTarget(this.roster.all(), id);
  }

  // [T] のターゲット選定を要求する。選定は、カメラ更新後に呼ぶ handleTargetSelect で行う。
  public requestTargetSelect(): void {
    this.targetSelectRequested = true;
  }

  // [T] の要求が立っていれば、照準中心にもっとも近い対象をターゲットにする命令を積む。候補が
  // 無ければ解除する命令になる。操作中の艦自身は候補から外す。
  public handleTargetSelect(viewer: OrbitingObject, project: ProjectFn, viewport: Viewport): void {
    if (!this.targetSelectRequested) return;
    this.targetSelectRequested = false;
    const targets = this.roster.all()
      .filter(isCombatTarget).filter((e) => e.motion.alive && e !== viewer);
    this.navTargetCommands.setCombatTarget(pickNearest(
      targets, (target) => project(target.motion.state.r),
      viewport.width * 0.5, viewport.height * 0.5, Infinity));
  }

  // 記録された通過からマークの列を組み直す。表示時刻 displayTime で寿命の尽きたものは落とし、
  // 的面が定まらない(視点かターゲットが居ない)フレームでは全部捨てる。
  public updateBoardMarks(
    events: readonly RunEvent[], viewer: OrbitingObject | null, displayTime: number,
  ): void {
    for (const event of events) {
      if (event.seq <= this.lastBoardSeq) continue;
      this.lastBoardSeq = event.seq;
      const { body } = event;
      if (body.kind !== 'targetBoardPassed') continue;
      this.boardMarks.push({ off: body.offset, simTime: body.simTime });
      // 溢れたぶんは古いほうから落とす — 新しい通過ほど照準の目安として価値がある。
      if (this.boardMarks.length > MAX_BOARD_MARKS) this.boardMarks.shift();
    }
    if (viewer === null || this.aliveTarget === null) {
      this.boardMarks.length = 0;
      return;
    }
    this.boardMarks = this.boardMarks.filter(
      (m) => displayTime - m.simTime < BOARD_MARK_LIFETIME);
  }

  // ターゲットに紐づく表示物(的通過マーク・方位マーカー)と、全戦闘対象のマーカー集合を
  // まとめて更新する。celestialLabels は今フレームに描かれた天体ラベルで、マップでの重なりを
  // 避けるために読む。
  public sync(
    viewer: OrbitingObject | null, camera: CameraFrame, view: ViewMode, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null, celestialLabels: readonly ActiveCelestialLabel[],
    nowMs: number, palette: ThemePalette,
  ): void {
    const project = camera.project;
    this.declarations.length = 0;
    this.pushBoardMarkers(project, displayTime);
    this.pushTargetDirMarkers(viewer, view === 'map', project);
    this.syncTargetMarkers(viewer, displayTime, camera, view, visibilityPolicy, celestialLabels, nowMs, palette);
    this.aimGroup.sync(this.declarations, nowMs);
  }

  // 全戦闘対象のマーカー集合(ターゲットの役割を含む)と LEAD マーカーを同期する。位置は
  // 機体メッシュと同じ stateAt — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
  private syncTargetMarkers(
    viewer: OrbitingObject | null, displayTime: number, camera: CameraFrame, view: ViewMode,
    visibilityPolicy: MapVisibilityPolicy | null, celestialLabels: readonly ActiveCelestialLabel[],
    nowMs: number, palette: ThemePalette,
  ): void {
    // 戦闘対象(マップでは操作対象自身を含む)のマーカー。
    const targets = this.roster.all().filter(isCombatTarget);
    const ammoPickups = this.roster.all().filter(isAmmoPickup);
    const fuelPickups = this.roster.all().filter(isRcsFuelPickup);
    const mapView = view === 'map';
    const project = camera.project;
    // 視点が居なければ、どの対象も視点から等しく遠く、距離で決まる範囲の外にあるものとして表示する。
    const viewerPos = viewer?.motion.state.r ?? null;
    this.aliveScratch.length = 0;
    this.markerItemScratch.length = 0;
    for (const tgt of targets) {
      if (!tgt.motion.alive) continue;
      this.aliveScratch.push(tgt);
      const ds = tgt.motion.stateAt(displayTime);
      if (!ds) continue;
      const visibility = visibilityPolicy?.entity(tgt.mapKind, tgt === viewer);
      if (visibility && !visibility.pickable) continue;
      // 戦闘ビューのカメラ直下にいる自機は、マーカーを重ねると視界を遮るため除外する。
      if (!mapView && tgt === viewer) continue;
      const item = tgt.markerItem(viewerPos, ds.r, ds.v, view, tgt === viewer);
      const mapOccluded = mapView && isOccluded(camera.position, ds.r, this.celestialBodies, displayTime);
      const mapOpacity = mapOccluded
        ? 0
        : tgt instanceof Enemy && mapView
          ? mapPlanetFadeOpacity(nearestPlanetDistance(ds.r, this.celestialBodies, displayTime))
          : 1;
      this.pushMarkerItem(
        tgt === this.aliveTarget ? withTargetRole(item, palette) : item,
        viewerPos, mapView, visibility, mapOpacity, mapOccluded);
    }
    // 部位マーカーは死んだ個体まで辿る — 生存個体だけだと撃破直後の部位マーカーが残る。
    for (const tgt of targets) {
      if (!(tgt instanceof ProteinEnemy)) continue;
      const ds = tgt.motion.alive ? tgt.motion.stateAt(displayTime) : null;
      this.pushProteinSiteMarkers(tgt, ds?.r ?? null, viewerPos, mapView, project, camera.position);
    }
    // 弾薬・燃料のマーカー。マップでは視点から遠いほど薄れる。
    for (const ammo of ammoPickups) {
      if (!ammo.motion.alive) continue;
      const visibility = visibilityPolicy?.entity('ammo');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = mapView && isOccluded(
        camera.position, ammo.motion.state.r, this.celestialBodies, displayTime,
      );
      const mapOpacity = mapOccluded
        ? 0
        : mapView ? ammoFadeOpacity(ammo.motion.state.r, viewerPos) : 1;
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
        : mapView ? ammoFadeOpacity(fuel.motion.state.r, viewerPos) : 1;
      this.pushMarkerItem(fuel.markerItem(), viewerPos, mapView, visibility, mapOpacity, mapOccluded);
    }
    this.combatMarkers.sync(
      this.markerItemScratch, camera, view, nowMs, celestialLabels, this.celestialBodies,
    );
    // 見越し点は弾速に基づいて算出するため、砲を搭載した操作対象艦の制御時のみ表示される。
    const shooter = viewer instanceof ModularShip
      ? { state: viewer.motion.state, muzzleVelocity: viewer.averageMuzzleVelocity }
      : null;
    this.leadMarkers.sync(shooter, this.aliveScratch, this.aliveTarget, view, project, nowMs);
  }

  // markerItemScratch へ、視点からの距離ラベル・可視性設定(アイコン/名前の個別トグル)・
  // マップ上のフェード/遮蔽を反映して積む。マップビュー中と視点が居ない間は距離ラベルを出さない。
  private pushMarkerItem(
    item: GroupedMarkerItem, viewerPos: Vec3 | null, mapView: boolean,
    visibility: MapVisibility | undefined, opacity: number, occluded: boolean,
  ): void {
    const detail = mapView || !viewerPos ? '' : fmtMarkerDist(len(sub(item.pos, viewerPos)));
    this.markerItemScratch.push(visibility ? {
      ...item,
      sym: visibility.icon ? item.sym : '',
      name: visibility.label ? item.name : '',
      detail: visibility.label ? detail : '',
      opacity,
      occluded,
    } : { ...item, detail, opacity, occluded });
  }

  // タンパク質敵が視点から PROTEIN_SITE_MARKER_RANGE 以内にある間、通常の敵マーカーへ加えて
  // 各機能部位の HP・名称マーカーを表示する。
  private pushProteinSiteMarkers(
    enemy: ProteinEnemy, displayPos: Vec3 | null, viewerPos: Vec3 | null, mapView: boolean, project: ProjectFn,
    cameraPos: Vec3,
  ): void {
    const inRange = !mapView && displayPos !== null && viewerPos !== null
      && len(sub(displayPos, viewerPos)) <= PROTEIN_SITE_MARKER_RANGE;
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
  private pushBoardMarkers(project: ProjectFn, displayTime: number): void {
    const target = this.aliveTarget;
    // 記録の無いスロットも宣言し、前フレームのマークを伏せる。
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
      const fade = 1 - (displayTime - m.simTime) / BOARD_MARK_LIFETIME;
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
    // ターゲットが居ないフレームでも2本とも宣言し、前フレームの向きを伏せる。
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
