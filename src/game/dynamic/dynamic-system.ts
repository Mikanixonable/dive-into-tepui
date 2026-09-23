// エンティティの保持・追加・上限管理・寿命回収と、1フレームぶんの前進(指令決定と積分)・描画同期。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { DynamicMotion } from './dynamic-motion';
import type { EngagementParticipant, EngagementZone } from './engagement-zone';
import type { EntityRoster } from './entity-roster';
import type { EntityRegistry, SpawnRecord } from './entity-registry';
import { EntityIdAllocators, type SerializedEntityIdAllocators } from './dynamic-entity/entity-id';
import { ENTITY_CAP, type EntityCountKind } from './dynamic-entity/entity-kind';
import type { Controllable } from './dynamic-entity/controllable';
import { isEnemy } from './dynamic-entity/enemy';
import { isModularShip, ModularShip } from '../ship/modular-ship';
import type { SerializedDynamicEntity } from './dynamic-entity/entity-dictionary';
import { InstancedPools } from '../../render/dynamic/instanced-pools';
import { BulletPools } from '../../render/dynamic/dynamic-entity/bullet-view';
import { CasingPool } from '../../render/dynamic/dynamic-entity/casing-view';
import { DebrisFragmentPools } from '../../render/dynamic/dynamic-entity/debris-fragment-view';
import { Simulator } from './simulator';
import { NanWatchdog } from './nan-watchdog';
import { type FrameSections, SECTION } from '../frame-sections';
import type { StageOutcome } from '../stages/stage-outcome';
import type { StageSimulationEvents } from '../stages/stage-simulation-events';
import type { PilotControls } from './dynamic-entity/pilot-controls';
import type { EntityVisualSettings } from '../../render/entity-visual-settings';
import type { RenderStyle } from '../../render/render-style';
import type { ProteinDisplaySettings } from '../../render/protein/protein-display';
import type { StageRules } from '../stages/stage-rules';
import type { PerfCounts } from '../perf-counts';
import type { RunEventSink } from '../run-events';
import type { OrbitReference } from '../orbit-reference';
import { EntityLifecycle } from './entity-lifecycle';

export interface SerializedDynamicSystem {
  readonly simTime: number;
  // エンティティ一覧。種別は各要素の kind が持つ。
  readonly entities: readonly SerializedDynamicEntity[];
  readonly pendingSpawns: readonly SpawnRecord[];
  readonly idAllocators: SerializedEntityIdAllocators;
}

export class DynamicSystem implements EntityRegistry, EntityRoster {
  // エンティティの collection・pending spawn・上限・回収の正本。
  private readonly lifecycle: EntityLifecycle;

  // 操作されうる個体。呼ぶたびに登録一覧から走査し直すため、フレーム内で複数回参照する場合は取得した配列を
  // 持ち回る。
  public get controllables(): readonly Controllable[] { return this.lifecycle.controllables; }

  // プールで描く種別の描画資源。
  private readonly instancedPools: InstancedPools;

  // エンティティ群を1フレームずつ進める積分機構。simTime の正本はここが持つ。
  private readonly simulator: Simulator;

  // 個体の状態が非有限値に汚染された瞬間を捕まえる見張り。
  private readonly nanWatchdog: NanWatchdog;

  // 描画資源のプールと前進の機構を simTime [s] から組み、records の個体を足す(実体化に要る外部資源が
  // 揃わないものは待ち行列へ回す)。idAllocators はこのランの id 採番器で、省けば連番の初めから発番する。
  // 例外(ARCHITECTURE R12): 直列化された個体の記録を構築の引数で受け、ここで復元する。個体の復元は
  // システム自身(採番器・出来事の記録)を registry として必要とするため、生成前には復元できない。
  private constructor(
    scene: THREE.Scene,
    public readonly events: RunEventSink,
    private readonly celestialBodies: CelestialBodies,
    private readonly sections: FrameSections,
    simTime = 0,
    public readonly idAllocators = new EntityIdAllocators(),
    records: readonly SpawnRecord[] = [],
  ) {
    this.instancedPools = new InstancedPools([
      new BulletPools(scene, ENTITY_CAP.bullet),
      new CasingPool(scene, ENTITY_CAP.casing),
      new DebrisFragmentPools(scene, ENTITY_CAP.debris),
    ]);
    this.lifecycle = new EntityLifecycle(scene, events, celestialBodies, idAllocators, records);
    this.simulator = new Simulator(this.lifecycle, this.lifecycle, this.lifecycle, celestialBodies, sections, simTime);
    this.nanWatchdog = new NanWatchdog(events);
  }

