// エンティティの保持・追加・上限管理・寿命回収と、1フレームぶんの前進(指令決定と積分)・描画同期。
import * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { DynamicMotion } from './dynamic-motion';
import type { EntityRoster } from './entity-roster';
import type { EntityRegistry, SpawnGate } from './entity-registry';
import { ENTITY_CAP, type CapKind, type EntityCountKind } from './dynamic-entity/entity-kind';
import { isControllable, type Controllable } from './dynamic-entity/controllable';
import { isEnemy } from './dynamic-entity/enemy';
import { isPlayer, Player } from '../player/player';
import { restorationFor } from './dynamic-entity/entity-dictionary';
import { InstancedPools } from '../../render/dynamic/instanced-pools';
import { Simulator } from './simulator';
import { NanWatchdog } from './nan-watchdog';
import { FrameSections, SECTION } from '../frame-sections';
import type { StageOutcome } from '../stages/stage-outcome';
import type { StageSimulationEvents } from '../stages/stage-simulation-events';
import type { Input } from '../../input/input';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { EntityVisualSettings } from '../../render/entity-visual-settings';
import type { RenderStyle } from '../../render/render-style';

import type { EntitySaveDataUnion, GameSaveData } from '../save/save-data';
import type { Notifier } from '../../hud/notifier';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { FlashEffects } from '../vfx/flash-effects';
import type { MarkerSlots } from '../marker/marker-slots';
import type { PerfCounts } from '../perf-counts';
import type { OrbitReference } from '../orbit-reference';

export class DynamicSystem implements EntityRegistry, EntityRoster {
  // 保持する全エンティティを追加順に並べた、顔ぶれの正本。枠ごとの上限はこの並びから導く。
  private readonly entities: DynamicEntity[] = [];

  // 操作されうる個体。呼ぶたびに顔ぶれから数え直すので、フレームに何度も読むなら受けた配列を
  // 持ち回る。
  public get controllables(): readonly Controllable[] { return this.entities.filter(isControllable); }

  // プールで描く種別の描画資源。どの種別がどのプールへ積むかは個体自身が知っている。
  private readonly instancedPools: InstancedPools;

  // 顔ぶれを1フレームずつ進める積分機構。simTime の正本はここが持つ。
  private readonly simulator: Simulator;

  // 個体の状態が非有限値に汚染された瞬間を捕まえる見張り。下の各境界で検査する。
  private readonly nanWatchdog: NanWatchdog;

  // 描画資源のプールと前進の機構を組んでから、saved があればその顔ぶれを復元する。
  constructor(
    scene: THREE.Scene,
    notifier: Notifier,
    worldSfx: WorldSfx,
    flash: FlashEffects,
    markers: MarkerSlots,
    private readonly celestialBodies: CelestialBodies,
    private readonly sections: FrameSections,
    initialSimTime: number,
    saved?: GameSaveData,
  ) {
    this.instancedPools = new InstancedPools(
      scene, ENTITY_CAP.bullet, ENTITY_CAP.casing, ENTITY_CAP.debris);
    this.simulator = new Simulator(this, this, this, celestialBodies, sections, initialSimTime);
    this.nanWatchdog = new NanWatchdog(notifier);
    if (saved) this.restoreFromSave(saved, notifier, worldSfx, flash, scene, markers);
  }

  // スナップショットの顔ぶれを復元する。組み立て方は種別ごとの辞書が答え、知らない種別は
  // 読み飛ばす。
  private restoreFromSave(
    save: GameSaveData, notifier: Notifier, worldSfx: WorldSfx, flash: FlashEffects, scene: THREE.Scene,
    markers: MarkerSlots,
  ): void {
    for (const data of save.entities) {
      const restoration = restorationFor(
        data, save.simTime, scene, notifier, worldSfx, markers, flash);
      if (restoration === null) continue;
      this.spawnWhenReady(restoration.gate, () => restoration.build());
    }
  }

