import { add, addScaled, dot, lenSq, norm, scale, sub, v3, Vec3 } from '../physics/vec3';
import { CelestialBody } from '../physics/celestial-body';
import * as C from './const';
import { Enemy } from './game-entity/enemy';
import { Base } from './game-entity/base';
import type { EntityManager } from './simulation/entity-manager';
import { Player } from './player/player';
import { Input, PointerPoint } from './input/input';
import { CameraSystem, ProjectFn } from './camera/camera-system';
import type { GroupedMarkerItem } from './marker/grouped-markers';
import { MarkerManager } from './marker/marker-manager';
import { DIRECTION_GLYPH } from './marker/marker-glyphs';
import { pickNearest } from './map-pickable';
import { pickRadiusSq } from './input/pointer-precision';
import type { Ephemeris } from '../physics/ephemeris';
import type { DisplayWindow } from './display-window-manager';
import { KEY_MAPPING as K } from './input/key-mapping';
import type { MapVisibilityPolicy } from './celestial/map-visibility';
import { mapPlanetFadeOpacity, nearestPlanetDistance } from './celestial/planet-distance';
import { isOccluded } from '../physics/occlusion';
import type { NavTarget } from './nav-target';

export type CombatTarget = Enemy | Player | Base;

// マーカー上での対象の役割。ターゲットは色と字形が変わる。
export type MarkerRole = 'none' | 'primary';

export class Targeter {
  // syncTargetMarkers が毎フレーム組み直す作業用配列。
  private readonly aliveScratch: CombatTarget[] = [];
  private readonly markerItemScratch: GroupedMarkerItem[] = [];

  // ターゲット標的面(自機の方を向いた仮想の的)の通過点(ターゲット相対オフセットで
  // 保持し、的に貼り付いて見せる)。updateBoardMarks が寿命を持ち、syncBoardMarkers が描く。
  boardMarks: { off: Vec3; age: number; }[] = [];

  constructor(
    private readonly markerManager: MarkerManager,
    private readonly navTarget: NavTarget, private readonly entities: EntityManager,
  ) {}

  // 現在の戦闘ターゲット。正本は NavTarget(航法ターゲットと状態を共有)が持ち、ここでは
  // 生存中の敵・自艦・基地としてその場で解決するだけ。
  get aliveTarget(): CombatTarget | null {
    return this.navTarget.resolveCombatTarget(this.entities);
  }

  // Tキーで照準中心に最も近い敵をターゲットにする。オート選定は行わない —
  // 右クリックでの設定/解除は MapContextActions が開くプロパティウィンドウの項目(target)から
  // navTarget.toggleCombatTarget を呼ぶ。ビューはここでは持たないので毎フレーム引数で受け取り、
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
  updateEquatorNodes(overviewMode: boolean, displayWindow: DisplayWindow, ephemeris: Ephemeris): void {
    if (!overviewMode) return;
    this.aliveTarget?.ensureEquatorNodes(this.markerManager)
      .update(displayWindow.frame, displayWindow.displayTime, ephemeris);
  }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、発射弾がその面を自機側から
  // 通過した点をターゲット相対で記録する。既存の記録は経過時間を進め、寿命切れを捨てる。
  updateBoardMarks(dt: number, player: Player | null, entities: EntityManager): void {
    const target = this.aliveTarget;
    // 記録側と描画側で同じ aliveTarget を見る: target のままだと撃破後も死亡個体の
    // 凍結位置を基準に ✦ を残し続けてしまう。
    if (!player || !target) {
      this.boardMarks.length = 0;
      return;
    }
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < C.BOARD_MARK_LIFETIME;
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
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > C.MAX_BOARD_MARKS) this.boardMarks.shift();
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
    player: Player | null, targets: readonly CombatTarget[], displayTime: number, simTime: number,
    cameraSystem: CameraSystem, visibilityPolicy: MapVisibilityPolicy | null,
    registry: Ephemeris['registry'], celestialBodies: readonly CelestialBody[],
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
      const role: MarkerRole = tgt === this.aliveTarget ? 'primary' : 'none';
      const item = tgt.markerItem(role, viewerPos, ds.r, ds.v, overviewMode);
      const mapOccluded = overviewMode && isOccluded(cameraSystem.activeCameraPos, ds.r, celestialBodies);
      const mapOpacity = mapOccluded
        ? 0
        : tgt instanceof Enemy && overviewMode
          ? mapPlanetFadeOpacity(nearestPlanetDistance(ds.r, registry, celestialBodies))
          : 1;
      this.markerItemScratch.push(visibility ? {
        ...item,
        sym: visibility.icon ? item.sym : '',
        name: visibility.label ? item.name : '',
        detail: visibility.label ? item.detail : '',
        opacity: mapOpacity,
        occluded: mapOccluded,
      } : {
        ...item,
        opacity: mapOpacity,
        occluded: mapOccluded,
      });
    }
    const celestialLabels = overviewMode ? cameraSystem.focusMarkers.activeLabels : [];
    this.markerManager.combatMarkers.sync(this.markerItemScratch, project, overviewMode, screenScale, celestialLabels, celestialBodies);
    if (player) {
      this.markerManager.leadMarkers.sync(player, this.aliveScratch, this.aliveTarget, simTime, overviewMode, project);
    }
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  private syncBoardMarkers(project: ProjectFn): void {
    const target = this.aliveTarget;
    for (let i = 0; i < C.MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !target) {
        this.markerManager.hide(key);
        continue;
      }
      const fade = 1 - m.age / C.BOARD_MARK_LIFETIME;
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
    const picked = pickNearest(pickables, click.x, click.y, project, pickRadiusSq(C.TARGET_LOCK_PICK_PX_SQ, C.TARGET_LOCK_PICK_PX_SQ_COARSE));
    return picked?.target ?? null;
  }
}
