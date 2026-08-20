// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Attractor } from '../../physics/attractor';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { AmmoPickup } from '../game-entity/ammo-pickup';
import { Asteroid } from '../game-entity/asteroid';
import { DebrisPiece } from '../game-entity/debris-piece';
import { Vessel, type VesselDeps } from '../vessel/vessel';
import { hasBaseModule } from '../vessel/capabilities';
import { vesselMapKind } from '../map-pickable';
import { Bullet } from '../game-entity/bullet';
import { InstancedPool } from '../../render/instanced-pool';
import { bulletBodyResources, bulletHaloResources, plasmaBodyResources, casingBodyResources, debrisFragmentResources } from '../../render/ships';
import type { Stage } from '../stages/stage';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { Input } from '../input/input';
import type { CombatTarget } from '../targeter';
import type { MapVisibility, MapVisibilityPolicy } from '../celestial/map-visibility';
import type { CameraSystem } from '../camera/camera-system';
import type { Ephemeris } from '../../physics/ephemeris';
import type { DisplayWindow } from '../display-window-manager';
import type { GameSaveData } from '../save-data';
import type { Hud } from '../hud/hud';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { GraphicsSettings } from '../../render/graphics-settings';
import type { PerfCounts } from '../../perf-meter';

export class EntityManager {
  readonly bullets: Bullet[] = [];
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  public readonly ammoPickups: AmmoPickup[] = [];
  readonly asteroids: Asteroid[] = [];
  // 軌道上を飛ぶ機体は艦艇も軌道基地も敵艦も、すべてこの1本の配列に入る。操作対象
  // (Game.player)もこの配列の1機で、積分・衝突・寿命判定・予測では他と対等に扱う。
  readonly vessels: Vessel[] = [];

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

  // 描画資源のプールを組み、演出窓口を作ってから、saved があればその顔ぶれを復元する。
  constructor(
    scene: THREE.Scene,
    hud: Hud,
    worldSfx: WorldSfx,
    markerManager: MarkerManager,
    private readonly graphics: GraphicsSettings,
    saved?: GameSaveData,
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
    this.effects = new EffectsSystem(scene, this, worldSfx);
    if (saved) this.restoreFromSave(saved, hud, worldSfx, scene, markerManager);
  }

  // スナップショットから機体・弾薬を復元する。
  private restoreFromSave(
    save: GameSaveData, hud: Hud, worldSfx: WorldSfx, scene: THREE.Scene, markerManager: MarkerManager,
  ): void {
    const simTime = save.simTime;
    const deps: VesselDeps = { hud, worldSfx, scene, fx: this.effects, markerManager, graphics: this.graphics };
    for (const data of save.players) this.addVessel(new Vessel({ savedShip: data, simTime }, deps));
    for (const data of save.enemies) this.addVessel(new Vessel({ savedHostile: data, simTime }, deps));
    for (const data of save.ammoPickups) {
      this.addAmmoPickup(new AmmoPickup({ saved: data, simTime }, scene, markerManager));
    }
    for (const data of save.bases) this.addVessel(new Vessel({ savedBase: data, simTime }, deps));
  }

  // all()/otherEntities() はSimulatorの各substepから何度も呼ばれる。配列の内容が変わった
  // ときだけ結合し、Predictor→attractors の入れ子呼び出しでも同じ安定配列を返す。
  private _collectionRevision = 0;
  private cachedRevision = -1;
  private readonly cachedOtherEntities: GameEntity[] = [];
  private readonly cachedAllEntities: GameEntity[] = [];
  private readonly cachedAttractors: GameEntity[] = [];
  private readonly cachedOwnShips: Vessel[] = [];
  private readonly cachedHostiles: Vessel[] = [];
  private readonly cachedBases: Vessel[] = [];
  // Targeter/Game は取得した配列を読み取り専用として扱うため、collectionRevision が
  // 変わるまで戦闘ターゲットの結合結果も再利用する。
  private combatTargetsRevision = -1;

  // 保持するエンティティの顔ぶれの世代。追加・除去・prune のいずれでも増える。
  get collectionRevision(): number {
    return this._collectionRevision;
  }

  private readonly cachedCombatTargets: CombatTarget[] = [];
  private readonly cachedCombatTargetsByExcluded = new Map<Vessel, CombatTarget[]>();

