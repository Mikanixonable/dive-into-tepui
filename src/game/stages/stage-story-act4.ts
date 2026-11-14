// ストーリー第4幕「決戦」。低軌道全域とモルニヤ軌道を舞台に、モルニヤ群16機を盾に
// 持つ指揮中枢を破壊するとキャンペーンが決着する(GAME.md 11.2 / 11.3)。中枢の破壊と
// 同時に残存する自動兵器は統率を失って無力化し、以後攻撃してこない — 全駆逐は条件に
// しない。クリア後はステータスパネルに評価(ゲーム内日数・失った船の数・総撃破数・
// 建造した総質量)を示し、残存機の掃討・回収は任意に続けられる。敗北はなく、進行と
// 決着はキャンペーン状態が持つ。
import { Stage, STORY_EPOCH, type CommonStageState, type SerializedStage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { v3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import { serializeKinematicState, type KinematicState } from '../../physics/kinematic-state';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { shipPhysicsShape } from '../ship/ship-physics-shape';
import { createBasePreset, createDefaultCombatPreset } from '../ship/ship-presets';
import {
  assemblyOriginHeight, surfaceAnchorAtLatLon, surfaceAnchorPose,
} from '../ship/surface-anchor';
import { buildStoryLunarBaseAssembly, STORY_LUNAR_BASE_ID } from './stage-story-lunar';
import {
  STORY_EARTH_OBSERVATION_POST_ID, STORY_LUNAR_ORBIT_DOCK_ID,
  storyAct2CircularOrbitState, storyEarthObservationPostState, storyLunarOrbitDockState,
} from './stage-story-act2';
import {
  generateCoellipticEnemy, generateCrossingEnemy, generateMolniyaEnemy, generatePhasedEnemy,
  type EnemyPlacementExtras,
} from './spawner/enemy-generator';
import { AssemblyEnemy } from '../dynamic/dynamic-entity/assembly-enemy';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import { COLOR_ENEMY_ORBIT_LINE } from '../lines/entity-line-manager';
import {
  StoryEconomy, enemyDropMaterials,
  LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
  LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR,
  type SerializedStoryEconomy,
} from '../campaign/story-economy';
import {
  ConstructionScaleGate, type ConstructionFacilityTier,
} from '../campaign/construction-scale-gate';
import {
  CAMPAIGN_ELAPSED_REPORT_SECONDS, EMPTY_CAMPAIGN_STATS, fillCampaignDefaults,
  type CampaignState, type CampaignStats, type CarriedShip,
} from '../campaign/campaign-state';
import type { EnemyDeathCause } from './stage-outcome';

// モルニヤ群の機数(GAME.md 11.2)。中枢とその陣形はこの数に含めない。
export const STORY_ACT4_ENEMY_COUNT = 16;
// 指揮中枢の敵 id。撃破がキャンペーンの決着に直結する、安定した識別子。
export const STORY_COMMAND_CORE_ID = 'story-command-core';
// 中枢を守る編隊の指揮機の敵 id。僚機はこの機を指揮機として持つ。
export const STORY_ACT4_FORMATION_COMMANDER_ID = 'story-act4-formation-commander';

// プレイヤー船の開始位置: 月周回軌道の高度 [m] と、中継ドックからの位相のずらし [rad]。
const PLAYER_ORBIT_ALTITUDE = 100_000;
const PLAYER_PHASE_RAD = (-30 * Math.PI) / 180 + (0.3 * Math.PI) / 180;
// 引き継ぎ艦を置く位相の間隔 [rad]。開始位置から艦ごとにずらす。
const PLAYER_PHASE_STEP_RAD = (0.3 * Math.PI) / 180;
// 指揮中枢の軌道: 地球周回軌道の高度 [m] と、地球の子午線からの位相 [rad]。
// 観測拠点(位相 20°)から遠く離し、モルニヤ群と護衛に守られた奥に置く。
const CORE_ALTITUDE = 420_000;
const CORE_PHASE_RAD = (160 * Math.PI) / 180;

// モルニヤ群1機ぶんの配置。軌道要素はステージ2のモルニヤ群と同じ(近地点 1,200 km /
// 遠地点 39,400 km、臨界傾斜 63.4° — GAME.md 11.2)。id はキャンペーンの撃破記録と
// 対応する安定した識別子で、全機が指揮中枢を指揮機として持つ。
export interface StoryAct4MolniyaSpec {
  readonly id: string;
  readonly name: string;
  // 昇交点赤経 [rad] と真近点角 [rad]。
  readonly raan: number;
  readonly nu: number;
  readonly accent: number;
}

// モルニヤ群の配置表(GAME.md 11.2: 16機)。
export const STORY_ACT4_MOLNIYA_ENEMIES: readonly StoryAct4MolniyaSpec[] = [
  { id: 'story-act4-enemy-1', name: 'モルニヤ兵器-α', raan: 0.4, nu: 2.6, accent: 0xff4a3d },
  { id: 'story-act4-enemy-2', name: 'モルニヤ兵器-β', raan: 2.5, nu: 0.9, accent: 0xff7a2d },
  { id: 'story-act4-enemy-3', name: 'モルニヤ兵器-γ', raan: 4.6, nu: 3.8, accent: 0xe0409f },
  { id: 'story-act4-enemy-4', name: 'モルニヤ兵器-δ', raan: 1.2, nu: 5.1, accent: 0xbf3dff },
  { id: 'story-act4-enemy-5', name: 'モルニヤ兵器-ε', raan: 3.3, nu: 1.7, accent: 0xff2d6b },
  { id: 'story-act4-enemy-6', name: 'モルニヤ兵器-ζ', raan: 5.4, nu: 4.4, accent: 0x3d7bff },
  { id: 'story-act4-enemy-7', name: 'モルニヤ兵器-η', raan: 0.9, nu: 0.3, accent: 0x2dff8f },
  { id: 'story-act4-enemy-8', name: 'モルニヤ兵器-θ', raan: 2.0, nu: 3.1, accent: 0xffd23d },
  { id: 'story-act4-enemy-9', name: 'モルニヤ兵器-ι', raan: 3.8, nu: 5.6, accent: 0xff4a3d },
  { id: 'story-act4-enemy-10', name: 'モルニヤ兵器-κ', raan: 5.9, nu: 2.2, accent: 0xff7a2d },
  { id: 'story-act4-enemy-11', name: 'モルニヤ兵器-λ', raan: 1.6, nu: 4.9, accent: 0xe0409f },
  { id: 'story-act4-enemy-12', name: 'モルニヤ兵器-μ', raan: 4.1, nu: 0.6, accent: 0x2d9fff },
  { id: 'story-act4-enemy-13', name: 'モルニヤ兵器-ν', raan: 0.1, nu: 1.3, accent: 0x3dffd2 },
  { id: 'story-act4-enemy-14', name: 'モルニヤ兵器-ξ', raan: 2.8, nu: 4.0, accent: 0xff2d8f },
  { id: 'story-act4-enemy-15', name: 'モルニヤ兵器-ο', raan: 4.9, nu: 5.9, accent: 0xd23dff },
  { id: 'story-act4-enemy-16', name: 'モルニヤ兵器-π', raan: 5.7, nu: 3.4, accent: 0xff8c2d },
];

// 組み立て型1機ぶんの配置。地球周回軌道へ置く。
export interface StoryAct4AssemblySpec {
  readonly id: string;
  readonly name: string;
  // 個体の形状を決める種。
  readonly seed: number;
  // 地球の子午線からの位相 [rad] と軌道高度 [m]。
  readonly phaseRad: number;
  readonly altitude: number;
  readonly accent: number;
}

// 指揮中枢。中枢機は組み立て型で、部品と中核の喪失が撃破になる。
export const STORY_ACT4_CORE_SPEC: StoryAct4AssemblySpec = {
  id: STORY_COMMAND_CORE_ID, name: '指揮中枢', seed: 777,
  phaseRad: CORE_PHASE_RAD, altitude: CORE_ALTITUDE, accent: 0xffe14d,
};

// 中枢を守る組み立て型の護衛。中枢の近傍軌道に散らす。
export const STORY_ACT4_CORE_GUARDS: readonly StoryAct4AssemblySpec[] = [
  { id: 'story-act4-guard-1', name: '中枢護衛-甲', seed: 511, phaseRad: CORE_PHASE_RAD - 0.03, altitude: CORE_ALTITUDE + 8_000, accent: 0xff8c2d },
  { id: 'story-act4-guard-2', name: '中枢護衛-乙', seed: 622, phaseRad: CORE_PHASE_RAD + 0.03, altitude: CORE_ALTITUDE - 8_000, accent: 0xd23dff },
  { id: 'story-act4-guard-3', name: '中枢護衛-丙', seed: 733, phaseRad: CORE_PHASE_RAD - 0.06, altitude: CORE_ALTITUDE - 4_000, accent: 0x2dffc8 },
  { id: 'story-act4-guard-4', name: '中枢護衛-丁', seed: 844, phaseRad: CORE_PHASE_RAD + 0.06, altitude: CORE_ALTITUDE + 4_000, accent: 0xff2d8f },
];

// 金属機1機ぶんの配置。中枢の状態を基準に近傍軌道へ散らす。
export interface StoryAct4MetalSpec {
  readonly id: string;
  readonly name: string;
  readonly pattern: 'phased' | 'coelliptic' | 'crossing';
  // 基準の状態から軌道面内で進める弧長 [m]。
  readonly dAlong: number;
  // 高度のずらし [m]。coelliptic の配置だけが使う。
  readonly altitudeOffset: number;
  readonly accent: number;
  // 編隊の指揮機の id。指揮機を持たない機体は null。
  readonly commanderId: string | null;
}

// 中枢を守る金属機の編隊。指揮機1機と、その指揮機を指す僚機3機(GAME.md 11.1)。
export const STORY_ACT4_FORMATION: readonly StoryAct4MetalSpec[] = [
  { id: STORY_ACT4_FORMATION_COMMANDER_ID, name: '編隊指揮機', pattern: 'phased', dAlong: 2500, altitudeOffset: 0, accent: 0xffd23d, commanderId: null },
  { id: 'story-act4-formation-2', name: '自動兵器-僚機1', pattern: 'phased', dAlong: 2900, altitudeOffset: 0, accent: 0xff4a3d, commanderId: STORY_ACT4_FORMATION_COMMANDER_ID },
  { id: 'story-act4-formation-3', name: '自動兵器-僚機2', pattern: 'coelliptic', dAlong: 2100, altitudeOffset: 2000, accent: 0xff7a2d, commanderId: STORY_ACT4_FORMATION_COMMANDER_ID },
  { id: 'story-act4-formation-4', name: '自動兵器-僚機3', pattern: 'crossing', dAlong: 3300, altitudeOffset: 0, accent: 0xe0409f, commanderId: STORY_ACT4_FORMATION_COMMANDER_ID },
];

// 第4幕の敵すべての id。残存数の数えと、再入場時の撃破済みの復元に使う。
export const STORY_ACT4_ALL_ENEMY_IDS: readonly string[] = [
  ...STORY_ACT4_MOLNIYA_ENEMIES.map((spec) => spec.id),
  STORY_COMMAND_CORE_ID,
  ...STORY_ACT4_CORE_GUARDS.map((spec) => spec.id),
  ...STORY_ACT4_FORMATION.map((spec) => spec.id),
];

export interface SerializedStageStoryAct4 extends SerializedStage {
  readonly economy: SerializedStoryEconomy;
  readonly seedAnnounced: boolean;
  readonly lastProductionAt: number;
  readonly commandCoreDestroyed: boolean;
  readonly initialStats: CampaignStats;
  readonly shipsLostThisRun: number;
  readonly removedEnemyIds: readonly string[];
  readonly lastElapsedReportAt: number;
  readonly shipyardBuilt: boolean;
}

export class StageStoryAct4 extends Stage {
  public static readonly id = 'story-act4' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'ストーリー 第4幕';
  public static readonly selectSub = ' モルニヤ群を盾に持つ指揮中枢を破壊する';
  // キャンペーンの各幕は内部のステージで、一覧には並ばない(GAME.md 11.2)。
  public static readonly hiddenFromSelect = true;

  // 経済の台帳。出来事の送り先は動的システムのイベント記録。
  private readonly economyLedger: StoryEconomy;

  // 拠点と規模ゲートの格の対応。第3幕で完成した軌道造船所が地球側の拠点になる。
  private readonly facilityTiers: Record<string, ConstructionFacilityTier>;
  // 規模ゲート。拠点の格は facilityTiers が持ち、造船所の完成で決まる。
  private readonly scaleGate: ConstructionScaleGate;
  // このステージの拠点(設備船)の id の集合。引き継ぎ艦隊の捕捉で、拠点そのものを対象から外す。
  private readonly facilityIds: ReadonlySet<string>;
  // キャンペーンから引き継いだ艦。入場時に支給船の代わりに置かれる。
  private carriedShips: readonly CarriedShip[] = [];

  // 残存から消えた第4幕の敵の id。残存数の表示が数える。
  private readonly removedEnemyIds: Set<string>;

  // 台本の進行と共通の状態から組む。initialStats はラン開始時点のキャンペーンの
  // 集計で、評価の表示はこれへこのランぶんを足して組む。
  private constructor(
    deps: StageDeps,
    storyEconomy: StoryEconomy | null = null,
    private seedAnnounced = false,
    private lastProductionAt = 0,
    private readonly defeatedEnemyIds: ReadonlySet<string> = new Set(),
    private commandCoreDestroyed = false,
    private readonly initialStats: CampaignStats = EMPTY_CAMPAIGN_STATS,
    private shipsLostThisRun = 0,
    removedEnemyIds: readonly string[] = [],
    private lastElapsedReportAt = 0,
    private readonly shipyardBuilt = false,
    ...common: CommonStageState
  ) {
    super(deps, ...common);
    this.economyLedger = storyEconomy ?? new StoryEconomy(this._dynamicSystem.events);
    this.removedEnemyIds = new Set(removedEnemyIds);
    this.facilityTiers = {
      [STORY_LUNAR_BASE_ID]: 'surface-base',
      [STORY_LUNAR_ORBIT_DOCK_ID]: 'orbital-dock',
      [STORY_EARTH_OBSERVATION_POST_ID]: this.shipyardBuilt ? 'orbital-shipyard' : 'orbital-dock',
    };
    this.scaleGate = new ConstructionScaleGate(this.facilityTiers);
    this.facilityIds = new Set(Object.keys(this.facilityTiers));
  }

  // このステージの経済。建造・修理・製造・給油はここから備蓄を払う。
  public override get economy(): StoryEconomy { return this.economyLedger; }

  // このステージの規模ゲート。第4幕の拠点での建造が照らされる。
  public override get constructionGate(): ConstructionScaleGate { return this.scaleGate; }

  // 指揮中枢が破壊されている間、残存する自動兵器は統率を失って射撃を止める
  // (GAME.md 11.3)。破壊はこのステージの間も、再入場しても覆らない。
  public override get enemiesMayFire(): boolean { return !this.commandCoreDestroyed; }

  // 指揮中枢が破壊されているか。
  public get isCommandCoreDestroyed(): boolean { return this.commandCoreDestroyed; }

  // 月面基地の初期備蓄を台帳へ入れて始める。キャンペーンへの通知は最初のフレームで行う。
  public static create(...deps: StageDeps): StageStoryAct4 {
    const stage = new StageStoryAct4(deps);
    stage.economyLedger.credit(
      STORY_LUNAR_BASE_ID, LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
    );
    stage.setupInitialPlacement();
    stage.composeBriefing();
    return stage;
  }

  // キャンペーンの備蓄と進行を引き継いで始める。撃破済みの敵は置かず、中枢が
  // 破壊済みなら残存する自動兵器は最初から無力化している(GAME.md 11.2 / 11.3)。
  public static createFromCampaign(campaign: CampaignState, ...deps: StageDeps): StageStoryAct4 {
    const state = fillCampaignDefaults(campaign);
    const inherited = state.stockpiles[STORY_LUNAR_BASE_ID] !== undefined;
    const defeated = new Set(state.defeatedEnemyIds);
    const stage = new StageStoryAct4(
      deps, new StoryEconomy(deps[2].events, state.stockpiles), inherited, 0,
      defeated, state.commandCore === 'destroyed', state.stats, 0,
      STORY_ACT4_ALL_ENEMY_IDS.filter((id) => defeated.has(id)),
      0, state.shipyardBuilt === true,
    );
    if (!inherited) {
      stage.economyLedger.credit(
        STORY_LUNAR_BASE_ID, LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
      );
    }
    stage.setupInitialPlacement(state.carriedShips);
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。初期配置はセーブ側のエンティティ記録が持つので、ここでは置かない。
  public static deserialize(
    serialized: SerializedStageStoryAct4 | null, ...deps: StageDeps
  ): StageStoryAct4 {
    return new StageStoryAct4(
      deps,
      serialized?.economy == null
        ? null
        : StoryEconomy.deserialize(serialized.economy, deps[2].events),
      serialized?.seedAnnounced ?? false,
      serialized?.lastProductionAt ?? 0,
      new Set(),
      serialized?.commandCoreDestroyed ?? false,
      serialized?.initialStats ?? EMPTY_CAMPAIGN_STATS,
      serialized?.shipsLostThisRun ?? 0,
      serialized?.removedEnemyIds ?? [],
      serialized?.lastElapsedReportAt ?? 0,
      serialized?.shipyardBuilt ?? false,
      ...Stage.deserializeCommonState(serialized, deps, StageStoryAct4.stageRules),
    );
  }

  // 開始状態を置く。第3幕と同じ3拠点に、プレイヤー船を月周回軌道の中継ドック近傍へ、
  // モルニヤ群・指揮中枢とその護衛・編隊を地球のまわりへ置く。引き継ぎ艦があるときは、
  // 支給船の代わりにそれらを置く(GAME.md 11.2)。
  private setupInitialPlacement(carriedShips: readonly CarriedShip[] = []): void {
    this.carriedShips = carriedShips;
    const moon = this._celestialSystem.find('moon')?.motion;
    const earth = this._celestialSystem.find('earth')?.motion;
    if (moon === undefined || moon === null) throw new Error('story act4: moon not found');
    if (earth === undefined || earth === null) throw new Error('story act4: earth not found');

    if (carriedShips.length > 0) {
      this.placeCarriedFleet(carriedShips, (index) => storyAct2CircularOrbitState(
        moon, 0, PLAYER_ORBIT_ALTITUDE, PLAYER_PHASE_RAD + PLAYER_PHASE_STEP_RAD * index,
      ));
    } else {
      this.addPlayer({
        name: '主力船',
        assembly: createDefaultCombatPreset(),
        state: storyAct2CircularOrbitState(moon, 0, PLAYER_ORBIT_ALTITUDE, PLAYER_PHASE_RAD),
      });
    }

    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    const anchor = surfaceAnchorAtLatLon(
      moon.def.id, moon.def.radius, 0, 0, assemblyOriginHeight(assembly),
    );
    const shape = shipPhysicsShape(assembly);
    if (shape === null) throw new Error('story act4: base assembly has no physics shape');
    const pose = surfaceAnchorPose(anchor, moon, 0, shape.centerOffset);
    this.addPlayer({
      name: '月面基地',
      id: STORY_LUNAR_BASE_ID,
      assembly,
      dockState,
      state: pose.state,
      att: { q: pose.q, w: pose.w, inertia: v3(1, 1, 1) },
      surfaceAnchor: anchor,
    });

    this.addPlayer({
      name: '月軌道ドック',
      id: STORY_LUNAR_ORBIT_DOCK_ID,
      assembly: createBasePreset(),
      state: storyLunarOrbitDockState(moon, 0),
    });

    const postState = storyEarthObservationPostState(earth, 0);
    this.addPlayer({
      name: this.shipyardBuilt ? '軌道造船所' : '地球観測拠点',
      id: STORY_EARTH_OBSERVATION_POST_ID,
      assembly: createBasePreset(),
      state: postState,
    });

    this.addAct4Enemies(postState, earth);
  }

  // 第4幕の敵を置く。キャンペーンに撃破済みとして記録された敵は二度と戻らないため、
  // 置かない(GAME.md 11.2)。すべての敵が4状態の意図を持つ。
  private addAct4Enemies(referenceState: KinematicState, earth: CelestialBody): void {
    const attractors = this._celestialSystem.celestialMotions;
    const scene = this._scene;
    const idAllocators = this._dynamicSystem.idAllocators;

    // モルニヤ群 — 指揮中枢の盾。全機が中枢を指揮機として持つ。
    for (const spec of STORY_ACT4_MOLNIYA_ENEMIES) {
      if (this.defeatedEnemyIds.has(spec.id)) continue;
      const extras: EnemyPlacementExtras = { commanderId: STORY_COMMAND_CORE_ID, tracksIntent: true };
      this.addEnemy(generateMolniyaEnemy(
        spec.name, referenceState, attractors, spec.raan, spec.nu, spec.accent,
        COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
      ));
    }

    // 指揮中枢と組み立て型の護衛。
    const coreState = storyAct2CircularOrbitState(
      earth, 0, STORY_ACT4_CORE_SPEC.altitude, STORY_ACT4_CORE_SPEC.phaseRad,
    );
    for (const spec of [STORY_ACT4_CORE_SPEC, ...STORY_ACT4_CORE_GUARDS]) {
      if (this.defeatedEnemyIds.has(spec.id)) continue;
      const state = spec.id === STORY_COMMAND_CORE_ID
        ? coreState
        : storyAct2CircularOrbitState(earth, 0, spec.altitude, spec.phaseRad);
      this.addEnemy(AssemblyEnemy.create(
        {
          name: spec.name, state: serializeKinematicState(state), seed: spec.seed,
          accent: spec.accent, orbitLineColor: COLOR_ENEMY_ORBIT_LINE,
          formationId: null, formationRole: null, id: spec.id, tracksIntent: true,
        },
        idAllocators, scene,
      ));
    }

    // 中枢を守る金属機の編隊。中枢の状態を基準に近傍軌道へ散らす。
    for (const spec of STORY_ACT4_FORMATION) {
      if (this.defeatedEnemyIds.has(spec.id)) continue;
      const extras: EnemyPlacementExtras = { commanderId: spec.commanderId, tracksIntent: true };
      switch (spec.pattern) {
        case 'phased':
          this.addEnemy(generatePhasedEnemy(
            spec.name, coreState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
        case 'coelliptic':
          this.addEnemy(generateCoellipticEnemy(
            spec.name, coreState, attractors, spec.dAlong, spec.altitudeOffset, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
        case 'crossing':
          this.addEnemy(generateCrossingEnemy(
            spec.name, coreState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
      }
    }
  }

  // ステージ開始時のブリーフィング文言を返す。
  protected briefingHtml(): string {
    if (this.commandCoreDestroyed) {
      return (
        '<b>第4幕 決戦 — 反攻完了</b><br>' +
        '指揮中枢は破壊され、自動兵器群は無力化した。残存機の掃討と回収は任意に続けられる<br>' +
        `[${K.help.label}] キーで操作方法を表示`
      );
    }
    return (
      '<b>第4幕 決戦</b><br>' +
      'モルニヤ群を盾に持つ指揮中枢を破壊せよ — 残敵の全駆逐は要らない<br>' +
      (this.carriedShips.length > 0
        ? '前幕の艦を引き継いだ。決戦の艦隊はそのまま使える<br>'
        : '') +
      '中枢を断てば、統率を失った自動兵器はすべて無力化する<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 補給タイマーと経済(初期備蓄の通知・基地の生産・サルベージ回収)を1フレーム分進める。
  public update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (player !== null) this.logistics.updateLogistics(simTime, player, simSpeed);

    // 所要時間つき建造の完了を進める(GAME.md 11.4)。
    this.advanceStoryWorks(simTime);

    // 引き継ぎ艦隊をキャンペーンへ報告する(GAME.md 11.2)。クリア後の再入場でも
    // 艦隊がそのまま現れるよう、決着の後も報告し続ける。
    this.reportCarriedFleet(simTime, this.facilityIds);

    // 初期備蓄は作成時に台帳へ入れてある。キャンペーンへは最初のフレームで1度だけ送る。
    if (!this.seedAnnounced) {
      this.seedAnnounced = true;
      this._dynamicSystem.events.record({
        kind: 'stockpileChanged', baseId: STORY_LUNAR_BASE_ID,
        materials: LUNAR_BASE_INITIAL_MATERIALS, propellant: LUNAR_BASE_INITIAL_PROPELLANT,
      });
    }

    // 月面基地の生産。素材の採掘と推進剤の ISRU 生産が、備蓄へゆっくり積まれる。
    const productionDt = simTime - this.lastProductionAt;
    if (productionDt > 0) {
      this.economyLedger.produce(
        STORY_LUNAR_BASE_ID, LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR,
        productionDt,
      );
      this.lastProductionAt = simTime;
    }

    // ゲーム内時間の経過を、評価の集計としてキャンペーンへ報告する。
    if (simTime - this.lastElapsedReportAt >= CAMPAIGN_ELAPSED_REPORT_SECONDS) {
      this._dynamicSystem.events.record({
        kind: 'storyElapsedTime', seconds: simTime - this.lastElapsedReportAt,
      });
      this.lastElapsedReportAt = simTime;
    }

    this.updateSalvageRecovery(STORY_LUNAR_BASE_ID);
  }

  // 敵の消滅を記録する。消滅した敵は id つきでキャンペーンへ知らせ、再入場時に
  // 再配置されないようにする。撃破によらない消滅も残存から消えたものとして
  // 知らせるが、撃破数には数えない(GAME.md 11.2)。指揮中枢が
  // 失われれば、その原因によらず決着として記録し、残存する自動兵器は無力化する
  // (GAME.md 11.3)。決着は一度だけで、以後は覆らない。
  public override recordEnemyDeath(
    enemy: Enemy, simTime: number, cause: EnemyDeathCause = 'killed',
  ): void {
    super.recordEnemyDeath(enemy, simTime, cause);
    if (cause === 'killed') {
      this._dynamicSystem.events.record({ kind: 'enemyDefeated', enemyId: enemy.id });
    } else if (STORY_ACT4_ALL_ENEMY_IDS.includes(enemy.id)) {
      this._dynamicSystem.events.record({ kind: 'enemyLost', enemyId: enemy.id });
    }
    if (STORY_ACT4_ALL_ENEMY_IDS.includes(enemy.id)) {
      this.removedEnemyIds.add(enemy.id);
    }
    if (enemy.id === STORY_COMMAND_CORE_ID && !this.commandCoreDestroyed) {
      this.commandCoreDestroyed = true;
      this._dynamicSystem.events.record({ kind: 'commandCoreDestroyed' });
      this.reportCarriedFleet(simTime, this.facilityIds, true);
    }
  }

  // 撃破した敵は、その質量に応じた素材サルベージを落とす(GAME.md 11.4)。
  protected override salvageDropMaterials(enemy: Enemy): number | null {
    return enemyDropMaterials(enemy.motion.mass);
  }

  // ストーリーモードに敗北はない(GAME.md 11.3)。艦を失っても決着させず、
  // 喪失を評価の集計としてキャンペーンへ知らせる。
  public recordPlayerLost(_reason: string): void {
    this.shipsLostThisRun += 1;
    this._dynamicSystem.events.record({ kind: 'storyShipLost' });
  }

  // 撃破数による勝利判定はストーリーモードには無い(GAME.md 11.2)。決着は中枢の破壊。
  protected checkWin(): boolean { return false; }

  // 残存している第4幕の敵の数。クリア後の任意目標の表示が数える。
  private remainingAct4Enemies(): number {
    return STORY_ACT4_ALL_ENEMY_IDS.length - this.removedEnemyIds.size;
  }

  // いまの目標と、クリア後は評価をステータスパネルへ出す(GAME.md 11.3)。
  protected hudSubStatus(): string {
    if (this.commandCoreDestroyed) {
      const days = Math.floor(
        (this.initialStats.elapsedSeconds + this._dynamicSystem.simTime) / 86_400,
      );
      const shipsLost = this.initialStats.shipsLost + this.shipsLostThisRun;
      const totalKills = this.initialStats.totalKills + this.scoreCounter.kills;
      const builtMassKg = Math.round(this.initialStats.builtMassKg + this.economyLedger.builtMassKg);
      const lines = [
        '反攻完了 — 指揮中枢を破壊し、自動兵器群は無力化した',
        `評価: ゲーム内 ${days} 日 / 失った船 ${shipsLost} 隻 / 総撃破数 ${totalKills} 機 / 建造した総質量 ${builtMassKg.toLocaleString('ja-JP')} kg`,
      ];
      const remaining = this.remainingAct4Enemies();
      if (remaining > 0) lines.push(`任意目標: 無力化した自動兵器の掃討・回収(残り ${remaining} 機)`);
      return lines.join('<br>');
    }
    const lines = ['目標: 指揮中枢を破壊せよ — 残敵の全駆逐は要らない'];
    const molniyaRemaining = STORY_ACT4_MOLNIYA_ENEMIES
      .filter((spec) => !this.removedEnemyIds.has(spec.id)).length;
    if (molniyaRemaining > 0) lines.push(`中枢の盾: モルニヤ群 残り ${molniyaRemaining} 機`);
    return lines.join('<br>');
  }

  // 共通の内訳へ台本の進行を足して直列化する。
  public serialize(): SerializedStageStoryAct4 {
    return {
      ...super.serialize(),
      economy: this.economyLedger.serialize(),
      seedAnnounced: this.seedAnnounced,
      lastProductionAt: this.lastProductionAt,
      commandCoreDestroyed: this.commandCoreDestroyed,
      initialStats: this.initialStats,
      shipsLostThisRun: this.shipsLostThisRun,
      removedEnemyIds: [...this.removedEnemyIds],
      lastElapsedReportAt: this.lastElapsedReportAt,
      shipyardBuilt: this.shipyardBuilt,
    };
  }
}
