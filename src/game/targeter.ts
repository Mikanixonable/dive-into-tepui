import { add, addScaled, dot, len, lenSq, norm, scale, sub, v3, Vec3 } from '../math/vec3';
import { CelestialMotion } from '../physics/celestial-motion';
import * as C from './const';
import { Enemy } from './dynamic/dynamic-entity/enemy';
import { ProteinEnemy } from './dynamic/dynamic-entity/protein-enemy';
import { Base } from './dynamic/dynamic-entity/base';
import type { AmmoPickup } from './dynamic/dynamic-entity/ammo-pickup';
import type { RcsFuelPickup } from './dynamic/dynamic-entity/rcs-fuel-pickup';
import type { DynamicSystem } from './dynamic/dynamic-system';
import { Player } from './player/player';
import { Input, PointerPoint } from './input/input';
import { CameraSystem, ProjectFn } from './camera/camera-system';
import type { GroupedMarkerItem } from './marker/grouped-markers';
import { MarkerManager } from './marker/marker-manager';
import { DIRECTION_GLYPH } from './marker/marker-glyphs';
import { pickNearest } from './pickable/map-pickable';
import { pickRadiusSq } from './input/pointer-precision';
import type { CelestialSystem } from './celestial/celestial-system';
import type { FrameAnchorSource } from '../physics/frame';
import { DisplayWindow, timeLabelSettingOf } from './display-window-manager';
import { KEY_MAPPING as K } from './input/key-mapping';
import type { MapVisibility, MapVisibilityPolicy } from './map/visibility-policy';
import { mapPlanetFadeOpacity, nearestPlanetDistance } from './celestial/planet-distance';
import { isOccluded } from '../physics/occlusion';
import type { NavTarget } from './nav-target';

// ターゲット位置に自機側を向けて置いた仮想標的面(的)を弾が通過した点のマーカー。
// 最新の 1 点のみ表示する(複数出ると照準の目安として紛らわしいため)。
const BOARD_MARK_LIFETIME = 5.0; // 表示時間 [s]
const MAX_BOARD_MARKS = 1;
const BOARD_RADIUS = 4000; // 的の半径 [m](これ以遠の通過は記録しない)

const MAP_AMMO_FADE_START = 5e7;
const MAP_AMMO_FADE_END = 1e8;
const TARGET_LOCK_PICK_PX_SQ = 600; // 右クリックによるターゲット固定のヒット判定半径の2乗 [px^2](~24px半径)

const TARGET_LOCK_PICK_PX_SQ_COARSE = 1936;

const PROTEIN_SITE_MARKER_RANGE = 3000; // タンパク質敵の機能部位マーカーを表示する距離上限 [m]

export type CombatTarget = Enemy | Player | Base;

// マーカー上での対象の役割。ターゲットは色と字形が変わる。
export type MarkerRole = 'none' | 'primary';

// 自機からの距離が MAP_AMMO_FADE_END を超えるとマップ上で見えなくなる(近くの弾薬だけ拾えれば
// よいため、遠方まで塗り続けない)。
function ammoFadeOpacity(distance: number): number {
  return Math.max(0, Math.min(1, (MAP_AMMO_FADE_END - distance) / (MAP_AMMO_FADE_END - MAP_AMMO_FADE_START)));
}

export class Targeter {
  // syncTargetMarkers が毎フレーム組み直す作業用配列。
  private readonly aliveScratch: CombatTarget[] = [];
  private readonly markerItemScratch: GroupedMarkerItem[] = [];

  // ターゲット標的面(自機の方を向いた仮想の的)の通過点(ターゲット相対オフセットで
  // 保持し、的に貼り付いて見せる)。updateBoardMarks が寿命を持ち、syncBoardMarkers が描く。
  boardMarks: { off: Vec3; age: number; }[] = [];

  constructor(
    private readonly markerManager: MarkerManager,
    private readonly navTarget: NavTarget, private readonly entities: DynamicSystem,
  ) {}

  // 現在の戦闘ターゲット。正本は NavTarget(航法ターゲットと状態を共有)が持ち、ここでは
  // 生存中の敵・自艦・基地としてその場で解決するだけ。
  get aliveTarget(): CombatTarget | null {
    return this.navTarget.resolveCombatTarget(this.entities);
  }

  // Tキーで照準中心に最も近い敵をターゲットにする。オート選定は行わない — 右クリックでの
  // 設定/解除は MapContextActions が開くプロパティウィンドウの項目(target)から
  // navTarget.toggleTarget を呼ぶ。ビューはここでは持たないので毎フレーム引数で受け取り、
  // マップ視点では何もしない。
  handleTargetSelectKey(input: Input, targets: CombatTarget[], project: ProjectFn, overviewMode: boolean): void {
    if (overviewMode) return;
    if (!input.takeKey(K.targetSelect)) return;
    const next = targets
      .filter((e) => e.alive)
      .map((target) => {
        const p = project(target.state.r);
        const dx = p.x - window.innerWidth * 0.5;
        const dy = p.y - window.innerHeight * 0.5;
        return { target, d2: dx * dx + dy * dy, front: p.front };
      })
      .filter((x) => x.front)
      .sort((a, b) => a.d2 - b.d2)[0]?.target ?? null;
    this.navTarget.setCombatTarget(next);
  }

