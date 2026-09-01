// エンティティ配列の保持・追加・上限管理・寿命回収・描画同期。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../math/vec3';
import type { Viewpoint } from '../../math/projection';
import { CelestialMotion } from '../../physics/celestial-motion';
import type { FrameAnchorSource } from '../../physics/frame';
import { FloatingOrigin } from '../camera/floating-origin';
import * as C from '../const';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import { AmmoPickup } from './dynamic-entity/ammo-pickup';
import { RcsFuelPickup } from './dynamic-entity/rcs-fuel-pickup';
import { DebrisPiece } from './dynamic-entity/debris-piece';
import { Enemy, proteinAssetIdForEnemyKind } from './dynamic-entity/enemy';
import { isProteinAssetReady, type ProteinAssetId } from '../protein/protein-asset-loader';
import { Bullet } from './dynamic-entity/bullet';
import { Base } from './dynamic-entity/base';
import { DetachedBooster } from './dynamic-entity/detached-booster';
import { InstancedPool } from '../../render/instanced-pool';
import { bulletBodyResources, bulletHaloResources, plasmaBodyResources, casingBodyResources, debrisFragmentResources } from '../../render/ships';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { Input } from '../input/input';
import type { CombatTarget } from '../targeter';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CameraSystem } from '../camera/camera-system';
import type { RenderStyle } from '../../render/render-style';
import type { CelestialSystem } from '../celestial/celestial-system';
import { DisplayWindow, timeLabelSettingOf } from '../display-window-manager';
import type { GameSaveData } from '../save/save-data';
import type { Hud } from '../hud/hud';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { PerfCounts } from '../../perf-meter';
import type { OrbitReference } from '../orbit-reference';
import type { ProteinMotionFrameSample, ProteinMotionLod } from '../../protein-motion-metrics';

const MAX_DETACHED_BOOSTERS = 64;

const MAX_DEBRIS = 600;

export class DynamicSystem {
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly casings: DebrisPiece[] = [];
  readonly debris: DebrisPiece[] = [];
  public readonly ammoPickups: AmmoPickup[] = [];
  public readonly rcsFuelPickups: RcsFuelPickup[] = [];
  readonly detachedBoosters: DetachedBooster[] = [];
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

  // 描画資源のプールを組み、演出窓口を作ってから、saved があればその顔ぶれを復元する。
  constructor(
    scene: THREE.Scene,
    hud: Hud,
    worldSfx: WorldSfx,
    markerManager: MarkerManager,
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
    this.casingPool = new InstancedPool(
      scene, casingBody.geometry, casingBody.material, C.MAX_CASINGS, false, 0, true);
    this.debrisFragmentPools = debrisFragment.geometries.map(
      (geo) => new InstancedPool(scene, geo, debrisFragment.material, MAX_DEBRIS, true, 0, true));
    this.effects = new EffectsSystem(scene, this, worldSfx);
    if (saved) this.restoreFromSave(saved, hud, worldSfx, scene, markerManager);
  }

  // スナップショットから自機・敵・弾薬・RCS燃料・基地を復元する。
  private restoreFromSave(
    save: GameSaveData, hud: Hud, worldSfx: WorldSfx, scene: THREE.Scene, markerManager: MarkerManager,
  ): void {
    const simTime = save.simTime;
    for (const data of save.players) {
      this.addPlayer(new Player(hud, worldSfx, scene, this.effects, markerManager, { saved: data, simTime }));
    }
    for (const data of save.enemies) {
      this.spawnEnemyWhenReady(
        proteinAssetIdForEnemyKind(data.enemyKind),
        () => new Enemy({ saved: data, simTime }, worldSfx, this.effects, scene),
      );
    }
    for (const data of save.ammoPickups) {
      this.addAmmoPickup(new AmmoPickup({ saved: data, simTime }, scene));
    }
    for (const data of save.rcsFuelPickups ?? []) {
      this.addRcsFuelPickup(new RcsFuelPickup({ saved: data, simTime }, scene));
    }
    for (const data of save.detachedBoosters ?? []) {
      this.addDetachedBooster(new DetachedBooster({ saved: data, simTime }, scene));
    }
    for (const data of save.bases) {
      this.addBase(new Base({ saved: data, simTime }, scene, hud, worldSfx, this.effects, markerManager));
    }
  }

  // all()/otherEntities() はSimulatorの各substepから何度も呼ばれる。配列の内容が変わった
  // ときだけ結合し、以降は同じ安定配列を返す。
  private _collectionRevision = 0;
  private cachedRevision = -1;
  private readonly cachedOtherEntities: DynamicEntity[] = [];
  private readonly cachedAllEntities: DynamicEntity[] = [];
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

