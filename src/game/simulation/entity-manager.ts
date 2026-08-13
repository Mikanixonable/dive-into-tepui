// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Attractor } from '../../physics/attractor';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { Ammo } from '../game-entity/ammo';
import { Asteroid } from '../game-entity/asteroid';
import { DebrisPiece } from '../game-entity/debris-piece';
import { Enemy } from '../game-entity/enemy';
import { Bullet } from '../game-entity/bullet';
import { Base } from '../game-entity/base';
import { InstancedPool } from '../../render/instanced-pool';
import { bulletBodyResources, bulletHaloResources, plasmaBodyResources, casingBodyResources, debrisFragmentResources } from '../../render/ships';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { CombatTarget } from '../targeter';
import type { MapVisibility, MapVisibilityPolicy } from '../celestial/map-visibility';
import type { CameraSystem, ProjectFn, ScaleFn } from '../camera/camera-system';
import type { Ephemeris } from '../../physics/ephemeris';
import type { DisplayWindow } from '../display-window-manager';
import type { GameSaveData } from '../save-data';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { PerfCounts } from '../../perf-meter';

// 起動時の顔ぶれ。新規開始は自機の隻数だけを、スナップショットからの再開は保存内容を渡す。
export type EntityManagerInit =
  | { readonly playerCount: number }
  | { readonly saved: GameSaveData };

export class EntityManager {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  readonly ammos: Ammo[] = [];
  readonly asteroids: Asteroid[] = [];
  // 自機。操作対象(Game.player)もこの配列の1隻で、積分・衝突・寿命判定・予測では
  // 他の艦と対等に扱う。ステージモードでは1隻だけが入る。
  readonly players: Player[] = [];
  readonly bases: Base[] = [];

  // 弾本体・弾ハロー・プラズマ弾・薬莢は geometry/material を全個体で共有するため、
  // 個別の scene 追加ではなく InstancedMesh 1本ずつのプールで描画する(sync が push する)。
  private readonly bulletBodyPool: InstancedPool;
  private readonly bulletHaloPool: InstancedPool;
  private readonly plasmaPool: InstancedPool;
  private readonly casingPool: InstancedPool;
  // 破片(fragment)はバリアントごとに geometry が異なるため、バリアント数だけプールを持つ。
  // DebrisPiece.fragmentVariant が添字。
  private readonly debrisFragmentPools: InstancedPool[];

  // フラッシュ・破片の生成窓口。破片は entity なので、その配列を持つこちらが所有する。
  readonly effects: EffectsSystem;

  // 描画資源のプールを組み、演出窓口を作ってから、init の指すとおりに起動時の顔ぶれを配置する。
  constructor(
    scene: THREE.Scene,
    hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
    init: EntityManagerInit,
  ) {
    const bulletBody = bulletBodyResources();
    const bulletHalo = bulletHaloResources();
    const plasmaBody = plasmaBodyResources();
    const casingBody = casingBodyResources();
    const debrisFragment = debrisFragmentResources();
    this.bulletBodyPool = new InstancedPool(scene, bulletBody.geometry, bulletBody.material, C.MAX_BULLETS * 3);
    this.bulletHaloPool = new InstancedPool(scene, bulletHalo.geometry, bulletHalo.material, C.MAX_BULLETS * 3);
    this.plasmaPool = new InstancedPool(scene, plasmaBody.geometry, plasmaBody.material, C.MAX_BULLETS * 3);
    this.casingPool = new InstancedPool(scene, casingBody.geometry, casingBody.material, C.MAX_CASINGS);
    this.debrisFragmentPools = debrisFragment.geometries.map(
      (geo) => new InstancedPool(scene, geo, debrisFragment.material, C.MAX_DEBRIS, true));
    this.effects = new EffectsSystem(scene, this, sfx);
    if ('saved' in init) this.restoreFromSave(init.saved, hud, sfx, scene, markerManager);
    else this.spawnInitialPlayers(init.playerCount, hud, sfx, scene, markerManager);
  }

