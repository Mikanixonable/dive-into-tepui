// ストーリー第3幕「造船」。地球低軌道の観測拠点を軌道造船所へ格上げし、第3幕の敵
// (金属機と組み立て型、計18機)を排除すると幕が完了する(GAME.md 11.2)。襲撃は
// 観測拠点の公転周期で並ぶ軌道暦として発生し、24時間前から予報が出る(GAME.md 11.5)。
// 敵は4状態の意図を持ち、編隊指揮機を失った僚機は射撃を止める(GAME.md 11.1 /
// COMBAT.md「AI と射撃」)。敗北はなく、決着もしない — 進行はキャンペーン状態が持つ。
import { Stage, STORY_EPOCH, type CommonStageState, type SerializedStage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { len, sub, v3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import { serializeKinematicState, type KinematicState } from '../../physics/kinematic-state';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { Button } from '../../hud/widgets';
import { isModularShip, type ModularShip } from '../ship/modular-ship';
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
  generateCoellipticEnemy, generateCrossingEnemy, generateEllipticEnemy, generatePhasedEnemy,
  type EnemyPlacementExtras,
} from './spawner/enemy-generator';
import { AssemblyEnemy } from '../dynamic/dynamic-entity/assembly-enemy';
import { isEnemy, type Enemy } from '../dynamic/dynamic-entity/enemy';
import { COLOR_ENEMY_ORBIT_LINE } from '../lines/entity-line-manager';
import {
  StoryEconomy, enemyDropMaterials, SHIPYARD_CONSTRUCTION_MATERIALS,
  LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
  LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR,
  type SerializedStoryEconomy,
} from '../campaign/story-economy';
import {
  ConstructionScaleGate, type ConstructionFacilityTier,
} from '../campaign/construction-scale-gate';
import { CAMPAIGN_ELAPSED_REPORT_SECONDS, type CampaignState } from '../campaign/campaign-state';
import {
  nextRaidMilestoneAt, raidPhaseAt, raidPlanEntry, type RaidPlanEntry,
} from '../campaign/story-raid-calendar';
import type { EnemyDeathCause } from './stage-outcome';

// 第3幕の敵の総数(GAME.md 11.2)。
export const STORY_ACT3_ENEMY_COUNT = 18;
// 編隊指揮機の敵 id。僚機はこの機を指揮機として持つ。
export const STORY_ACT3_COMMANDER_ID = 'story-act3-enemy-1';
// 襲撃1回ぶんの編隊の機数。襲撃の敵は幕の敵総数には数えない(GAME.md 11.5)。
export const STORY_ACT3_RAID_ENEMY_COUNT = 3;

// 観測拠点の軌道高度 [m]。第2幕の配置(storyEarthObservationPostState)と一致する。
const EARTH_POST_ALTITUDE = 420_000;
// プレイヤー船の開始位置: 月周回軌道の高度 [m] と、中継ドックからの位相のずらし [rad]。
const PLAYER_ORBIT_ALTITUDE = 100_000;
const PLAYER_PHASE_RAD = (-30 * Math.PI) / 180 + (0.3 * Math.PI) / 180;
// 襲撃編隊の出現位置: 対象拠点から軌道面内で遅れる弧長 [m] と、機ごとの間隔 [m]。
const RAID_SPAWN_D_ALONG = -90_000;
const RAID_SPAWN_SPACING = 4_000;
// 襲撃が拠点の建造ドックへ与える損傷 [HP] と、損傷が起きる距離 [m]。
const RAID_STRIKE_DAMAGE = 6;
const RAID_STRIKE_RANGE = 3_000;

// 敵1機ぶんの配置。id はキャンペーンの撃破記録と対応する安定した識別子。
// 金属機は観測拠点の状態を基準に近傍軌道へ散らし、組み立て型は地球周回軌道へ置く。
export type StoryAct3EnemySpec =
  | {
    readonly kind: 'metal';
    readonly id: string;
    readonly name: string;
    readonly pattern: 'phased' | 'coelliptic' | 'crossing' | 'elliptic';
    // 基準の状態から軌道面内で進める弧長 [m]。
    readonly dAlong: number;
    // 高度のずらし [m]。coelliptic の配置だけが使う。
    readonly altitudeOffset: number;
    readonly accent: number;
    // 編隊の指揮機の id。指揮機を持たない機体は null。
    readonly commanderId: string | null;
  }
  | {
    readonly kind: 'assembly';
    readonly id: string;
    readonly name: string;
    // 個体の形状を決める種。
    readonly seed: number;
    // 地球の子午線からの位相 [rad] と軌道高度 [m]。
    readonly phaseRad: number;
    readonly altitude: number;
    readonly accent: number;
  };

// 第3幕の敵の配置表(GAME.md 11.2: 金属機と組み立て型、計18機)。
export const STORY_ACT3_ENEMIES: readonly StoryAct3EnemySpec[] = [
  { kind: 'metal', id: STORY_ACT3_COMMANDER_ID, name: '編隊指揮機', pattern: 'phased', dAlong: 3000, altitudeOffset: 0, accent: 0xffd23d, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-2', name: '自動兵器-僚機1', pattern: 'phased', dAlong: 3400, altitudeOffset: 0, accent: 0xff4a3d, commanderId: STORY_ACT3_COMMANDER_ID },
  { kind: 'metal', id: 'story-act3-enemy-3', name: '自動兵器-僚機2', pattern: 'coelliptic', dAlong: 2600, altitudeOffset: 2000, accent: 0xff7a2d, commanderId: STORY_ACT3_COMMANDER_ID },
  { kind: 'metal', id: 'story-act3-enemy-4', name: '自動兵器-僚機3', pattern: 'crossing', dAlong: 3800, altitudeOffset: 0, accent: 0xe0409f, commanderId: STORY_ACT3_COMMANDER_ID },
  { kind: 'metal', id: 'story-act3-enemy-5', name: '自動兵器-η', pattern: 'phased', dAlong: 12000, altitudeOffset: 0, accent: 0xff2d6b, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-6', name: '自動兵器-θ', pattern: 'coelliptic', dAlong: -6000, altitudeOffset: -2500, accent: 0x3d7bff, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-7', name: '自動兵器-ι', pattern: 'crossing', dAlong: 8000, altitudeOffset: 0, accent: 0x2dff8f, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-8', name: '自動兵器-κ', pattern: 'elliptic', dAlong: 16000, altitudeOffset: 0, accent: 0xbf3dff, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-9', name: '自動兵器-λ', pattern: 'phased', dAlong: -20000, altitudeOffset: 0, accent: 0xff4a3d, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-10', name: '自動兵器-μ', pattern: 'coelliptic', dAlong: 24000, altitudeOffset: 3000, accent: 0xff7a2d, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-11', name: '自動兵器-ν', pattern: 'elliptic', dAlong: -12000, altitudeOffset: 0, accent: 0xe0409f, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-12', name: '自動兵器-ξ', pattern: 'crossing', dAlong: -30000, altitudeOffset: 0, accent: 0x2d9fff, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-13', name: '自動兵器-ο', pattern: 'phased', dAlong: 45000, altitudeOffset: 0, accent: 0xffd23d, commanderId: null },
  { kind: 'metal', id: 'story-act3-enemy-14', name: '自動兵器-π', pattern: 'coelliptic', dAlong: -45000, altitudeOffset: -3000, accent: 0x3dffd2, commanderId: null },
  { kind: 'assembly', id: 'story-act3-enemy-15', name: '組み立て型-甲', seed: 101, phaseRad: 0.15, altitude: EARTH_POST_ALTITUDE, accent: 0xff8c2d },
  { kind: 'assembly', id: 'story-act3-enemy-16', name: '組み立て型-乙', seed: 202, phaseRad: -0.1, altitude: EARTH_POST_ALTITUDE + 10_000, accent: 0xd23dff },
  { kind: 'assembly', id: 'story-act3-enemy-17', name: '組み立て型-丙', seed: 303, phaseRad: 0.3, altitude: EARTH_POST_ALTITUDE - 10_000, accent: 0x2dffc8 },
  { kind: 'assembly', id: 'story-act3-enemy-18', name: '組み立て型-丁', seed: 404, phaseRad: -0.25, altitude: EARTH_POST_ALTITUDE + 5_000, accent: 0xff2d8f },
];

// 襲撃 index の編隊の敵 id。
export function storyAct3RaidEnemyId(raidIndex: number, memberIndex: number): string {
  return `story-act3-raid-${raidIndex}-${memberIndex}`;
}

export interface SerializedStageStoryAct3 extends SerializedStage {
  readonly actCompleted: boolean;
  readonly economy: SerializedStoryEconomy;
  readonly seedAnnounced: boolean;
  readonly lastProductionAt: number;
  readonly shipyardBuilt: boolean;
  readonly removedEnemyIds: readonly string[];
  readonly nextRaidIndex: number;
  readonly raidForecastAnnounced: boolean;
  readonly activeRaidIndex: number | null;
  readonly raidArrivedAnnounced: boolean;
  readonly struckRaiderIds: readonly string[];
  readonly lastElapsedReportAt: number;
}

export class StageStoryAct3 extends Stage {
  public static readonly id = 'story-act3' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'ストーリー 第3幕';
  public static readonly selectSub = ' 軌道造船所を建設し、第3幕の敵を排除する';
  // キャンペーンの各幕は内部のステージで、一覧には並ばない(GAME.md 11.2)。
  public static readonly hiddenFromSelect = true;

  // 経済の台帳。出来事の送り先は動的システムのイベント記録。
  private readonly economyLedger: StoryEconomy;

  // 拠点と規模ゲートの格の対応。造船所が完成すると観測拠点の格が上がる(GAME.md 11.2)。
  private readonly facilityTiers: Record<string, ConstructionFacilityTier>;
  // 規模ゲート。拠点の格は facilityTiers が持ち、造船所の完成で書き換わる。
  private readonly scaleGate: ConstructionScaleGate;

  // 残存から消えた第3幕の敵の id。幕の完了判定が数える。
  private readonly removedEnemyIds: Set<string>;
  // 損傷を与え終えた襲撃機の id。襲撃1機の損傷は1度だけ。
  private readonly struckRaiderIds: Set<string>;
  // 対象拠点の公転周期 [sim s]。軌道暦の間隔の基準で、最初に使うときに求めて保持する。
  private raidPeriodSecondsCache: number | null = null;

  // 台本の進行と共通の状態から組む。造船所の建設ボタンはステータスウィンドウ左部へ足し、
  // 押下は命令の列を通して buildShipyard へ届く(R8)。
  private constructor(
    deps: StageDeps,
    private actCompleted = false,
    storyEconomy: StoryEconomy | null = null,
    private seedAnnounced = false,
    private lastProductionAt = 0,
    private readonly defeatedEnemyIds: ReadonlySet<string> = new Set(),
    private shipyardBuilt = false,
    removedEnemyIds: readonly string[] = [],
    private nextRaidIndex = 0,
    private raidForecastAnnounced = false,
    private activeRaidIndex: number | null = null,
    private raidArrivedAnnounced = false,
    struckRaiderIds: readonly string[] = [],
    private lastElapsedReportAt = 0,
    ...common: CommonStageState
  ) {
    super(deps, ...common);
    this.economyLedger = storyEconomy ?? new StoryEconomy(this._dynamicSystem.events);
    this.removedEnemyIds = new Set(removedEnemyIds);
    this.struckRaiderIds = new Set(struckRaiderIds);
    this.facilityTiers = {
      [STORY_LUNAR_BASE_ID]: 'surface-base',
      [STORY_LUNAR_ORBIT_DOCK_ID]: 'orbital-dock',
      [STORY_EARTH_OBSERVATION_POST_ID]: this.shipyardBuilt ? 'orbital-shipyard' : 'orbital-dock',
    };
    this.scaleGate = new ConstructionScaleGate(this.facilityTiers);

    const shipyardButton = new Button(
      `軌道造船所を建設(素材 ${SHIPYARD_CONSTRUCTION_MATERIALS})`,
      () => this._commandQueue.submit(() => this.buildShipyard()),
    );
    this.addStatusPanelWidget(shipyardButton.element);
  }

  // このステージの経済。建造・修理・製造・給油はここから備蓄を払う。
  public override get economy(): StoryEconomy { return this.economyLedger; }

  // このステージの規模ゲート。第3幕の拠点での建造が照らされる。
  public override get constructionGate(): ConstructionScaleGate { return this.scaleGate; }

  // 軌道造船所が完成しているか。
  public get isShipyardBuilt(): boolean { return this.shipyardBuilt; }

  // 月面基地の初期備蓄を台帳へ入れて始める。キャンペーンへの通知は最初のフレームで行う。
  public static create(...deps: StageDeps): StageStoryAct3 {
    const stage = new StageStoryAct3(deps);
    stage.economyLedger.credit(
      STORY_LUNAR_BASE_ID, LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
    );
    stage.setupInitialPlacement();
    stage.composeBriefing();
    return stage;
  }

  // キャンペーンの備蓄と進行を引き継いで始める。撃破済みの敵は置かず、造船所が
  // 完成済みなら観測拠点は造船所の格で始まる(GAME.md 11.2)。
  public static createFromCampaign(campaign: CampaignState, ...deps: StageDeps): StageStoryAct3 {
    const inherited = campaign.stockpiles[STORY_LUNAR_BASE_ID] !== undefined;
    const stage = new StageStoryAct3(
      deps, false, new StoryEconomy(deps[2].events, campaign.stockpiles), inherited, 0,
      new Set(campaign.defeatedEnemyIds), campaign.shipyardBuilt === true,
      campaign.defeatedEnemyIds.filter((id) => id.startsWith('story-act3-enemy-')),
    );
    if (!inherited) {
      stage.economyLedger.credit(
        STORY_LUNAR_BASE_ID, LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
      );
    }
    stage.setupInitialPlacement();
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。初期配置はセーブ側のエンティティ記録が持つので、ここでは置かない。
  public static deserialize(
    serialized: SerializedStageStoryAct3 | null, ...deps: StageDeps
  ): StageStoryAct3 {
    return new StageStoryAct3(
      deps,
      serialized?.actCompleted ?? false,
      serialized?.economy == null
        ? null
        : StoryEconomy.deserialize(serialized.economy, deps[2].events),
      serialized?.seedAnnounced ?? false,
      serialized?.lastProductionAt ?? 0,
      new Set(),
      serialized?.shipyardBuilt ?? false,
      serialized?.removedEnemyIds ?? [],
      serialized?.nextRaidIndex ?? 0,
      serialized?.raidForecastAnnounced ?? false,
      serialized?.activeRaidIndex ?? null,
      serialized?.raidArrivedAnnounced ?? false,
      serialized?.struckRaiderIds ?? [],
      serialized?.lastElapsedReportAt ?? 0,
      ...Stage.deserializeCommonState(serialized, deps, StageStoryAct3.stageRules),
    );
  }

  // 開始状態を置く。第2幕と同じ3拠点に、プレイヤー船を月周回軌道の中継ドック近傍へ、
  // 第3幕の敵を観測拠点の近傍と地球周回軌道へ置く。
  private setupInitialPlacement(): void {
    const moon = this._celestialSystem.find('moon')?.motion;
    const earth = this._celestialSystem.find('earth')?.motion;
    if (moon === undefined || moon === null) throw new Error('story act3: moon not found');
    if (earth === undefined || earth === null) throw new Error('story act3: earth not found');

    this.addPlayer({
      name: '主力船',
      assembly: createDefaultCombatPreset(),
      state: storyAct2CircularOrbitState(moon, 0, PLAYER_ORBIT_ALTITUDE, PLAYER_PHASE_RAD),
    });

    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    const anchor = surfaceAnchorAtLatLon(
      moon.def.id, moon.def.radius, 0, 0, assemblyOriginHeight(assembly),
    );
    const shape = shipPhysicsShape(assembly);
    if (shape === null) throw new Error('story act3: base assembly has no physics shape');
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

    this.addAct3Enemies(postState, earth);
  }

  // 第3幕の敵を置く。キャンペーンに撃破済みとして記録された敵は二度と戻らないため、
  // 置かない(GAME.md 11.2)。すべての敵が4状態の意図を持つ。
  private addAct3Enemies(referenceState: KinematicState, earth: CelestialBody): void {
    const attractors = this._celestialSystem.celestialMotions;
    const scene = this._scene;
    const idAllocators = this._dynamicSystem.idAllocators;
    for (const spec of STORY_ACT3_ENEMIES) {
      if (this.defeatedEnemyIds.has(spec.id)) continue;
      if (spec.kind === 'assembly') {
        const state = storyAct2CircularOrbitState(earth, 0, spec.altitude, spec.phaseRad);
        this.addEnemy(AssemblyEnemy.create(
          {
            name: spec.name, state: serializeKinematicState(state), seed: spec.seed,
            accent: spec.accent, orbitLineColor: COLOR_ENEMY_ORBIT_LINE,
            formationId: null, formationRole: null, id: spec.id, tracksIntent: true,
          },
          idAllocators, scene,
        ));
        continue;
      }
      const extras: EnemyPlacementExtras = { commanderId: spec.commanderId, tracksIntent: true };
      switch (spec.pattern) {
        case 'phased':
          this.addEnemy(generatePhasedEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
        case 'coelliptic':
          this.addEnemy(generateCoellipticEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.altitudeOffset, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
        case 'crossing':
          this.addEnemy(generateCrossingEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
        case 'elliptic':
          this.addEnemy(generateEllipticEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id, extras,
          ));
          break;
      }
    }
  }

  // ステージ開始時のブリーフィング文言を返す。
  protected briefingHtml(): string {
    return (
      '<b>第3幕 造船</b><br>' +
      '観測拠点の備蓄から素材を払って軌道造船所を建設し、第3幕の自動兵器をすべて排除せよ<br>' +
      '編隊指揮機を落とせば僚機は黙る。襲撃は軌道暦で予報される — 迎撃するか、やり過ごすかは選べる<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 観測拠点を軌道造船所へ格上げする。拠点の備蓄から素材を払い、足りなければ不足を
  // 知らせる(GAME.md 11.2)。完成はキャンペーンへ記録される。
  public buildShipyard(): void {
    if (this.shipyardBuilt) return;
    const stockpile = this.economyLedger.stockpileOf(STORY_EARTH_OBSERVATION_POST_ID);
    if (stockpile.materials < SHIPYARD_CONSTRUCTION_MATERIALS) {
      this._dynamicSystem.events.record({
        kind: 'storyShipyardUnavailable',
        missing: SHIPYARD_CONSTRUCTION_MATERIALS - stockpile.materials,
      });
      return;
    }
    if (!this.economyLedger.charge(STORY_EARTH_OBSERVATION_POST_ID, SHIPYARD_CONSTRUCTION_MATERIALS, 0)) return;
    this.shipyardBuilt = true;
    this.facilityTiers[STORY_EARTH_OBSERVATION_POST_ID] = 'orbital-shipyard';
    this._dynamicSystem.events.record({ kind: 'storyShipyardBuilt' });
  }

  // 補給タイマーと台本の進行(襲撃・幕完了)、経済(初期備蓄の通知・基地の生産・
  // サルベージ回収)を1フレーム分進める。
  public update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (player !== null) this.logistics.updateLogistics(simTime, player, simSpeed);

    // 所要時間つき建造の完了を進める(GAME.md 11.4)。
    this.advanceStoryWorks(simTime);

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
    this.advanceRaids(simTime);
    this.updateRaidStrikes();

    // 造船所の完成と第3幕の敵の排除の両方を終えると、幕が完了する(GAME.md 11.2)。
    if (!this.actCompleted && this.shipyardBuilt
      && this.removedEnemyIds.size >= STORY_ACT3_ENEMY_COUNT) {
      this.actCompleted = true;
      this._dynamicSystem.events.record({ kind: 'storyActCompleted', act: 3 });
    }
  }

  // 敵の消滅を記録する。撃破した敵は id つきでキャンペーンへ知らせ、再入場時に
  // 再配置されないようにする。第3幕の敵が残存から消えたことは幕の完了判定が数える
  // (襲撃の敵は数えない、GAME.md 11.5)。撃破によらない消滅も、名簿の敵については
  // 残存から消えたものとして知らせる — 襲撃の敵の離脱は消滅として扱わない
  // (GAME.md 11.2 / 11.5)。
  public override recordEnemyDeath(
    enemy: Enemy, simTime: number, cause: EnemyDeathCause = 'killed',
  ): void {
    super.recordEnemyDeath(enemy, simTime, cause);
    if (cause === 'killed') {
      this._dynamicSystem.events.record({ kind: 'enemyDefeated', enemyId: enemy.id });
    } else if (STORY_ACT3_ENEMIES.some((spec) => spec.id === enemy.id)) {
      this._dynamicSystem.events.record({ kind: 'enemyLost', enemyId: enemy.id });
    }
    if (STORY_ACT3_ENEMIES.some((spec) => spec.id === enemy.id)) {
      this.removedEnemyIds.add(enemy.id);
    }
  }

  // 撃破した敵は、その質量に応じた素材サルベージを落とす(GAME.md 11.4)。
  protected override salvageDropMaterials(enemy: Enemy): number | null {
    return enemyDropMaterials(enemy.motion.mass);
  }

  // ストーリーモードに敗北はない(GAME.md 11.3)。艦を失っても決着させず、
  // 喪失を評価の集計としてキャンペーンへ知らせる。
  public recordPlayerLost(_reason: string): void {
    this._dynamicSystem.events.record({ kind: 'storyShipLost' });
  }

  // 撃破数による勝利判定はストーリーモードには無い(GAME.md 11.2)。
  protected checkWin(): boolean { return false; }

  // 次の襲撃の節目のうち、simTime より後で最も早いもの。刻みを節目へ合わせ、
  // ワープ中でも予報と出現が抜け落ちないようにする。
  public override nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    const consider = (entry: RaidPlanEntry): void => {
      const milestone = nextRaidMilestoneAt(entry, simTime);
      if (milestone !== null && (next === null || milestone < next)) next = milestone;
    };
    if (this.activeRaidIndex !== null) consider(this.raidEntry(this.activeRaidIndex));
    consider(this.raidEntry(this.nextRaidIndex));
    return next;
  }

  // 節目の時刻で襲撃の進行(予報・出現・離脱)を適用する。
  public override applySimulationEvents(simTime: number): void {
    this.advanceRaids(simTime);
  }

  // 襲撃 index の予定。間隔は対象拠点の公転周期から決まる(GAME.md 11.5)。
  private raidEntry(index: number): RaidPlanEntry {
    return raidPlanEntry(index, 0, this.raidPeriodSeconds(), STORY_EARTH_OBSERVATION_POST_ID);
  }

  // 対象拠点(地球低軌道の円軌道)の公転周期 [sim s]。
  private raidPeriodSeconds(): number {
    if (this.raidPeriodSecondsCache !== null) return this.raidPeriodSecondsCache;
    const earth = this._celestialSystem.find('earth')?.motion;
    const radius = (earth?.def.radius ?? 6_371_000) + EARTH_POST_ALTITUDE;
    const mu = earth?.def.mu ?? 3.986e14;
    this.raidPeriodSecondsCache = 2 * Math.PI * Math.sqrt((radius ** 3) / mu);
    return this.raidPeriodSecondsCache;
  }

  // 襲撃の進行を時刻 simTime まで進める。予報の通知、編隊の出現、接近の通知、
  // 離脱を、局面の移り変わりとして冪等に適用する。
  private advanceRaids(simTime: number): void {
    if (this.activeRaidIndex !== null) {
      const active = this.raidEntry(this.activeRaidIndex);
      const phase = raidPhaseAt(active, simTime);
      if (phase === 'departed') {
        this.departActiveRaid(simTime);
      } else if (phase === 'present' && !this.raidArrivedAnnounced) {
        this.raidArrivedAnnounced = true;
        this._dynamicSystem.events.record({
          kind: 'storyRaidArrived', targetName: this.targetBaseName(),
        });
      }
    }
    if (this.activeRaidIndex !== null) return;

    const entry = this.raidEntry(this.nextRaidIndex);
    const phase = raidPhaseAt(entry, simTime);
    if ((phase === 'forecast' || phase === 'approach' || phase === 'present')
      && !this.raidForecastAnnounced) {
      this.raidForecastAnnounced = true;
      this._dynamicSystem.events.record({
        kind: 'storyRaidForecast',
        targetName: this.targetBaseName(),
        arrivalInSeconds: Math.max(0, entry.arrivalAt - simTime),
      });
    }
    if (phase === 'approach' || phase === 'present') this.spawnRaid(entry);
  }

  // 襲撃編隊を、対象拠点の現在状態を基準に交差軌道へ置く。編隊は拠点へ接近し、
  // 4状態の意図を持つ。
  private spawnRaid(entry: RaidPlanEntry): void {
    const post = this.findBase(STORY_EARTH_OBSERVATION_POST_ID);
    if (post === null) return;
    const attractors = this._celestialSystem.celestialMotions;
    for (let member = 0; member < STORY_ACT3_RAID_ENEMY_COUNT; member++) {
      this.addEnemy(generateCrossingEnemy(
        `襲撃機-${entry.index + 1}-${member + 1}`,
        post.motion.state, attractors, RAID_SPAWN_D_ALONG + member * RAID_SPAWN_SPACING,
        0xff5533, COLOR_ENEMY_ORBIT_LINE, this._scene, this._dynamicSystem.idAllocators,
        storyAct3RaidEnemyId(entry.index, member), { tracksIntent: true },
      ));
    }
    this.activeRaidIndex = entry.index;
    this.nextRaidIndex = entry.index + 1;
    this.raidForecastAnnounced = false;
    this.raidArrivedAnnounced = false;
    this.struckRaiderIds.clear();
  }

  // 残っている襲撃編隊を離脱させる。撃破によらない喪失として数え、素材は落ちない。
  private departActiveRaid(simTime: number): void {
    if (this.activeRaidIndex === null) return;
    const prefix = `story-act3-raid-${this.activeRaidIndex}-`;
    for (const entity of this._dynamicSystem.all().filter(isEnemy)) {
      if (entity.id.startsWith(prefix) && entity.motion.alive) entity.despawn(simTime, this);
    }
    this.activeRaidIndex = null;
    this.raidArrivedAnnounced = false;
    this.struckRaiderIds.clear();
  }

  // 襲撃の損傷を1フレーム分進める。射撃姿勢で拠点の近傍にいる襲撃機は、拠点の
  // 建造ドックへ一度だけ損傷を与える。拠点は損傷するが喪失しない(GAME.md 11.5)。
  private updateRaidStrikes(): void {
    if (this.activeRaidIndex === null) return;
    const post = this.findBase(STORY_EARTH_OBSERVATION_POST_ID);
    if (post === null || !post.motion.alive) return;
    const prefix = `story-act3-raid-${this.activeRaidIndex}-`;
    for (const entity of this._dynamicSystem.all().filter(isEnemy)) {
      if (!entity.id.startsWith(prefix) || !entity.motion.alive) continue;
      if (this.struckRaiderIds.has(entity.id)) continue;
      if (entity.intent !== 'firing-posture') continue;
      if (len(sub(entity.motion.state.r, post.motion.state.r)) > RAID_STRIKE_RANGE) continue;
      this.struckRaiderIds.add(entity.id);
      const dock = post.assembly.modules.find((module) => module.kind === 'dock');
      if (dock === undefined) return;
      post.assembly.damage(RAID_STRIKE_DAMAGE, entity.id.length * 7919, dock.id);
      post.synchronizeAssemblyState();
      this._dynamicSystem.events.record({ kind: 'storyBaseStruck', baseName: post.name });
    }
  }

  // 拠点 id の船体。無ければ null。
  private findBase(baseId: string): ModularShip | null {
    return this._dynamicSystem.all().filter(isModularShip).find((ship) => ship.id === baseId) ?? null;
  }

  // 襲撃の対象拠点の表示名。造船所が完成していればその名で呼ぶ。
  private targetBaseName(): string {
    return this.shipyardBuilt ? '軌道造船所' : '地球観測拠点';
  }

  // いまの目標をステータスパネルへ出す。
  protected hudSubStatus(): string {
    if (this.actCompleted) return '第3幕完了 — 軌道造船所を完成させ、第3幕の敵を排除した';
    const lines: string[] = [];
    if (!this.shipyardBuilt) {
      const stockpile = this.economyLedger.stockpileOf(STORY_EARTH_OBSERVATION_POST_ID);
      lines.push(
        `目標: 観測拠点の備蓄から軌道造船所を建設せよ(素材 ${stockpile.materials} / ${SHIPYARD_CONSTRUCTION_MATERIALS})`,
      );
    }
    const remaining = STORY_ACT3_ENEMY_COUNT - this.removedEnemyIds.size;
    if (remaining > 0) lines.push(`目標: 第3幕の自動兵器を排除せよ(残り ${remaining} 機)`);
    const raidLine = this.raidStatusLine();
    if (raidLine !== null) lines.push(raidLine);
    return lines.join('<br>');
  }

  // 襲撃の予報と接近の状況を1行で出す。予報が出ていない間は null。
  private raidStatusLine(): string | null {
    const simTime = this._dynamicSystem.simTime;
    if (this.activeRaidIndex !== null) {
      return `襲撃中 — ${this.targetBaseName()}を防衛せよ(迎撃しなくても進行は止まらない)`;
    }
    const entry = this.raidEntry(this.nextRaidIndex);
    if (raidPhaseAt(entry, simTime) !== 'forecast') return null;
    const hours = Math.max(1, Math.round((entry.arrivalAt - simTime) / 3600));
    return `襲撃予報 — ${this.targetBaseName()}へ接近まで約 ${hours} 時間`;
  }

  // 共通の内訳へ台本の進行を足して直列化する。
  public serialize(): SerializedStageStoryAct3 {
    return {
      ...super.serialize(),
      actCompleted: this.actCompleted,
      economy: this.economyLedger.serialize(),
      seedAnnounced: this.seedAnnounced,
      lastProductionAt: this.lastProductionAt,
      shipyardBuilt: this.shipyardBuilt,
      removedEnemyIds: [...this.removedEnemyIds],
      nextRaidIndex: this.nextRaidIndex,
      raidForecastAnnounced: this.raidForecastAnnounced,
      activeRaidIndex: this.activeRaidIndex,
      raidArrivedAnnounced: this.raidArrivedAnnounced,
      struckRaiderIds: [...this.struckRaiderIds],
      lastElapsedReportAt: this.lastElapsedReportAt,
    };
  }
}