  // 生成に fetch 未完了のタンパク質アセットが要る敵は、準備が整うまで実体化(Enemy の
  // 生成そのもの)を遅らせる。SPEC/PROTEIN.md「出現」節: 準備中はentities.enemies は
  // もちろん保有しない。通常スポーン・セーブ復元の双方がここを通る。
  private readonly pendingEnemySpawns: { readonly assetId: ProteinAssetId; readonly build: () => Enemy; readonly onSpawned?: () => void }[] = [];

  spawnEnemyWhenReady(assetId: ProteinAssetId | null, build: () => Enemy, onSpawned?: () => void): void {
    if (assetId === null || isProteinAssetReady(assetId)) {
      this.addEnemy(build());
      onSpawned?.();
      return;
    }
    this.pendingEnemySpawns.push({ assetId, build, onSpawned });
  }

  private processPendingEnemySpawns(): void {
    if (this.pendingEnemySpawns.length === 0) return;
    let w = 0;
    for (const pending of this.pendingEnemySpawns) {
      if (isProteinAssetReady(pending.assetId)) {
        this.addEnemy(pending.build());
        pending.onSpawned?.();
      } else {
        this.pendingEnemySpawns[w++] = pending;
      }
    }
    this.pendingEnemySpawns.length = w;
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
    for (const base of this.bases) targets.push(base);
    this.cachedCombatTargetsByExcludedPlayer.set(excludePlayer, targets);
    return targets;
  }

  private rebuildCombatTargetsIfNeeded(): void {
    if (this.combatTargetsRevision === this._collectionRevision) return;
    this.cachedCombatTargets.length = 0;
    this.cachedCombatTargets.push(...this.enemies, ...this.players, ...this.bases);
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

  // id で名指しされた、生存中の戦闘対象(敵・自機・基地)を返す。天体・ラグランジュ点は
  // 実体を持たないため対象外。
  findAliveCombatTarget(id: string): CombatTarget | null {
    const enemy = this.findEnemy(id);
    return (enemy?.alive ? enemy : null)
      ?? this.findPlayer(id)
      ?? this.bases.find((b) => b.id === id && b.alive)
      ?? null;
  }

  // 弾を登録する。上限を超えた分は古いものから破棄する。
  addBullet(bullet: Bullet): void {
    this.addCapped(this.bullets, bullet, C.MAX_BULLETS * 3);
  }

  // 破片を種別(薬莢/その他)ごとの配列へ登録する。上限を超えた分は古いものから破棄する。
  addDebris(piece: DebrisPiece): void {
    if (piece.kind === 'casing') this.addCapped(this.casings, piece, C.MAX_CASINGS);
    else this.addCapped(this.debris, piece, MAX_DEBRIS);
  }

  // 弾薬ピックアップを登録する。
  public addAmmoPickup(ammoPickup: AmmoPickup): void {
    this.ammoPickups.push(ammoPickup);
    this.invalidateCaches();
  }

  // RCS燃料ピックアップを登録する。
  public addRcsFuelPickup(pickup: RcsFuelPickup): void {
    this.rcsFuelPickups.push(pickup);
    this.invalidateCaches();
  }

  // 分離済みブースターを登録する。古いものから上限回収し、無制限に残骸を増やさない。
  addDetachedBooster(booster: DetachedBooster): void {
    this.addCapped(this.detachedBoosters, booster, MAX_DETACHED_BOOSTERS);
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
  private addCapped<T extends DynamicEntity>(arr: T[], entity: T, cap: number): void {
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
      ...this.ammoPickups,
      ...this.rcsFuelPickups,
      ...this.detachedBoosters,
      ...this.casings,
      ...this.debris,
      ...this.bases,
    );
    this.cachedAllEntities.length = 0;
    this.cachedAllEntities.push(...this.cachedOtherEntities, ...this.players);
    this.cachedRevision = this._collectionRevision;
  }

  // 自機以外の保持エンティティを1つの配列にまとめて返す。
  private otherEntities(): DynamicEntity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedOtherEntities;
  }

  // 保持する全エンティティを1つの配列にまとめて返す。
  all(): DynamicEntity[] {
    this.rebuildCachesIfNeeded();
    return this.cachedAllEntities;
  }