  // 新規セッション用の空の動的システムを生成する。
  public static create(
    scene: THREE.Scene, events: RunEventSink, celestialBodies: CelestialBodies, sections: FrameSections,
  ): DynamicSystem {
    return new DynamicSystem(scene, events, celestialBodies, sections);
  }

  // 直列化したエンティティ一覧と実体化待機中の個体を、その先端時刻から復元する。未知の種別はスキップする。
  public static deserialize(
    serialized: SerializedDynamicSystem,
    scene: THREE.Scene,
    events: RunEventSink,
    celestialBodies: CelestialBodies,
    sections: FrameSections,
  ): DynamicSystem {
    const { simTime, entities, pendingSpawns } = serialized;
    const records: readonly SpawnRecord[] = [
      ...entities.map((entity): SpawnRecord => ({ kind: 'entity', entity })),
      ...pendingSpawns,
    ];
    // null の先端時刻も欠けと同じく 0 から始める(既定引数は undefined でしか働かない)。
    return new DynamicSystem(
      scene, events, celestialBodies, sections, simTime ?? undefined,
      EntityIdAllocators.deserialize(serialized.idAllocators), records,
    );
  }

  // エンティティ一覧と実体化待機中の個体、採番器をシリアライズ形式へ変換する。
  // 例外(ARCHITECTURE R12): Simulator の値である先端時刻 simTime を、直列化レコードへ平坦に含める。
  // Simulator の記録として分けると版 4 の記録が読めなくなるので、版を上げるときに直す。
  public serialize(): SerializedDynamicSystem {
    return {
      simTime: this.simTime,
      entities: this.lifecycle.serializedEntities(),
      pendingSpawns: [...this.lifecycle.pendingSpawnRecords()],
      idAllocators: this.idAllocators.serialize(),
    };
  }

  // 保持するエンティティ集合の世代（リビジョン）。集合に変更があるたびにインクリメントされる。
  public get collectionRevision(): number {
    return this.lifecycle.collectionRevision;
  }

  // DynamicSystem はゲーム進行の起点として、EntityRegistry インターフェースをライフサイクル管理オブジェクトへ中継する。
  public add(entity: DynamicEntity): void { this.lifecycle.add(entity); }
  public spawnWhenReady(record: SpawnRecord): void { this.lifecycle.spawnWhenReady(record); }
  public get pendingEnemyCount(): number { return this.lifecycle.pendingEnemyCount; }
  public remove(entity: DynamicEntity): void { this.lifecycle.remove(entity); }

  // 保持する全エンティティを追加順に返す（読み取り専用）。
  public all(): readonly DynamicEntity[] { return this.lifecycle.all(); }

  // 全エンティティの Motion を追加順に並べた読み取り専用一覧。同じ collectionRevision の間は
  // lifecycle が同じ snapshot を返す。
  public allMotions(): readonly DynamicMotion[] { return this.lifecycle.allMotions(); }

  // 全エンティティの寿命判定と上限判定を行い、死亡したものを破棄・除去する。
  public cleanup(
    dt: number, simTime: number, activeStage: StageOutcome,
    zones: readonly EngagementZone<EngagementParticipant>[],
  ): void {
    this.lifecycle.cleanup(dt, simTime, activeStage, zones);
  }

  // 残す履歴の長さ sec [s] を全エンティティへ要求する。構築時の長さを持つ個体がそれを受ける。
  public requestHistoryDuration(sec: number): void {
    this.lifecycle.requestHistoryDuration(sec);
  }

  // シミュレーションの進行状況。積分の先端時刻と、直前フレームの積分ステップ幅 [sim s]。
  public get simTime(): number { return this.simulator.simTime; }
  public get lastSimDt(): number { return this.simulator.lastSimDt; }

  // 時間が止まったことを記録し、次のフレームへ持ち越してはならない連続指令を畳む。
  public pause(): void {
    this.simulator.pause();
    for (const controllable of this.controllables) controllable.clearTransientCommands();
  }