  // 機体を登録する。艦艇・軌道基地・敵艦の区別は無い。
  addVessel(vessel: Vessel): void {
    this.vessels.push(vessel);
    this.invalidateCaches();
  }

  // 機体を取り除き、メッシュを破棄する。
  removeVessel(vessel: Vessel): void {
    const i = this.vessels.indexOf(vessel);
    if (i < 0) return;
    this.vessels.splice(i, 1);
    this.invalidateCaches();
    vessel.dispose();
  }

  // 機体を取り除くが破棄はしない(基地への収容など、後で addVessel で復帰させる場合)。
  // 配列から外れると毎フレームの同期が届かなくなるので、マーカーはここで畳む。
  parkVessel(vessel: Vessel): void {
    const i = this.vessels.indexOf(vessel);
    if (i < 0) return;
    this.vessels.splice(i, 1);
    vessel.equatorNodes?.dispose();
    vessel.equatorNodes = null;
    this.invalidateCaches();
  }

  // ターゲットとなり得るエンティティの一覧を取得する。
  getCombatTargets(exclude: Vessel | null): CombatTarget[] {
    this.rebuildCombatTargetsIfNeeded();
    if (exclude === null) return this.cachedCombatTargets;

    let targets = this.cachedCombatTargetsByExcluded.get(exclude);
    if (targets) return targets;
    targets = this.vessels.filter((v) => v !== exclude);
    this.cachedCombatTargetsByExcluded.set(exclude, targets);
    return targets;
  }

  private rebuildCombatTargetsIfNeeded(): void {
    if (this.combatTargetsRevision === this._collectionRevision) return;
    this.cachedCombatTargets.length = 0;
    this.cachedCombatTargets.push(...this.vessels);
    this.cachedCombatTargetsByExcluded.clear();
    this.combatTargetsRevision = this._collectionRevision;
  }

  // id で名指しされた機体を返す。見つからなければ null。
  findVessel(id: string): Vessel | null {
    return this.vessels.find((v) => v.id === id) ?? null;
  }

  // 自勢力で基地モジュールを持たない機体。
  ownShips(): readonly Vessel[] {
    this.rebuildCachesIfNeeded();
    return this.cachedOwnShips;
  }

  // 敵対勢力の機体。
  hostileVessels(): readonly Vessel[] {
    this.rebuildCachesIfNeeded();
    return this.cachedHostiles;
  }

  // 基地モジュールを積んだ機体。
  baseVessels(): readonly Vessel[] {
    this.rebuildCachesIfNeeded();
    return this.cachedBases;
  }

  // id で名指しされた自艦を返す。見つからなければ null。
  findOwnShip(id: string): Vessel | null {
    return this.ownShips().find((v) => v.id === id) ?? null;
  }

  // id で名指しされた敵機を返す。見つからなければ null。
  findHostile(id: string): Vessel | null {
    return this.hostileVessels().find((v) => v.id === id) ?? null;
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
  public addAmmoPickup(ammoPickup: AmmoPickup): void {
    this.ammoPickups.push(ammoPickup);
    this.invalidateCaches();
  }

  // 小惑星を登録する。上限を超えた分は古いものから破棄する。
  addAsteroid(asteroid: Asteroid): void {
    this.addCapped(this.asteroids, asteroid, C.MAX_ASTEROIDS);
  }

  // ID で名指された基地を返す。見つからなければ null。
  findBaseVessel(id: string): Vessel | null {
    return this.baseVessels().find((v) => v.id === id) ?? null;
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
      ...this.bullets,
      ...this.ammoPickups,
      ...this.asteroids,
      ...this.casings,
      ...this.debris,
    );
    this.cachedAllEntities.length = 0;
    this.cachedAllEntities.push(...this.cachedOtherEntities, ...this.vessels);
    this.cachedOwnShips.length = 0;
    this.cachedHostiles.length = 0;
    this.cachedBases.length = 0;
    for (const v of this.vessels) {
      if (v.faction === 'enemy') this.cachedHostiles.push(v);
      else if (hasBaseModule(v)) this.cachedBases.push(v);
      else this.cachedOwnShips.push(v);
    }
    this.cachedAttractors.length = 0;
    for (const e of this.cachedAllEntities) {
      if (e.alive && e.mu !== 0) this.cachedAttractors.push(e);
    }
    this.cachedRevision = this._collectionRevision;
  }