  // 全エンティティの寿命判定を行い、死亡したものを破棄・除去する。自機だけは各所の参照掃除と
  // 次艦への引き継ぎが要るため、除去は ActivePlayerController.reclaimDead が担う。
  cleanup(
    dt: number, simTime: number, activeStage: Stage, playerPos: Vec3,
    atmosphereBodies: readonly CelestialMotion[],
  ): void {
    this.processPendingEnemySpawns();
    for (const e of this.all()) e.checkLoss(dt, simTime, activeStage, playerPos, atmosphereBodies);
    this.prune(this.enemies);
    this.prune(this.bullets);
    this.prune(this.casings);
    this.prune(this.debris);
    this.prune(this.ammoPickups);
    this.prune(this.rcsFuelPickups);
    this.prune(this.detachedBoosters);
    this.prune(this.bases);
  }

  // in-place フィルタ: 配列の参照はそのまま保つ。
  private prune<T extends DynamicEntity>(arr: T[]): void {
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

  // 毎フレーム、全ての自機へ updatePlayerControls を1度ずつ通す。操作できるのは操作対象艦だけで、
  // 操作できないワープ倍率ではどの艦も操作できない — その2つは同じ「操作できない」状態なので、
  // input を渡すかどうかの1つの判断にまとめる。
  updatePlayers(
    activePlayer: Player | null, input: Input | null, operable: boolean,
    dt: number, simDt: number, activeStage: Stage, celestialSystem: CelestialSystem,
  ): void {
    for (const booster of this.detachedBoosters) if (booster.alive) booster.updateBurn(simDt);
    for (const ship of this.players) {
      ship.updatePlayerControls(
        ship === activePlayer && operable ? input : null,
        dt,
        simDt,
        this,
        activeStage,
        celestialSystem,
      );
    }
  }

  // 毎フレーム、操作対象の基地へ updateBaseControls を1度ずつ通す。
  // 操作対象でない基地は clearTransientCommands で慣性飛行に戻る。
  updateBases(
    controlledBase: Base | null, input: Input, operable: boolean, dt: number, simDt: number,
  ): void {
    for (const base of this.bases) {
      if (!base.alive) continue;
      base.updateBaseControls(
        base === controlledBase && operable ? input : null,
        dt,
        simDt,
      );
    }
  }

  // 操作できない間、全自機・操作中基地の連続指令(推力・トルク・射撃・噴射ラッチ)を畳む。
  clearTransientCommands(): void {
    for (const ship of this.players) ship.clearTransientCommands();
    for (const base of this.bases) base.clearTransientCommands();
  }

  // 全自機のメッシュ・エフェクト・マーカーを同期する。方向マーカーや照準ズームは操作艦だけの
  // ものなので、どれが操作対象かを各艦へ渡す。
  syncPlayers(
    activePlayer: Player | null, fo: FloatingOrigin, cameraSystem: CameraSystem,
    displayTime: number, style: RenderStyle, visibilityPolicy: MapVisibilityPolicy | null, orbitRef?: OrbitReference,
  ): void {
    for (const ship of this.players) {
      ship.syncPlayer(
        fo, cameraSystem, displayTime, ship === activePlayer, style,
        visibilityPolicy?.entity('player', ship === activePlayer) ?? null, orbitRef,
      );
    }
  }

  // 分離済みブースターは通常メッシュに加えて個別ノズル位置のプルームも同期する。
  syncDetachedBoosters(
    fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number, style: RenderStyle,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const categoryVisible = visibilityPolicy?.entity('ship').category ?? true;
    for (const booster of this.detachedBoosters) {
      booster.syncBooster(fo, displayTime, cameraSystem, categoryVisible, style);
    }
  }

  // 全基地のメッシュ・エフェクト(推力プルーム・RCS音・パフ)を同期する。
  syncBases(
    controlledBase: Base | null, fo: FloatingOrigin, cameraSystem: CameraSystem,
    displayTime: number, style: RenderStyle, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    for (const base of this.bases) {
      if (!base.alive) continue;
      base.syncBase(
        fo, cameraSystem, displayTime, base === controlledBase, style,
        visibilityPolicy?.entity('base') ?? null,
      );
    }
  }

  // 天体クラス別トグルに応じて自機・敵・弾薬・基地のメッシュ表示を揃える。visibilityPolicy が
  // null(戦闘ビュー)のときは非表示扱いを一切かけない。
  applyVisibility(visibilityPolicy: MapVisibilityPolicy | null, activePlayer: Player | null): void {
    if (!visibilityPolicy) return;
    for (const ship of this.players) if (!visibilityPolicy.entity('player', ship === activePlayer).category) ship.renderObject.visible = false;
    for (const enemy of this.enemies) if (!visibilityPolicy.entity('ship').category) enemy.renderObject.visible = false;
    for (const ammoPickup of this.ammoPickups) {
      if (!visibilityPolicy.entity('ammo').category) ammoPickup.renderObject.visible = false;
    }
    for (const pickup of this.rcsFuelPickups) {
      if (!visibilityPolicy.entity('fuel').category) pickup.renderObject.visible = false;
    }
    for (const booster of this.detachedBoosters) {
      if (!visibilityPolicy.entity('ship').category) booster.renderObject.visible = false;
    }
    for (const base of this.bases) if (!visibilityPolicy.entity('base').category) base.renderObject.visible = false;
  }

  // マップ表示中だけ、全基地の赤道交点マーカーを求め直す(戦闘ビューでは誰も読まない)。基地は
  // 常設の軌道構造物で、接近・ドッキングは軌道面合わせそのものなので、選択の有無に関わらず出す。
  updateBaseEquatorNodes(
    overviewMode: boolean, displayWindow: DisplayWindow, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
  ): void {
    if (!overviewMode) return;
    const timeLabel = timeLabelSettingOf(displayWindow);
    for (const base of this.bases) {
      if (base.alive) base.equatorNodes?.updateOnEllipse(displayWindow.displayTime, celestialSystem, frameAnchors, timeLabel);
    }
  }

  // このフレームに求まった赤道交点マーカーを置く。求め直されなかったものは自動的に隠れる。
  syncEquatorNodes(cameraSystem: CameraSystem): void {
    const project = cameraSystem.activeCameraProjection;
    const overviewMode = cameraSystem.overviewMode;
    const cameraPos = cameraSystem.activeCameraPos;
    for (const e of this.all()) e.equatorNodes?.sync(project, overviewMode, cameraPos);
  }

  // 自機以外のメッシュを displayTime 時点の状態に同期する。自機はエフェクト・ベルト・
  // 軌道線まで持つので Player.syncPlayer が担当する。弾本体・弾ハロー・プラズマ弾・薬莢・
  // 破片(fragment)の変換は各エンティティの renderObject に同期された後、InstancedPool へ push する。
  sync(fo: FloatingOrigin, displayTime: number, viewer?: Viewpoint, proteinVibrationEnabled = true): void {
    for (const e of this.otherEntities()) {
      if (!(e instanceof DetachedBooster)) e.sync(fo, displayTime, viewer, proteinVibrationEnabled);
    }

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
    this.disposeAll(this.players);
    this.disposeAll(this.enemies);
    this.disposeAll(this.bullets);
    this.disposeAll(this.casings);
    this.disposeAll(this.debris);
    this.disposeAll(this.ammoPickups);
    this.disposeAll(this.rcsFuelPickups);
    this.disposeAll(this.detachedBoosters);
    this.disposeAll(this.bases);

    this.bulletBodyPool.dispose();
    this.bulletHaloPool.dispose();
    this.plasmaPool.dispose();
    this.casingPool.dispose();
    for (const pool of this.debrisFragmentPools) pool.dispose();

    this.effects.dispose();
    this.invalidateCaches();
  }

  // 配列内の各エンティティを破棄したうえで、配列自体も空にする。
  private disposeAll<T extends DynamicEntity>(arr: T[]): void {
    for (const e of arr) e.dispose();
    arr.length = 0;
  }

  // 負荷確認ウィンドウが読む、保持配列ごとの現在の個体数。
  perfCounts(): Pick<PerfCounts, 'players' | 'enemies' | 'bullets' | 'casings' | 'debris' | 'ammoPickups' | 'rcsFuelPickups' | 'bases'> {
    return {
      players: this.players.length,
      enemies: this.enemies.length,
      bullets: this.bullets.length,
      casings: this.casings.length,
      debris: this.debris.length,
      ammoPickups: this.ammoPickups.length,
      rcsFuelPickups: this.rcsFuelPickups.length,
      bases: this.bases.length,
    };
  }

  // 負荷確認ウィンドウが読む、直近 sync() 時点のタンパク質敵モーションの集計値。
  proteinMotionFrameSample(): ProteinMotionFrameSample {
    let cpuMs = 0;
    let uploadBytes = 0;
    const lodCounts: Partial<Record<ProteinMotionLod, number>> = {};
    for (const enemy of this.enemies) {
      const runtime = enemy.proteinRuntime;
      if (!runtime) continue;
      cpuMs += runtime.cpuMs;
      uploadBytes += runtime.uploadBytes;
      lodCounts[runtime.lod] = (lodCounts[runtime.lod] ?? 0) + 1;
    }
    return { cpuMs, uploadBytes, lodCounts };
  }
}
