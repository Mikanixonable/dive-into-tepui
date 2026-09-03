// エンティティの保持・追加・上限管理・寿命回収・描画同期。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../math/vec3';
import type { Viewpoint } from '../../math/projection';
import { CelestialMotion } from '../../physics/celestial-motion';
import type { FrameAnchorSource } from '../../physics/frame';
import { FloatingOrigin } from '../camera/floating-origin';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { CapKind } from './dynamic-entity/entity-kind';
import { AmmoPickup } from './dynamic-entity/ammo-pickup';
import { RcsFuelPickup } from './dynamic-entity/rcs-fuel-pickup';
import { DebrisPiece } from './dynamic-entity/debris-piece';
import { Enemy } from './dynamic-entity/enemy';
import { findEnemyClass } from './dynamic-entity/enemy-dictionary';
import { ProteinEnemy } from './dynamic-entity/protein-enemy';
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

// 枠ごとに同時に存在してよい個体数。超えた分はその枠の古いものから落ちる。
const CAP: Record<CapKind, number> = {
  bullet: 1200,
  casing: 260,
  debris: 600,
  booster: 64,
};

export class DynamicSystem {
  // 保持する全エンティティを追加順に並べた、顔ぶれの正本。枠ごとの上限はこの並びから導く。
  private readonly entities: DynamicEntity[] = [];

  // 型別の絞り込み。呼ぶたびに数え直すので、フレームに何度も読む側は受けた配列を持ち回る。