  // 顔ぶれを保存形へ畳む。保存へ載らない種別は落ちる。
  public serialize(): EntitySaveDataUnion[] {
    return this.entities
      .map((e) => e.serialize())
      .filter((data): data is EntitySaveDataUnion => data !== null);
  }

  private _collectionRevision = 0;

  // 保持するエンティティの顔ぶれの世代。追加・除去・prune のいずれでも増える。
  get collectionRevision(): number {
    return this._collectionRevision;
  }

  // エンティティを登録する。上限を持つ枠の超過分は、次の cleanup で古いものから落ちる。
  public add(entity: DynamicEntity): void {
    this.entities.push(entity);
    if (entity.capKind !== null) this.capsUncheckedSinceAdd = true;
    this.bumpCollectionRevision();
  }

  // 実体化に外部資源の取得が要る個体の待ち行列。生成そのものを gate が通るまで遅らせるので、
  // その間その個体は顔ぶれのどこにも現れない。
  private readonly pendingSpawns: {
    readonly gate: SpawnGate;
    readonly build: () => DynamicEntity;
    readonly onSpawned?: () => void;
  }[] = [];

  // 個体を1体足す。gate がまだ通らなければ、通るまで待ち行列へ回す。onSpawned は実体化した
  // 直後に1度だけ呼ぶ。待つものが無ければ gate は null。
  public spawnWhenReady(gate: SpawnGate | null, build: () => DynamicEntity, onSpawned?: () => void): void {
    if (gate === null || gate()) {
      this.add(build());
      onSpawned?.();
      return;
    }
    this.pendingSpawns.push({ gate, build, onSpawned });
  }

  // 待ち行列のうち、gate が通ったものを実体化して顔ぶれへ足す。
  private processPendingSpawns(): void {
    if (this.pendingSpawns.length === 0) return;
    let w = 0;
    // 通らなかったものは前へ詰めて待ち行列に残す。
    for (const pending of this.pendingSpawns) {
      if (pending.gate()) {
        this.add(pending.build());
        pending.onSpawned?.();
      } else {
        this.pendingSpawns[w++] = pending;
      }
    }
    this.pendingSpawns.length = w;
  }

  // エンティティを取り除き、メッシュを破棄する。
  public remove(entity: DynamicEntity): void {
    if (!this.detach(entity)) return;
    entity.dispose();
  }

  // 顔ぶれから外す。保持していなければ false。
  private detach(entity: DynamicEntity): boolean {
    const i = this.entities.indexOf(entity);
    if (i < 0) return false;
    this.entities.splice(i, 1);
    this.bumpCollectionRevision();
    return true;
  }

  // 上限付きの個体が追加されてから、まだ上限を確かめていないか。枠が増えるのは追加のときだけ
  // なので、走査はこれが立っている間に限れる。
  private capsUncheckedSinceAdd = false;

  // 上限を超えた個体を、枠ごとに古いものから落とす。配列は追加順なので、末尾から数えて上限を
  // 超えたところがその枠の最古になる。
  private enforceCaps(): void {
    if (!this.capsUncheckedSinceAdd) return;
    this.capsUncheckedSinceAdd = false;
    // 落とすのは alive を下ろすところまで — ここで演出を起こすと、破片が生まれて上限が発振する。
    const live: Record<CapKind, number> = { bullet: 0, casing: 0, debris: 0, booster: 0 };
    const entities = this.all();
    for (let i = entities.length - 1; i >= 0; i--) {
      const entity = entities[i]!;
      const cap = entity.capKind;
      if (cap === null || !entity.motion.alive) continue;
      const rank = live[cap] + 1;
      live[cap] = rank;
      if (rank > ENTITY_CAP[cap]) entity.motion.alive = false;
    }
  }

  // 顔ぶれが変わったことを世代へ記録する。
  private bumpCollectionRevision(): void {
    this._collectionRevision++;
  }