  // 新規開始時の初期配置。艦の隻数は 0..n が一般形で、1隻に固定するかどうかはステージ側の判断。
  private spawnInitialPlayers(
    count: number, hud: Hud, sfx: Sfx, scene: THREE.Scene, markerManager: MarkerManager,
  ): void {
    for (let i = 0; i < count; i++) {
      this.addPlayer(new Player(hud, sfx, scene, this.effects, markerManager));
    }
  }

  // スナップショットから自機・敵・弾薬・基地を復元する。
  private restoreFromSave(
    save: GameSaveData, hud: Hud, sfx: Sfx, scene: THREE.Scene, markerManager: MarkerManager,
  ): void {
    const simTime = save.simTime;
    for (const data of save.players) {
      this.addPlayer(new Player(hud, sfx, scene, this.effects, markerManager, { saved: data, simTime }));
    }
    for (const data of save.enemies) {
      this.addEnemy(new Enemy({ saved: data, simTime }, hud, sfx, this.effects, scene));
    }
    for (const data of save.ammos) {
      this.addAmmo(new Ammo({ saved: data, simTime }, scene, markerManager));
    }
    for (const data of save.bases) {
      this.addBase(new Base({ saved: data, simTime }, scene, hud, sfx, this.effects, markerManager));
    }
  }

  // all()/otherEntities() はSimulatorの各substepから何度も呼ばれる。配列の内容が変わった
  // ときだけ結合し、Predictor→attractors の入れ子呼び出しでも同じ安定配列を返す。
  private _collectionRevision = 0;
  private cachedRevision = -1;
  private readonly cachedOtherEntities: GameEntity[] = [];
  private readonly cachedAllEntities: GameEntity[] = [];
  private readonly cachedAttractors: GameEntity[] = [];
  // Targeter/Game は取得した配列を読み取り専用として扱う(filter/sort等で破壊しない)ため、
  // collectionRevision が変わるまで敵・自機の結合結果も再利用する。
  private combatTargetsRevision = -1;

  // 保持するエンティティの顔ぶれの世代。追加・除去・prune のいずれでも増える。
  get collectionRevision(): number {
    return this._collectionRevision;
  }

  private readonly cachedCombatTargets: CombatTarget[] = [];
  private readonly cachedCombatTargetsByExcludedPlayer = new Map<Player, CombatTarget[]>();