  // 自機。操作対象(Game.player)も他の艦と対等に、積分・衝突・寿命判定・予測を通る。
  // ステージモードでは1隻だけが入る。
  get players(): readonly Player[] { return this.entities.filter((e): e is Player => e instanceof Player); }
  get enemies(): readonly Enemy[] { return this.entities.filter((e): e is Enemy => e instanceof Enemy); }
  get bases(): readonly Base[] { return this.entities.filter((e): e is Base => e instanceof Base); }
  get bullets(): readonly Bullet[] { return this.entities.filter((e): e is Bullet => e instanceof Bullet); }
  get ammoPickups(): readonly AmmoPickup[] { return this.entities.filter((e): e is AmmoPickup => e instanceof AmmoPickup); }
  get rcsFuelPickups(): readonly RcsFuelPickup[] { return this.entities.filter((e): e is RcsFuelPickup => e instanceof RcsFuelPickup); }
  get detachedBoosters(): readonly DetachedBooster[] { return this.entities.filter((e): e is DetachedBooster => e instanceof DetachedBooster); }

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
    this.bulletBodyPool = new InstancedPool(scene, bulletBody.geometry, bulletBody.material, CAP.bullet);
    this.bulletHaloPool = new InstancedPool(scene, bulletHalo.geometry, bulletHalo.material, CAP.bullet);
    this.plasmaPool = new InstancedPool(scene, plasmaBody.geometry, plasmaBody.material, CAP.bullet);
    this.casingPool = new InstancedPool(
      scene, casingBody.geometry, casingBody.material, CAP.casing, false, 0, true);
    this.debrisFragmentPools = debrisFragment.geometries.map(
      (geo) => new InstancedPool(scene, geo, debrisFragment.material, CAP.debris, true, 0, true));
    this.effects = new EffectsSystem(scene, this, worldSfx);
    if (saved) this.restoreFromSave(saved, hud, worldSfx, scene, markerManager);
  }

  // スナップショットから自機・敵・弾薬・RCS燃料・基地を復元する。
  private restoreFromSave(
    save: GameSaveData, hud: Hud, worldSfx: WorldSfx, scene: THREE.Scene, markerManager: MarkerManager,
  ): void {
    const simTime = save.simTime;
    for (const data of save.players) {
      this.add(new Player(hud, worldSfx, scene, this.effects, markerManager, { saved: data, simTime }));
    }
    for (const data of save.enemies) {
      // 種別タグから具象クラスを引き、知らない種別の敵は読み飛ばす。
      const enemyClass = findEnemyClass(data.kind);
      if (enemyClass === null) continue;
      this.spawnEnemyWhenReady(
        enemyClass.pendingAssetId(data),
        () => new enemyClass({ saved: data, simTime }, worldSfx, this.effects, scene),
      );
    }
    for (const data of save.ammoPickups) {
      this.add(new AmmoPickup({ saved: data, simTime }, scene));
    }
    for (const data of save.rcsFuelPickups ?? []) {
      this.add(new RcsFuelPickup({ saved: data, simTime }, scene));
    }
    for (const data of save.detachedBoosters ?? []) {
      this.add(new DetachedBooster({ saved: data, simTime }, scene));
    }
    for (const data of save.bases) {
      this.add(new Base({ saved: data, simTime }, scene, hud, worldSfx, this.effects, markerManager));
    }
  }

  private _collectionRevision = 0;
  private combatTargetsRevision = -1;

  // 保持するエンティティの顔ぶれの世代。追加・除去・prune のいずれでも増える。
  get collectionRevision(): number {
    return this._collectionRevision;
  }

  private readonly cachedCombatTargets: CombatTarget[] = [];
  private readonly cachedCombatTargetsByExcludedPlayer = new Map<Player, CombatTarget[]>();

  // エンティティを登録する。上限を持つ枠の超過分は、次の cleanup で古いものから落ちる。
  add(entity: DynamicEntity): void {
    this.entities.push(entity);
    if (entity.capKind !== null) this.capsUncheckedSinceAdd = true;
    this.invalidateCaches();
  }

  // 生成に fetch 未完了のタンパク質アセットが要る敵は、準備が整うまで実体化(Enemy の
  // 生成そのもの)を遅らせる。SPEC/PROTEIN.md「出現」節: 準備中はentities.enemies は
  // もちろん保有しない。通常スポーン・セーブ復元の双方がここを通る。
  private readonly pendingEnemySpawns: { readonly assetId: ProteinAssetId; readonly build: () => Enemy; readonly onSpawned?: () => void }[] = [];

  spawnEnemyWhenReady(assetId: ProteinAssetId | null, build: () => Enemy, onSpawned?: () => void): void {
    if (assetId === null || isProteinAssetReady(assetId)) {
      this.add(build());
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
        this.add(pending.build());
        pending.onSpawned?.();
      } else {
        this.pendingEnemySpawns[w++] = pending;
      }
    }
    this.pendingEnemySpawns.length = w;
  }

  // エンティティを取り除き、メッシュを破棄する。
  remove(entity: DynamicEntity): void {
    if (!this.detach(entity)) return;
    entity.dispose();
  }

  // 艦を取り除くが破棄はしない(基地への収容など、後で add で復帰させる場合)。
  // 顔ぶれから外れると毎フレームの同期が届かなくなるので、マーカーはここで畳む。
  park(entity: DynamicEntity): void {
    if (!this.detach(entity)) return;
    entity.equatorNodes?.dispose();
    entity.equatorNodes = null;
  }

  // 顔ぶれから外す。保持していなければ false。
  private detach(entity: DynamicEntity): boolean {
    const i = this.entities.indexOf(entity);
    if (i < 0) return false;
    this.entities.splice(i, 1);
    this.invalidateCaches();
    return true;
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

  // 上限付きの個体が追加されてから、まだ上限を確かめていないか。追加以外で枠が増えることは
  // ないので、これが false の間は全件を数え直さない。
  private capsUncheckedSinceAdd = false;

  // 上限を超えた個体を、枠ごとに古いものから落とす。配列は追加順なので、末尾から数えて上限を
  // 超えたところがその枠の最古になる。
  // ここで演出を起こすと、1体落とすたびに新しい個体が生まれて上限が発振する。
  private enforceCaps(): void {
    if (!this.capsUncheckedSinceAdd) return;
    this.capsUncheckedSinceAdd = false;
    const live: Record<CapKind, number> = { bullet: 0, casing: 0, debris: 0, booster: 0 };
    const entities = this.all();
    for (let i = entities.length - 1; i >= 0; i--) {
      const entity = entities[i]!;
      const cap = entity.capKind;
      if (cap === null || !entity.alive) continue;
      const rank = live[cap] + 1;
      live[cap] = rank;
      if (rank > CAP[cap]) entity.alive = false;
    }
  }

  private invalidateCaches(): void {
    this._collectionRevision++;
  }

  // 保持する全エンティティを追加順に返す。呼び出し側は読み取り専用として扱う。
  all(): readonly DynamicEntity[] {
    return this.entities;
  }

  // 全エンティティの寿命判定と上限判定を行い、死亡したものを破棄・除去する。自機だけは各所の
  // 参照掃除と次艦への引き継ぎが要るため、除去は ActivePlayerController.reclaimDead が担う。
  cleanup(
    dt: number, simTime: number, activeStage: Stage, playerPos: Vec3,
    atmosphereBodies: readonly CelestialMotion[],
  ): void {
    this.processPendingEnemySpawns();
    // 判定は開始時の顔ぶれに対して行う。死の演出が破片を足すので、生配列を反復すると
    // 生まれたばかりの個体まで同じパスで判定してしまい、生成が連鎖すれば終わらなくなる。
    for (let i = 0, n = this.entities.length; i < n; i++) {
      this.entities[i]!.checkLoss(dt, simTime, activeStage, playerPos, atmosphereBodies);
    }
    this.enforceCaps();
    this.prune();
  }

  // 死亡した個体を破棄して取り除く。生存分は追加順のまま前へ詰める。所有者が回収する種別は
  // 死亡していても残す。
  private prune(): void {
    let w = 0;
    let changed = false;
    for (const x of this.entities) {
      if (!x.alive && !x.reclaimedByOwner) {
        x.dispose();
        changed = true;
      }
      else this.entities[w++] = x;
    }
    this.entities.length = w;
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
    const categoryVisible = visibilityPolicy?.entity('enemy').category ?? true;
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
    for (const enemy of this.enemies) if (!visibilityPolicy.entity('enemy').category) enemy.renderObject.visible = false;
    for (const ammoPickup of this.ammoPickups) {
      if (!visibilityPolicy.entity('ammo').category) ammoPickup.renderObject.visible = false;
    }
    for (const pickup of this.rcsFuelPickups) {
      if (!visibilityPolicy.entity('fuel').category) pickup.renderObject.visible = false;
    }
    // TODO: 分離ブースターは自機由来なのに敵トグルへ従っている。妥当なトグルを決めて直す。
    for (const booster of this.detachedBoosters) {
      if (!visibilityPolicy.entity('enemy').category) booster.renderObject.visible = false;
    }
    for (const base of this.bases) if (!visibilityPolicy.entity('base').category) base.renderObject.visible = false;
  }

  // 全基地の赤道交点マーカーを求め直す。基地は常設の軌道構造物で、接近・ドッキングは
  // 軌道面合わせそのものなので、選択の有無に関わらず出す。
  updateBaseEquatorNodes(
    displayWindow: DisplayWindow, celestialSystem: CelestialSystem, frameAnchors: FrameAnchorSource,
  ): void {
    const timeLabel = timeLabelSettingOf(displayWindow);
    for (const base of this.bases) {
      if (base.alive) base.equatorNodes?.updateOnEllipse(displayWindow.displayTime, celestialSystem, frameAnchors, timeLabel);
    }
  }

  // このフレームに求まった赤道交点マーカーを置く。求め直されなかったものは自動的に隠れる。
  syncEquatorNodes(cameraSystem: CameraSystem): void {
    const project = cameraSystem.activeCameraProjection;
    const cameraPos = cameraSystem.activeCameraPos;
    for (const e of this.all()) e.equatorNodes?.sync(project, cameraPos);
  }

  // 自機以外のメッシュを displayTime 時点の状態に同期する。自機はエフェクト・ベルト・
  // 軌道線まで持つので Player.syncPlayer が担当する。弾本体・弾ハロー・プラズマ弾・薬莢・
  // 破片(fragment)の変換は各エンティティの renderObject に同期された後、InstancedPool へ push する。
  sync(fo: FloatingOrigin, displayTime: number, viewer?: Viewpoint, proteinVibrationEnabled = true): void {
    this.bulletBodyPool.beginFrame();
    this.bulletHaloPool.beginFrame();
    this.plasmaPool.beginFrame();
    this.casingPool.beginFrame();
    for (const pool of this.debrisFragmentPools) pool.beginFrame();

    // 自機と分離ブースターは専用の同期パス(syncPlayers / syncDetachedBoosters)を持つ。
    for (const e of this.entities) {
      if (e instanceof Player || e instanceof DetachedBooster) continue;
      e.sync(fo, displayTime, viewer, proteinVibrationEnabled);
      if (e instanceof Bullet) this.pushBullet(e);
      else if (e instanceof DebrisPiece) this.pushDebrisPiece(e);
    }

    this.bulletBodyPool.endFrame();
    this.bulletHaloPool.endFrame();
    this.plasmaPool.endFrame();
    this.casingPool.endFrame();
    for (const pool of this.debrisFragmentPools) pool.endFrame();
  }

  // 弾種に対応するプールへ、同期済みの変換を積む。
  private pushBullet(bullet: Bullet): void {
    if (!bullet.renderObject.visible) return;
    if (bullet.type === 'plasma') {
      this.plasmaPool.push(bullet.renderObject);
      return;
    }
    // 本体+ハローの Group。シーン外なので matrixWorld は自前で更新する必要があり、
    // 親で1回呼べば子(本体・ハロー)まで連鎖して更新される。
    bullet.renderObject.updateMatrixWorld();
    this.bulletBodyPool.push(bullet.renderObject.children[0]!);
    this.bulletHaloPool.push(bullet.renderObject.children[1]!);
  }

  // 薬莢と破片(fragment)を、対応するプールへ積む。他の破片は個別に scene へ載っている。
  private pushDebrisPiece(piece: DebrisPiece): void {
    if (piece.kind === 'casing') this.casingPool.push(piece.renderObject);
    else if (piece.kind === 'fragment') {
      this.debrisFragmentPools[piece.fragmentVariant]!.push(piece.renderObject, piece.fragmentColor!);
    }
  }

  // 保持する全エンティティと描画資源プールを破棄する。cleanup/prune は死亡した
  // エンティティしか片付けないため、生存中のまま呼ばれるケースをここで担う。
  dispose(): void {
    for (const e of this.entities) e.dispose();
    this.entities.length = 0;

    this.bulletBodyPool.dispose();
    this.bulletHaloPool.dispose();
    this.plasmaPool.dispose();
    this.casingPool.dispose();
    for (const pool of this.debrisFragmentPools) pool.dispose();

    this.effects.dispose();
    this.invalidateCaches();
  }

  // 負荷確認ウィンドウが読む、種別ごとの現在の個体数。
  perfCounts(): Pick<PerfCounts, 'players' | 'enemies' | 'bullets' | 'casings' | 'debris' | 'ammoPickups' | 'rcsFuelPickups' | 'bases'> {
    const counts = {
      players: 0, enemies: 0, bullets: 0, casings: 0,
      debris: 0, ammoPickups: 0, rcsFuelPickups: 0, bases: 0,
    };
    for (const e of this.entities) {
      if (e instanceof Player) counts.players++;
      else if (e instanceof Enemy) counts.enemies++;
      else if (e instanceof Bullet) counts.bullets++;
      else if (e instanceof DebrisPiece) (e.kind === 'casing' ? counts.casings++ : counts.debris++);
      else if (e instanceof AmmoPickup) counts.ammoPickups++;
      else if (e instanceof RcsFuelPickup) counts.rcsFuelPickups++;
      else if (e instanceof Base) counts.bases++;
    }
    return counts;
  }

  // 負荷確認ウィンドウが読む、直近 sync() 時点のタンパク質敵モーションの集計値。
  proteinMotionFrameSample(): ProteinMotionFrameSample {
    let cpuMs = 0;
    let uploadBytes = 0;
    const lodCounts: Partial<Record<ProteinMotionLod, number>> = {};
    for (const enemy of this.enemies) {
      if (!(enemy instanceof ProteinEnemy)) continue;
      const metrics = enemy.motionMetrics;
      cpuMs += metrics.cpuMs;
      uploadBytes += metrics.uploadBytes;
      lodCounts[metrics.lod] = (lodCounts[metrics.lod] ?? 0) + 1;
    }
    return { cpuMs, uploadBytes, lodCounts };
  }
}