  // 保持する全エンティティを追加順に返す。呼び出し側は読み取り専用として扱う。
  public all(): readonly DynamicEntity[] {
    return this.entities;
  }

  public allMotions(): readonly DynamicMotion[] {
    return this.entities.map(entity => entity.motion);
  }

  // 全エンティティの寿命判定と上限判定を行い、死亡したものを破棄・除去する。
  public cleanup(
    dt: number, simTime: number, activeStage: StageOutcome, viewerPos: Vec3,
    atmosphereBodies: readonly CelestialBody[],
  ): void {
    this.processPendingSpawns();
    // 判定は開始時の顔ぶれに対して行う。死の演出が破片を足すので、生配列を反復すると
    // 生まれたばかりの個体まで同じパスで判定してしまい、生成が連鎖すれば終わらなくなる。
    for (let i = 0, n = this.entities.length; i < n; i++) {
      this.entities[i]!.motion.checkLoss(
        dt, simTime, { activeStage, registry: this }, viewerPos, atmosphereBodies);
    }
    this.enforceCaps();
    this.prune();
  }

  // 死亡した個体を破棄して取り除く。生存分は追加順のまま前へ詰める。
  private prune(): void {
    let w = 0;
    let changed = false;
    // 所有者が回収する種別は、死亡していても残す。
    for (const x of this.entities) {
      if (!x.motion.alive && !x.reclaimedByOwner) {
        x.dispose();
        changed = true;
      }
      else {
        this.entities[w] = x;
        w++;
      }
    }
    this.entities.length = w;
    if (changed) this.bumpCollectionRevision();
  }

  // 過去表示に要る履歴の保持時間 [s] を全エンティティへ要求する。履歴を持たない種別は無視する。
  requestHistoryDuration(sec: number): void {
    for (const entity of this.entities) entity.motion.requestHistoryDuration(sec);
  }

  // 顔ぶれをどこまで進めたか。積分の先端時刻と、直前のフレームで進めた長さ [sim s]。
  get simTime(): number { return this.simulator.simTime; }
  get lastSimDt(): number { return this.simulator.lastSimDt; }

  // 時間が止まったことを記録し、次のフレームへ持ち越してはならない連続指令を畳む。
  pause(): void {
    this.simulator.lastSimDt = 0;
    for (const controllable of this.controllables) controllable.clearTransientCommands();
  }

  // 顔ぶれを1フレーム進める。個体が自分で決める推力を先に確定させ、操作されうる個体と敵へ
  // 指令を決めさせてから積分する — 推力は自分の状態だけで決まるので、操作の可否に依らず先に
  // 済ませられる。
  //
  // 各段の境界で操作対象を検査する。どの境界で落ちたかが、汚染したのがどの段かを一意に決める。
  update(
    active: Controllable | null, input: Input, operable: boolean,
    dt: number, simDt: number, canEngage: boolean, activeStage: StageOutcome & StageSimulationEvents,
  ): void {
    this.nanWatchdog.checkControlled(
      'update(入口)', active?.motion ?? null, this.simTime, dt, this.lastSimDt,
    );
    this.sections.enter(SECTION.command);
    this.updateThrusts(simDt);
    this.updateControllables(active, input, operable, dt, simDt, activeStage);
    this.behaveAll(active, operable);
    this.sections.exit(SECTION.command);
    this.nanWatchdog.checkControlled(
      'update(指令決定)', active?.motion ?? null, this.simTime, dt, this.lastSimDt,
    );

    this.sections.enter(SECTION.integrate);
    this.simulator.advance(
      dt, simDt, active?.motion ?? null, activeStage, canEngage, this.nanWatchdog,
    );
    this.sections.exit(SECTION.integrate);
    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全個体を見る。
    this.nanWatchdog.checkAll(
      'update(積分)', active?.motion ?? null, this.allMotions(), this.simTime, dt, simDt,
    );
  }