  // 全エンティティを1フレーム進める。自律推力、操縦コマンド、操作・敵の指令を決定してから積分する。operable は
  // 操作と敵の射撃ができる倍率か、acceptsCommands は controls の命令を操作対象へ適用するか、
  // enemiesMayFire はステージが敵の射撃を許しているか、canEngage は交戦圏を組むか。
  public update(
    active: Controllable | null, controls: PilotControls, operable: boolean, acceptsCommands: boolean,
    enemiesMayFire: boolean, dt: number, simDt: number, canEngage: boolean,
    activeStage: StageOutcome & StageSimulationEvents, stageRules: StageRules,
  ): void {
    this.nanWatchdog.checkControlled(
      'update(入口)', active?.motion ?? null, this.simTime, dt, this.lastSimDt,
    );
    this.sections.enter(SECTION.command);
    this.updateThrusts(simDt);
    // 命令が足した個体(分離したブースターなど)は、このフレームの自律の推力を持たない。
    if (active !== null && acceptsCommands) {
      for (const command of controls.commands) active.handleCommand(command, this);
    }
    this.updateControllables(active, controls, operable, dt, simDt, activeStage, stageRules);
    this.behaveAll(active, operable && enemiesMayFire);
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
    for (const entity of this.all()) {
      if (entity.motion.alive) entity.motion.updateCommands(simDt);
    }
  }

  // 生存中の操作されうる全個体へ updateControls を1度ずつ通す。
  private updateControllables(
    active: Controllable | null, controls: PilotControls, operable: boolean,
    dt: number, simDt: number, activeStage: StageOutcome, stageRules: StageRules,
  ): void {
    for (const controllable of this.controllables) {
      if (!controllable.motion.alive) continue;
      // 「操作対象でない」と「操作できないワープ倍率」は同じ状態として操作量なしで進める。
      controllable.updateControls(
        controllable === active && operable ? controls : null,
        dt, simDt, activeStage, stageRules, this.celestialBodies,
      );
    }
  }

  // 生存中の敵全てに AI 行動を1フレーム分実行させる。追跡先の艦が1隻も無ければ何もしない。
  // mayFire が偽の間は撃たない。
  private behaveAll(active: Controllable | null, mayFire: boolean): void {
    const player = this.trackedShip(active);
    if (player === null) return;
    const enemies = this.all().filter(isEnemy);
    for (const e of enemies) {
      if (e.motion.alive) {
        e.updateBehavior(this.simTime, player, this, enemies, mayFire, this.celestialBodies);
      }
    }
  }

  // 敵が追う自艦。操作対象が基地でも敵は止まらないので、そのときは生存中の先頭の艦を使う。
  private trackedShip(active: Controllable | null): ModularShip | null {
    if (active instanceof ModularShip) return active;
    return this.all().filter(isModularShip).find((p) => p.motion.alive) ?? null;
  }

  // 当該フレームの表示オブジェクトを、エンティティ一覧を走査して同期する。proteinDisplay はタンパク質の敵に
  // 共通の表示形態と着色。
  public sync(
    displayTime: number, active: Controllable | null, camera: CameraFrame, style: RenderStyle,
    visual: EntityVisualSettings, proteinDisplay: ProteinDisplaySettings, orbitRef: OrbitReference | undefined,
  ): void {
    // 全個体が同じ1つのフレーム入力を読むよう、走査の前に組んでおく。
    const viewFrame = { displayTime, camera, style, visual, proteinDisplay, pools: this.instancedPools };
    // instance pool の受付期間で全 Entity を挟む。
    this.instancedPools.beginFrame();
    for (const e of this.all()) e.sync(viewFrame, e === active, orbitRef);
    this.instancedPools.endFrame();
  }

  // 保持する全エンティティと描画資源プールを、生死によらず破棄する。
  public dispose(): void {
    this.lifecycle.dispose();
    this.instancedPools.dispose();
  }

  // 枠ごとの現在の個体数。枠を持つ個体は枠で数える — 切り離したブースターのように、表示トグルは
  // 自機だが数は別に見たい種別があるため。
  public perfCounts(): Pick<PerfCounts, 'entities'> & ReturnType<Simulator['perfCounts']> {
    const entities: Partial<Record<EntityCountKind, number>> = {};
    for (const e of this.all()) {
      const kind = e.capKind ?? e.mapKind;
      if (kind === null) continue;
      entities[kind] = (entities[kind] ?? 0) + 1;
    }
    return { entities, ...this.simulator.perfCounts() };
  }
}