  // 機体以外の保持エンティティを1つの配列にまとめて返す。
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
  // isStar/state/accel を直接持つので Attractor を満たす。
  attractors(): readonly GameEntity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedAttractors;
  }

  // 全エンティティの寿命判定を行い、弾・薬莢・破片・弾薬・小惑星のうち死亡したものを
  // 破棄・除去する。
  cleanup(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3, attractors: readonly Attractor[]): void {
    for (const e of this.all()) e.checkLoss(dt, simTime, activeStage, playerPos, attractors);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammoPickups);
    this.prune(this.asteroids);
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

  // 過去表示に要る履歴の保持時間 [s] を全エンティティへ要求する。履歴を持たない種別は無視する。
  requestHistoryDuration(sec: number): void {
    for (const e of this.all()) e.requestHistoryDuration(sec);
  }

  // 毎フレーム、全ての機体へ updateControls を1度ずつ通す。操作できるのは操作対象だけで、
  // 操作できないワープ倍率ではどの機体も操作できない — その2つは同じ「操作できない」状態
  // なので、input を渡すかどうかの1つの判断にまとめる。
  updateVessels(
    activeVessel: Vessel | null, input: Input | null, simSpeed: SimSpeedManager,
    dt: number, activeStage: Stage, ephemeris: Ephemeris,
  ): void {
    const operable = simSpeed.canShipAct;
    const simDt = dt * simSpeed.simSpeed;
    for (const vessel of this.vessels) {
      if (!vessel.alive) continue;
      vessel.updateControls(
        vessel === activeVessel && operable ? input : null,
        dt,
        simDt,
        this,
        activeStage,
        ephemeris,
      );
    }
  }

  // 操作できない間、全機体の連続指令(推力・トルク・射撃・噴射ラッチ)を畳む。
  clearTransientCommands(): void {
    for (const vessel of this.vessels) vessel.clearTransientCommands();
  }

  // 全機体のメッシュ・エフェクト・マーカーを同期する。方向マーカーや照準ズームは操作対象だけの
  // ものなので、どれが操作対象かを各機体へ渡す。
  syncVessels(
    activeVessel: Vessel | null, fo: FloatingOrigin, cameraSystem: CameraSystem,
    displayTime: number, ephemeris: Ephemeris, attractors: readonly Attractor[],
    visibilityPolicy: MapVisibilityPolicy | null, displayWindow?: DisplayWindow,
  ): void {
    for (const vessel of this.vessels) {
      if (!vessel.alive) continue;
      const isActive = vessel === activeVessel;
      vessel.syncVessel(
        fo, cameraSystem, displayTime, isActive, ephemeris, attractors,
        visibilityPolicy?.entity(vesselMapKind(vessel), isActive) ?? null, displayWindow,
      );
    }
  }

  // 天体クラス別トグルに応じて機体・弾薬のメッシュ表示を揃える。visibilityPolicy が
  // null(戦闘ビュー)のときは非表示扱いを一切かけない。
  applyVisibility(visibilityPolicy: MapVisibilityPolicy | null, activeVessel: Vessel | null): void {
    if (!visibilityPolicy) return;
    for (const vessel of this.vessels) {
      if (!visibilityPolicy.entity(vesselMapKind(vessel), vessel === activeVessel).category) {
        vessel.renderObject.visible = false;
      }
    }
    for (const ammoPickup of this.ammoPickups) {
      if (!visibilityPolicy.entity('ammo').category) ammoPickup.renderObject.visible = false;
    }
  }

  // マップ表示中だけ、全基地の赤道交点マーカーを求め直す(戦闘ビューでは誰も読まない)。基地は
  // 常設の軌道構造物で、接近・ドッキングは軌道面合わせそのものなので、選択の有無に関わらず出す。
  updateBaseEquatorNodes(overviewMode: boolean, displayWindow: DisplayWindow, ephemeris: Ephemeris): void {
    if (!overviewMode) return;
    for (const base of this.baseVessels()) {
      if (base.alive) base.equatorNodes?.update(displayWindow.frame, displayWindow.displayTime, ephemeris);
    }
  }

  // このフレームに求まった赤道交点マーカーを置く。求め直されなかったものは自動的に隠れる。
  syncEquatorNodes(cameraSystem: CameraSystem): void {
    const project = cameraSystem.activeCameraProjection;
    const overviewMode = cameraSystem.overviewMode;
    const cameraPos = cameraSystem.activeCameraPos;
    for (const e of this.all()) e.equatorNodes?.sync(project, overviewMode, cameraPos);
  }

  // 弾薬・基地の位置マーカーを displayTime の位置へ置く。ラベルの距離は viewerPos 基準で、
  // 艦が1隻も無い間は距離を添えない。
  syncMarkers(
    cameraSystem: CameraSystem, displayTime: number, viewerPos: Vec3 | null,
    attractors: readonly Attractor[], visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const project = cameraSystem.activeCameraProjection;
    const scale = cameraSystem.activeCameraScale;
    const overviewMode = cameraSystem.overviewMode;
    const visibilityOf = (kind: 'ammo' | 'base'): MapVisibility | null =>
      (overviewMode ? visibilityPolicy?.entity(kind) ?? null : null);
    for (const ammoPickup of this.ammoPickups) {
      ammoPickup.marker?.sync(project, scale, displayTime, overviewMode, cameraSystem.activeCameraPos, viewerPos, attractors, visibilityOf('ammo'));
    }
  }

  // 機体を除くエンティティのメッシュを displayTime 時点の状態へ同期する。弾本体・弾ハロー・
  // プラズマ弾・薬莢・破片は、同期した renderObject を InstancedPool へ積んで描画をまとめる。
  sync(fo: FloatingOrigin, displayTime: number): void {
    for (const e of this.otherEntities()) e.sync(fo, displayTime);

    this.bulletBodyPool.beginFrame();
    this.bulletHaloPool.beginFrame();
    this.plasmaPool.beginFrame();
    this.casingPool.beginFrame();
    for (const pool of this.debrisFragmentPools) pool.beginFrame();
    for (const b of this.bullets) {
      if (!b.renderObject.visible) continue;
      if (b.type === 'plasma') {
        this.plasmaPool.push(b.renderObject);
        continue;
      }
      // 本体+ハローの Group。シーン外なので matrixWorld は自前で更新する必要があり、
      // 親で1回呼べば子(本体・ハロー)まで連鎖して更新される。
      b.renderObject.updateMatrixWorld();
      this.bulletBodyPool.push(b.renderObject.children[0]!);
      this.bulletHaloPool.push(b.renderObject.children[1]!);
    }
    for (const c of this.casings) this.casingPool.push(c.renderObject);
    for (const d of this.debris) {
      if (d.kind === 'fragment') this.debrisFragmentPools[d.fragmentVariant]!.push(d.renderObject, d.fragmentColor!);
    }
    this.bulletBodyPool.endFrame();
    this.bulletHaloPool.endFrame();
    this.plasmaPool.endFrame();
    this.casingPool.endFrame();
    for (const pool of this.debrisFragmentPools) pool.endFrame();
  }

  // 保持する全エンティティと描画資源プールを破棄する。cleanup/prune は死亡した
  // エンティティしか片付けないため、生存中のまま呼ばれるケースをここで担う。
  dispose(): void {
    this.disposeAll(this.vessels);
    this.disposeAll(this.bullets);
    this.disposeAll(this.casings);
    this.disposeAll(this.debris);
    this.disposeAll(this.ammoPickups);
    this.disposeAll(this.asteroids);

    this.bulletBodyPool.dispose();
    this.bulletHaloPool.dispose();
    this.plasmaPool.dispose();
    this.casingPool.dispose();
    for (const pool of this.debrisFragmentPools) pool.dispose();

    this.effects.dispose();
    this.invalidateCaches();
  }

  // 配列内の各エンティティを破棄したうえで、配列自体も空にする。
  private disposeAll<T extends GameEntity>(arr: T[]): void {
    for (const e of arr) e.dispose();
    arr.length = 0;
  }

  // 負荷確認ウィンドウが読む、保持配列ごとの現在の個体数。
  perfCounts(): Pick<PerfCounts, 'players' | 'enemies' | 'bullets' | 'casings' | 'debris' | 'ammoPickups' | 'asteroids' | 'bases'> {
    return {
      players: this.ownShips().length,
      enemies: this.hostileVessels().length,
      bullets: this.bullets.length,
      casings: this.casings.length,
      debris: this.debris.length,
      ammoPickups: this.ammoPickups.length,
      asteroids: this.asteroids.length,
      bases: this.baseVessels().length,
    };
  }
}