  // マップ表示中だけ、戦闘ターゲットの赤道交点マーカーを求め直す(戦闘ビューでは誰も読まない)。
  updateEquatorNodes(
    overviewMode: boolean, displayWindow: DisplayWindow, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
  ): void {
    if (!overviewMode) return;
    const timeLabel = timeLabelSettingOf(displayWindow);
    this.aliveTarget?.ensureEquatorNodes(this.markerManager)
      .updateOnEllipse(displayWindow.displayTime, celestialSystem, frameAnchors, timeLabel);
  }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、発射弾がその面を自機側から
  // 通過した点をターゲット相対で記録する。既存の記録は経過時間を進め、寿命切れを捨てる。
  updateBoardMarks(dt: number, player: Player | null, entities: DynamicSystem): void {
    const target = this.aliveTarget;
    // 記録側と描画側で同じ aliveTarget を見る: target のままだと撃破後も死亡個体の
    // 凍結位置を基準に ✦ を残し続けてしまう。
    if (!player || !target) {
      this.boardMarks.length = 0;
      return;
    }
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < BOARD_MARK_LIFETIME;
    });
    const n = norm(sub(target.state.r, player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    // 各弾について、前フレームと今フレームの位置が的面をどちら向きに跨いだかを見る。
    for (const b of entities.bullets) {
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

  // ターゲットに紐づく表示物(的通過マーク・方位マーカー)をまとめて更新する。
  // ターゲットの選定を持つのがここなので、その表示もここに閉じる。
  sync(player: Player | null, cameraSystem: CameraSystem): void {
    const overviewMode = cameraSystem.overviewMode;
    const project = cameraSystem.activeCameraProjection;
    this.syncBoardMarkers(project);
    this.syncTargetDirMarkers(player, overviewMode, project);
  }

  // 全戦闘対象のマーカー集合(ターゲットの役割を含む)と LEAD マーカーを同期する。
  // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
  // 予測地平の先を指していて displayState を返せない対象と、可視性判定で選択不可の対象は出さない。
  syncTargetMarkers(
    player: Player | null, targets: readonly CombatTarget[], ammoPickups: readonly AmmoPickup[], fuelPickups: readonly RcsFuelPickup[],
    displayTime: number, simTime: number, cameraSystem: CameraSystem, visibilityPolicy: MapVisibilityPolicy | null,
    celestialBodies: readonly CelestialMotion[],
  ): void {
    const overviewMode = cameraSystem.overviewMode;
    const project = cameraSystem.activeCameraProjection;
    const screenScale = cameraSystem.activeCameraScale;
    const viewerPos = player?.state.r ?? v3();
    this.aliveScratch.length = 0;
    this.markerItemScratch.length = 0;
    for (const tgt of targets) {
      if (!tgt.alive) continue;
      this.aliveScratch.push(tgt);
      const ds = tgt.displayState(displayTime);
      if (!ds) continue;
      const visibility = visibilityPolicy?.entity(tgt instanceof Player ? 'player' : (tgt instanceof Base ? 'base' : 'ship'), tgt === player);
      if (visibility && !visibility.pickable) continue;
      // 戦闘ビューではカメラ直下の自機をマーカーで重ねて表示しない。マップビューでは
      // 他の自機と同じ位置マーカーが必要なので、操作対象かつ戦闘ビューのときだけ除外する。
      if (!overviewMode && tgt === player) continue;
      const role: MarkerRole = tgt === this.aliveTarget ? 'primary' : 'none';
      const item = tgt instanceof Player
        ? tgt.markerItem(role, viewerPos, ds.r, ds.v, overviewMode, tgt === player)
        : tgt.markerItem(role, viewerPos, ds.r, ds.v, overviewMode);
      const mapOccluded = overviewMode && isOccluded(cameraSystem.activeCameraPos, ds.r, celestialBodies, displayTime);
      const mapOpacity = mapOccluded
        ? 0
        : tgt instanceof Enemy && overviewMode
          ? mapPlanetFadeOpacity(nearestPlanetDistance(ds.r, celestialBodies, displayTime))
          : 1;
      this.pushMarkerItem(item, visibility, mapOpacity, mapOccluded);
    }
    // 生死・距離にかかわらず全タンパク質敵を辿ってマーカーの表示/非表示を確定する
    // (上のループは生存個体しか通らないため、撃破直後に部位マーカーが残るのを防ぐ)。
    for (const tgt of targets) {
      if (!(tgt instanceof ProteinEnemy)) continue;
      const ds = tgt.alive ? tgt.displayState(displayTime) : null;
      this.syncProteinSiteMarkers(tgt, ds?.r ?? null, viewerPos, overviewMode, project, cameraSystem.activeCameraPos);
    }
    for (const ammo of ammoPickups) {
      if (!ammo.alive) continue;
      const visibility = visibilityPolicy?.entity('ammo');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = overviewMode && isOccluded(cameraSystem.activeCameraPos, ammo.state.r, celestialBodies, displayTime);
      const mapOpacity = mapOccluded ? 0 : overviewMode ? ammoFadeOpacity(len(sub(ammo.state.r, viewerPos))) : 1;
      this.pushMarkerItem(ammo.markerItem(viewerPos, overviewMode), visibility, mapOpacity, mapOccluded);
    }
    for (const fuel of fuelPickups) {
      if (!fuel.alive) continue;
      const visibility = visibilityPolicy?.entity('fuel');
      if (visibility && !visibility.pickable) continue;
      const mapOccluded = overviewMode && isOccluded(cameraSystem.activeCameraPos, fuel.state.r, celestialBodies, displayTime);
      const mapOpacity = mapOccluded ? 0 : overviewMode ? ammoFadeOpacity(len(sub(fuel.state.r, viewerPos))) : 1;
      this.pushMarkerItem(fuel.markerItem(viewerPos, overviewMode), visibility, mapOpacity, mapOccluded);
    }
    const celestialLabels = overviewMode ? cameraSystem.focusMarkers.activeLabels : [];
    this.markerManager.combatMarkers.sync(
      this.markerItemScratch, project, overviewMode, screenScale, celestialLabels, celestialBodies,
      cameraSystem.activeCameraPos,
    );
    if (player) {
      this.markerManager.leadMarkers.sync(player, this.aliveScratch, this.aliveTarget, simTime, overviewMode, project);
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
  // 各機能部位の HP・名称マーカーを表示する。ロック中ターゲット情報とは独立して出す。
  private syncProteinSiteMarkers(
    enemy: ProteinEnemy, displayPos: Vec3 | null, viewerPos: Vec3, overviewMode: boolean, project: ProjectFn, cameraPos: Vec3,
  ): void {
    const inRange = !overviewMode && displayPos !== null && len(sub(displayPos, viewerPos)) <= PROTEIN_SITE_MARKER_RANGE;
    const sites = enemy.siteMarkers(displayPos ?? enemy.state.r);
    for (const site of sites) {
      const key = `psite-${enemy.id}-${site.id}`;
      if (!inRange) { this.markerManager.hide(key); continue; }
      const label = `${site.abbreviation} ${Math.max(0, Math.round(site.hp))}/${site.maxHp}`;
      const color = site.disabled ? 'var(--text-dim)' : site.attackable ? C.COLOR_MARKER_ENEMY : undefined;
      this.markerManager.setPosition(key, 'mk-protein-site', '●', site.worldPos, project, label, 1, color, undefined, false, false, C.MARKER_PRIORITY.PROTEIN_SITE, cameraPos);
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
      const fade = 1 - m.age / BOARD_MARK_LIFETIME;
      this.markerManager.setPosition(key, 'mk-boardpass', '✦', add(target.state.r, m.off), project, '', 0.25 + 0.75 * fade);
    }
  }

  // ターゲット/その反対方向を指す方向マーカー(戦闘ビューのみ)。自機の軌道基準方向マーカー
  // (player-markers.ts)と同じ扱いで、自機位置を原点に置く。
  private syncTargetDirMarkers(player: Player | null, overviewMode: boolean, project: ProjectFn): void {
    const tgt = this.aliveTarget;
    if (overviewMode || !tgt || !player) {
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
      return;
    }
    const tgtDir = norm(sub(tgt.state.r, player.state.r));
    this.markerManager.setDirection('tgtdir', 'mk-tgtdir', DIRECTION_GLYPH.target, player.state.r, tgtDir, project);
    this.markerManager.setDirection('atgdir', 'mk-tgtdir', DIRECTION_GLYPH.antiTarget, player.state.r, scale(tgtDir, -1), project);
  }

  // クリック位置の許容半径内で画面上最も近い生存ターゲットを返す。範囲外なら null。
  // MapContextActions の戦闘ビュー右クリック(プロパティウィンドウを開く対象探し)が読む。
  pickTargetAt(click: PointerPoint, targets: readonly CombatTarget[], project: ProjectFn): CombatTarget | null {
    const pickables = targets.filter((e) => e.alive).map((target) => ({ pos: target.state.r, target }));
    const picked = pickNearest(pickables, click.x, click.y, project, pickRadiusSq(TARGET_LOCK_PICK_PX_SQ, TARGET_LOCK_PICK_PX_SQ_COARSE));
    return picked?.target ?? null;
  }
}