  // 自分で決まる推力を持つ個体を1フレーム進める。
  private updateThrusts(simDt: number): void {
    for (const entity of this.entities) {
      if (entity.motion.alive) entity.motion.updateCommands(simDt);
    }
  }

  // 操作されうる全個体へ updateControls を1度ずつ通す。「操作対象でない」と
  // 「操作できないワープ倍率」は同じ状態なので、input を渡すかどうかで一つに束ねる。
  private updateControllables(
    active: Controllable | null, input: Input, operable: boolean,
    dt: number, simDt: number, activeStage: StageOutcome,
  ): void {
    for (const controllable of this.controllables) {
      if (!controllable.motion.alive) continue;
      controllable.updateControls(
        controllable === active && operable ? input : null,
        dt,
        simDt,
        this,
        activeStage,
        this.celestialBodies,
      );
    }
  }

  // 生存中の敵全てに AI 行動を1フレーム分実行させる。追跡先の艦が1隻も無ければ何もしない。
  // 同一集団の判定に使う母集団は、このフレームの顔ぶれを1度だけ取って全機で共有する。
  private behaveAll(active: Controllable | null, operable: boolean): void {
    const player = this.trackedShip(active);
    if (player === null) return;
    const enemies = this.entities.filter(isEnemy);
    for (const e of enemies) {
      if (e.motion.alive) {
        e.behave(this.simTime, player, this, enemies, operable, this.celestialBodies);
      }
    }
  }

  // 敵が追う自艦。操作対象が基地でも敵は止まらないので、そのときは生存中の先頭の艦を使う。
  private trackedShip(active: Controllable | null): Player | null {
    if (active instanceof Player) return active;
    return this.entities.filter(isPlayer).find((p) => p.motion.alive) ?? null;
  }

  // このフレームの表示物を同期する。何をどう出すかは個体が答えるので、ここは顔ぶれを1度だけ
  // 辿るだけ。積む変換を作るのは個体自身なので、プールの1フレームをこの走査で挟む。
  public sync(
    displayTime: number, active: Controllable | null,
    visibilityPolicy: MapVisibilityPolicy | null, camera: CameraFrame, style: RenderStyle,
    visual: EntityVisualSettings, orbitRef: OrbitReference | undefined,
  ): void {
    // 全個体が同じ1つのフレーム入力を読むよう、走査の前に組んでおく。
    const context = { displayTime, camera, style, visual, pools: this.instancedPools };
    // instance pool の受付期間で全 Entity を挟む。
    this.instancedPools.beginFrame();
    for (const e of this.entities) {
      // 種別ごとの表示可否はここで解決し、View へは結果だけを渡す。
      const visible = visibilityPolicy === null || e.mapVisibility(visibilityPolicy, active).category;
      e.sync(context, visible, e === active, orbitRef);
    }
    this.instancedPools.endFrame();
  }

  // 保持する全エンティティと描画資源プールを、生死によらず破棄する。
  dispose(): void {
    for (const e of this.entities) e.dispose();
    this.entities.length = 0;
    // 待ち行列の build は scene などを掴んだままなので、実体化されないまま残さない。
    this.pendingSpawns.length = 0;

    this.instancedPools.dispose();

    this.bumpCollectionRevision();
  }

  // 枠ごとの現在の個体数。個体は自分がどの枠・どの種別に属するかを既に宣言しているので、
  // 顔ぶれを1度だけ辿ってそのとおりに数える。枠を持つ個体を枠の側で数えるのは、切り離した
  // ブースターのように「表示トグルは自機だが数は別に見たい」種別があるため。
  perfCounts(): Pick<PerfCounts, 'entities'> & ReturnType<Simulator['perfCounts']> {
    const entities: Partial<Record<EntityCountKind, number>> = {};
    for (const e of this.entities) {
      const kind = e.capKind ?? e.mapKind;
      if (kind === null) continue;
      entities[kind] = (entities[kind] ?? 0) + 1;
    }
    return { entities, ...this.simulator.perfCounts() };
  }
}