  // 敵を登録する。
  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
    this.invalidateCaches();
  }

  // 自機を登録する。
  addPlayer(player: Player): void {
    this.players.push(player);
    this.invalidateCaches();
  }

  // 自機を取り除き、メッシュを破棄する。
  removePlayer(player: Player): void {
    const i = this.players.indexOf(player);
    if (i < 0) return;
    this.players.splice(i, 1);
    this.invalidateCaches();
    player.dispose();
  }

  // 自機を取り除くが破棄はしない(基地への収容など、後で addPlayer で復帰させる場合)。
  // 配列から外れると毎フレームの同期が届かなくなるので、マーカーはここで畳む。
  parkPlayer(player: Player): void {
    const i = this.players.indexOf(player);
    if (i < 0) return;
    this.players.splice(i, 1);
    player.equatorNodes?.dispose();
    player.equatorNodes = null;
    this.invalidateCaches();
  }

  // ターゲットとなり得るエンティティの一覧を取得する。
  getCombatTargets(excludePlayer: Player | null): CombatTarget[] {
    this.rebuildCombatTargetsIfNeeded();
    if (excludePlayer === null) return this.cachedCombatTargets;

    let targets = this.cachedCombatTargetsByExcludedPlayer.get(excludePlayer);
    if (targets) return targets;
    targets = [];
    for (const enemy of this.enemies) targets.push(enemy);
    for (const player of this.players) if (player !== excludePlayer) targets.push(player);
    this.cachedCombatTargetsByExcludedPlayer.set(excludePlayer, targets);
    return targets;
  }

  private rebuildCombatTargetsIfNeeded(): void {
    if (this.combatTargetsRevision === this._collectionRevision) return;
    this.cachedCombatTargets.length = 0;
    this.cachedCombatTargets.push(...this.enemies, ...this.players);
    this.cachedCombatTargetsByExcludedPlayer.clear();
    this.combatTargetsRevision = this._collectionRevision;
  }

  // id で名指しされた自機を返す。見つからなければ null。
  findPlayer(id: string): Player | null {
    return this.players.find((p) => p.id === id) ?? null;
  }

  // id で名指しされた敵を返す。見つからなければ null。
  findEnemy(id: string): Enemy | null {
    return this.enemies.find((e) => e.id === id) ?? null;
  }

  // 弾を登録する。上限を超えた分は古いものから破棄する。
  addBullet(bullet: Bullet): void {
    this.addCapped(this.bullets, bullet, C.MAX_BULLETS * 3);
  }

  // 破片を種別(薬莢/その他)ごとの配列へ登録する。上限を超えた分は古いものから破棄する。
  addDebris(piece: DebrisPiece): void {
    if (piece.kind === 'casing') this.addCapped(this.casings, piece, C.MAX_CASINGS);
    else this.addCapped(this.debris, piece, C.MAX_DEBRIS);
  }

  // 弾薬ピックアップを登録する。
  addAmmo(ammo: Ammo): void {
    this.ammos.push(ammo);
    this.invalidateCaches();
  }

  // 小惑星を登録する。上限を超えた分は古いものから破棄する。
  addAsteroid(asteroid: Asteroid): void {
    this.addCapped(this.asteroids, asteroid, C.MAX_ASTEROIDS);
  }

  // 基地を登録する。
  addBase(base: Base): void {
    this.bases.push(base);
    this.invalidateCaches();
  }

  // ID で名指された基地を返す。見つからなければ null。
  findBase(id: string): Base | null {
    return this.bases.find(b => b.id === id) ?? null;
  }

  // 配列へ追加し、cap を超えたら先頭(最古)を1件破棄する。
  private addCapped<T extends GameEntity>(arr: T[], entity: T, cap: number): void {
    arr.push(entity);
    if (arr.length > cap) arr.shift()!.dispose();
    this.invalidateCaches();
  }

  private invalidateCaches(): void {
    this._collectionRevision++;
  }

  private rebuildCachesIfNeeded(): void {
    if (this.cachedRevision === this._collectionRevision) return;
    this.cachedOtherEntities.length = 0;
    this.cachedOtherEntities.push(
      ...this.enemies,
      ...this.bullets,
      ...this.ammos,
      ...this.asteroids,
      ...this.casings,
      ...this.debris,
      ...this.bases,
    );
    this.cachedAllEntities.length = 0;
    this.cachedAllEntities.push(...this.cachedOtherEntities, ...this.players);
    this.cachedAttractors.length = 0;
    for (const e of this.cachedAllEntities) {
      if (e.alive && e.mu !== 0) this.cachedAttractors.push(e);
    }
    this.cachedRevision = this._collectionRevision;
  }

  // 自機以外の保持エンティティを1つの配列にまとめて返す。
  private otherEntities(): GameEntity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedOtherEntities;
  }

  // 保持する全エンティティを1つの配列にまとめて返す。
  all(): GameEntity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedAllEntities;
  }

  // 重力を持つ(mu !== 0 かつ生存中の)エンティティを返す。GameEntity は id/radius/mu/degree2/
  // isStar/state を直接持つので Attractor を満たす。
  attractors(): readonly GameEntity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedAttractors;
  }

  // 全エンティティの寿命判定を行い、死亡したものを破棄・除去する。自機だけは各所の参照掃除と
  // 次艦への引き継ぎが要るため、除去は ActivePlayerController.reclaimDead が担う。
  cleanup(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3, attractors: readonly Attractor[]): void {
    for (const e of this.all()) e.checkLoss(dt, simTime, activeStage, playerPos, attractors);
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammos);
    this.prune(this.asteroids);
    this.prune(this.bases);
  }

  // in-place フィルタ: 配列の参照はそのまま保つ。
  private prune<T extends GameEntity>(arr: T[]): void {
    let w = 0;
    let changed = false;
    for (const x of arr) {
      if (!x.alive) {
        x.dispose();
        changed = true;
      }
      else arr[w++] = x;
    }
    arr.length = w;
    if (changed) this.invalidateCaches();
  }

  // 操作対象以外の自機に、表示フレーム基準のベルト・HP回復だけを1回ずつ進める。熱・電力・
  // ラジエータは Simulator が全艦を substep ごとに stepEnvironment する。
  updatePassivePlayers(dt: number, activePlayer: Player | null): void {
    for (const ship of this.players) if (ship !== activePlayer) ship.updatePassive(dt);
  }

  // 操作できない間、全自機の連続指令(推力・トルク・射撃・噴射ラッチ)を畳む。
  clearTransientCommands(): void {
    for (const ship of this.players) ship.clearTransientCommands();
  }

  // 全自機のメッシュ・エフェクト・マーカーを同期する。方向マーカーや照準ズームは操作艦だけの
  // ものなので、どれが操作対象かを各艦へ渡す。
  syncPlayers(
    activePlayer: Player | null, fo: FloatingOrigin, cameraSystem: CameraSystem, phasePlaying: boolean,
    paused: boolean, displayTime: number, ephemeris: Ephemeris, attractors: readonly Attractor[],
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    for (const ship of this.players) {
      ship.syncPlayer(
        fo, cameraSystem, phasePlaying, paused, displayTime, ship === activePlayer, ephemeris, attractors,
        visibilityPolicy?.entity('player', ship === activePlayer) ?? null,
      );
    }
  }

  // 全自機の予測軌道線を同期し、それで解析楕円を代替できる艦は楕円側を抑制する。
  // 積分予測を描くのは操作対象艦だけ — 他の艦は常に解析楕円のまま。
  syncPlayerTrajectoryLines(
    activePlayer: Player | null, displayWindow: DisplayWindow, overviewMode: boolean, ephemeris: Ephemeris,
    fo: FloatingOrigin, camera: THREE.Camera, attractors: readonly Attractor[],
  ): void {
    const { frame, simTime, duration } = displayWindow;
    for (const ship of this.players) {
      ship.syncTrajectoryLine(
        ship === activePlayer, frame, simTime, ephemeris, fo, camera, attractors);
      ship.orbitLine.setSuppressed(ship.supersedesAnalyticEllipse(simTime, duration, overviewMode));
    }
  }

  // 天体クラス別トグルに応じて自機・敵・弾薬・基地のメッシュ表示/軌道線表示を揃える。
  // visibilityPolicy が null(戦闘ビュー)のときは非表示扱いを一切かけない。
  applyVisibility(
    visibilityPolicy: MapVisibilityPolicy | null, activePlayer: Player | null, overviewMode: boolean,
    fo: FloatingOrigin, camera: THREE.Camera, attractors: readonly Attractor[],
  ): void {
    if (visibilityPolicy) {
      for (const ship of this.players) if (!visibilityPolicy.entity('player', ship === activePlayer).category) ship.obj.visible = false;
      for (const enemy of this.enemies) if (!visibilityPolicy.entity('ship').category) enemy.obj.visible = false;
      for (const ammo of this.ammos) if (!visibilityPolicy.entity('ammo').category) ammo.obj.visible = false;
      for (const base of this.bases) if (!visibilityPolicy.entity('base').category) base.obj.visible = false;
    }
    for (const ship of this.players) {
      ship.orbitLine.setDisplayEnabled(!overviewMode || (visibilityPolicy?.entity('player', ship === activePlayer).orbit ?? false));
    }
    for (const enemy of this.enemies) {
      enemy.orbitLine.setDisplayEnabled(!overviewMode || (visibilityPolicy?.entity('ship').orbit ?? false));
    }
    for (const base of this.bases) {
      base.syncOrbitLine(overviewMode, fo, camera, attractors);
      base.orbitLine.setDisplayEnabled(!overviewMode || (visibilityPolicy?.entity('base').orbit ?? false));
    }
  }

  // 全基地の赤道交点マーカーを求め直す。基地は常設の軌道構造物で、接近・ドッキングは
  // 軌道面合わせそのものなので、選択の有無に関わらず常に出す。
  updateBaseEquatorNodes(displayWindow: DisplayWindow, ephemeris: Ephemeris): void {
    for (const base of this.bases) {
      if (base.alive) base.equatorNodes?.update(displayWindow.frame, displayWindow.displayTime, ephemeris);
    }
  }

  // このフレームに求まった赤道交点マーカーを置く。求め直されなかったものは自動的に隠れる。
  syncEquatorNodes(project: ProjectFn, show: boolean, cameraPos: Vec3): void {
    for (const e of this.all()) e.equatorNodes?.sync(project, show, cameraPos);
  }

  // 弾薬・基地の位置マーカーを displayTime の位置へ置く。ラベルの距離は viewerPos 基準で、
  // 艦が1隻も無い間は距離を添えない。
  syncMarkers(
    project: ProjectFn, scale: ScaleFn, displayTime: number, overviewMode: boolean,
    viewerPos: Vec3 | null, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const visibilityOf = (kind: 'ammo' | 'base'): MapVisibility | null =>
      (overviewMode ? visibilityPolicy?.entity(kind) ?? null : null);
    for (const ammo of this.ammos) {
      ammo.marker?.sync(project, scale, displayTime, overviewMode, viewerPos, visibilityOf('ammo'));
    }
    for (const base of this.bases) {
      base.marker?.sync(project, scale, displayTime, overviewMode, viewerPos, visibilityOf('base'));
    }
  }

  // 自機以外のメッシュを displayTime 時点の状態に同期する。自機はエフェクト・ベルト・
  // 軌道線まで持つので Player.syncPlayer が担当する。弾本体・弾ハロー・プラズマ弾・薬莢・
  // 破片(fragment)の変換は各エンティティの obj に同期された後、InstancedPool へ push する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    for (const e of this.otherEntities()) e.sync(fo, displayTime);

    this.bulletBodyPool.beginFrame();
    this.bulletHaloPool.beginFrame();
    this.plasmaPool.beginFrame();
    this.casingPool.beginFrame();
    for (const pool of this.debrisFragmentPools) pool.beginFrame();
    for (const b of this.bullets) {
      if (!b.obj.visible) continue;
      if (b.type === 'plasma') {
        this.plasmaPool.push(b.obj);
        continue;
      }
      // 本体+ハローの Group。シーン外なので matrixWorld は自前で更新する必要があり、
      // 親で1回呼べば子(本体・ハロー)まで連鎖して更新される。
      b.obj.updateMatrixWorld();
      this.bulletBodyPool.push(b.obj.children[0]!);
      this.bulletHaloPool.push(b.obj.children[1]!);
    }
    for (const c of this.casings) this.casingPool.push(c.obj);
    for (const d of this.debris) {
      if (d.kind === 'fragment') this.debrisFragmentPools[d.fragmentVariant]!.push(d.obj, d.fragmentColor!);
    }
    this.bulletBodyPool.endFrame();
    this.bulletHaloPool.endFrame();
    this.plasmaPool.endFrame();
    this.casingPool.endFrame();
    for (const pool of this.debrisFragmentPools) pool.endFrame();
  }

  // 負荷確認ウィンドウが読む、保持配列ごとの現在の個体数。
  perfCounts(): Pick<PerfCounts, 'players' | 'enemies' | 'bullets' | 'casings' | 'debris' | 'ammos' | 'asteroids' | 'bases'> {
    return {
      players: this.players.length,
      enemies: this.enemies.length,
      bullets: this.bullets.length,
      casings: this.casings.length,
      debris: this.debris.length,
      ammos: this.ammos.length,
      asteroids: this.asteroids.length,
      bases: this.bases.length,
    };
  }
}
