// ストーリー第2幕「進出」。月面基地と月周回軌道の中継ドックを拠点に地球低軌道へ進出し、
// 初の実戦(金属機6機)に勝って地球低軌道の観測拠点を確保すると幕が完了する(GAME.md 11.2)。
// 敗北はなく、決着もしない — 進行はキャンペーン状態が持つ。経済の台帳はキャンペーンの
// 備蓄を引き継ぎ、月面基地は素材と推進剤をゆっくり生産する(GAME.md 11.4)。撃破した敵は
// 素材サルベージを落とし、回収で経済の循環が閉じる。
import { Stage, STORY_EPOCH, type CommonStageState, type SerializedStage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { qRotate } from '../../math/quat';
import { add, cross, scale, v3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import {
  addPrimaryRelative, kinematicState, type KinematicState,
} from '../../physics/kinematic-state';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { shipPhysicsShape } from '../ship/ship-physics-shape';
import { createBasePreset, createDefaultCombatPreset } from '../ship/ship-presets';
import {
  assemblyOriginHeight, surfaceAnchorAtLatLon, surfaceAnchorPose,
} from '../ship/surface-anchor';
import { buildStoryLunarBaseAssembly, STORY_LUNAR_BASE_ID } from './stage-story-lunar';
import {
  generateCoellipticEnemy, generateCrossingEnemy, generateEllipticEnemy, generatePhasedEnemy,
} from './spawner/enemy-generator';
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
import { CAMPAIGN_ELAPSED_REPORT_SECONDS, type CampaignState } from '../campaign/campaign-state';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { EnemyDeathCause } from './stage-outcome';

// 月周回軌道の中継ドックのエンティティ id。
export const STORY_LUNAR_ORBIT_DOCK_ID = 'story-lunar-orbit-dock';
// 地球低軌道の観測拠点のエンティティ id。
export const STORY_EARTH_OBSERVATION_POST_ID = 'story-earth-observation-post';
// 第2幕の敵の総数(GAME.md 11.2)。
export const STORY_ACT2_ENEMY_COUNT = 6;

// 第2幕の拠点と規模ゲートの格の対応。月面基地は地表基地、軌道上の2拠点は軌道ドック。
export const STORY_ACT2_FACILITY_TIERS: Readonly<Record<string, ConstructionFacilityTier>> = {
  [STORY_LUNAR_BASE_ID]: 'surface-base',
  [STORY_LUNAR_ORBIT_DOCK_ID]: 'orbital-dock',
  [STORY_EARTH_OBSERVATION_POST_ID]: 'orbital-dock',
};

// 中継ドックの軌道高度 [m]、基地の子午線からの位相 [rad]、プレイヤー船の位相のずらし [rad]。
const LUNAR_ORBIT_ALTITUDE = 100_000;
const DOCK_PHASE_RAD = (-30 * Math.PI) / 180;
const PLAYER_PHASE_OFFSET_RAD = (0.3 * Math.PI) / 180;
// 観測拠点の軌道高度 [m] と、地球の子午線からの位相 [rad]。
const EARTH_POST_ALTITUDE = 420_000;
const EARTH_POST_PHASE_RAD = (20 * Math.PI) / 180;

// 敵1機ぶんの配置。すべて金属機で、観測拠点の状態を基準に近傍軌道へ散らす。
// id はキャンペーンの撃破記録と対応する安定した識別子で、再入場時に撃破済みの
// 敵を再配置しないために使う(GAME.md 11.2)。
export interface StoryAct2EnemySpec {
  readonly id: string;
  readonly name: string;
  readonly kind: 'phased' | 'coelliptic' | 'crossing' | 'elliptic';
  // 基準の状態から軌道面内で進める弧長 [m]。
  readonly dAlong: number;
  // 高度のずらし [m]。coelliptic の配置だけが使う。
  readonly altitudeOffset: number;
  readonly accent: number;
}

// 第2幕の敵の配置表(GAME.md 11.2: 金属機6機)。
export const STORY_ACT2_ENEMIES: readonly StoryAct2EnemySpec[] = [
  { id: 'story-act2-enemy-1', name: '自動兵器-α', kind: 'phased', dAlong: 1400, altitudeOffset: 0, accent: 0xff4a3d },
  { id: 'story-act2-enemy-2', name: '自動兵器-β', kind: 'coelliptic', dAlong: -2800, altitudeOffset: 2500, accent: 0xff7a2d },
  { id: 'story-act2-enemy-3', name: '自動兵器-γ', kind: 'crossing', dAlong: 2200, altitudeOffset: 0, accent: 0xe0409f },
  { id: 'story-act2-enemy-4', name: '自動兵器-δ', kind: 'elliptic', dAlong: 5000, altitudeOffset: 0, accent: 0xbf3dff },
  { id: 'story-act2-enemy-5', name: '自動兵器-ε', kind: 'phased', dAlong: 20000, altitudeOffset: 0, accent: 0xff2d6b },
  { id: 'story-act2-enemy-6', name: '自動兵器-ζ', kind: 'coelliptic', dAlong: 9000, altitudeOffset: -1500, accent: 0x3d7bff },
];

// 時刻 t の円軌道の状態: 天体の赤道上を、子午線から位相 phaseRad ぶん先行する。
// 基地を置く天体ならどれでも同じ形に置ける。
export function storyAct2CircularOrbitState(
  body: CelestialBody, t: number, altitude: number, phaseRad: number,
): KinematicState {
  const spin = body.spinRotationAt(t);
  const meridian = spin === null ? v3(1, 0, 0) : qRotate(spin.q, v3(1, 0, 0));
  const east = spin === null ? v3(0, 1, 0) : qRotate(spin.q, v3(0, 1, 0));
  const pole = spin === null ? v3(0, 0, 1) : qRotate(spin.q, v3(0, 0, 1));
  const direction = add(scale(meridian, Math.cos(phaseRad)), scale(east, Math.sin(phaseRad)));
  const radius = body.def.radius + altitude;
  const speed = Math.sqrt(body.def.mu / radius);
  const rel = kinematicState<'primaryRel'>(
    t, scale(direction, radius), scale(cross(pole, direction), speed),
  );
  return addPrimaryRelative(body.stateAt(t), rel);
}

// 時刻 t の中継ドックの初期状態(月周回軌道)。
export function storyLunarOrbitDockState(body: CelestialBody, t: number): KinematicState {
  return storyAct2CircularOrbitState(body, t, LUNAR_ORBIT_ALTITUDE, DOCK_PHASE_RAD);
}

// 時刻 t の観測拠点の初期状態(地球低軌道)。
export function storyEarthObservationPostState(body: CelestialBody, t: number): KinematicState {
  return storyAct2CircularOrbitState(body, t, EARTH_POST_ALTITUDE, EARTH_POST_PHASE_RAD);
}

export interface SerializedStageStoryAct2 extends SerializedStage {
  readonly actCompleted: boolean;
  readonly economy: SerializedStoryEconomy;
  readonly seedAnnounced: boolean;
  readonly lastProductionAt: number;
  readonly lastElapsedReportAt: number;
}

export class StageStoryAct2 extends Stage {
  public static readonly id = 'story-act2' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'ストーリー 第2幕';
  public static readonly selectSub = ' 月軌道ドックから地球低軌道へ進出し、初の実戦に勝つ';
  // キャンペーンの各幕は内部のステージで、一覧には並ばない(GAME.md 11.2)。
  public static readonly hiddenFromSelect = true;

  // 経済の台帳。出来事の送り先は動的システムのイベント記録。
  private readonly economyLedger: StoryEconomy;

  // 規模ゲート。第2幕の拠点の格は STORY_ACT2_FACILITY_TIERS が持つ(GAME.md 11.2)。
  private readonly scaleGate = new ConstructionScaleGate(STORY_ACT2_FACILITY_TIERS);

  // 台本の進行(幕完了の記録済みかどうか)と共通の状態から組む。経済の台帳は、復元で
  // なければ動的システムのイベント記録を送り先に新しく作る。初期備蓄を知らせ済みか
  // どうかと、生産の積算に使う前回の時刻も台本の進行として持つ。defeatedEnemyIds は
  // キャンペーンが記録した撃破済みの敵で、初期配置から除く。
  private constructor(
    deps: StageDeps,
    private actCompleted = false,
    storyEconomy: StoryEconomy | null = null,
    private seedAnnounced = false,
    private lastProductionAt = 0,
    private readonly defeatedEnemyIds: ReadonlySet<string> = new Set(),
    private lastElapsedReportAt = 0,
    ...common: CommonStageState
  ) {
    super(deps, ...common);
    this.economyLedger = storyEconomy ?? new StoryEconomy(this._dynamicSystem.events);
  }

  // このステージの経済。建造・修理・製造・給油はここから備蓄を払う。
  public override get economy(): StoryEconomy { return this.economyLedger; }

  // このステージの規模ゲート。第2幕の拠点での建造が照らされる。
  public override get constructionGate(): ConstructionScaleGate { return this.scaleGate; }

  // 月面基地の初期備蓄を台帳へ入れて始める。キャンペーンへの通知は最初のフレームで行う。
  public static create(...deps: StageDeps): StageStoryAct2 {
    const stage = new StageStoryAct2(deps);
    stage.economyLedger.credit(
      STORY_LUNAR_BASE_ID, LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
    );
    stage.setupInitialPlacement();
    stage.composeBriefing();
    return stage;
  }

  // キャンペーンの備蓄を引き継いで始める。台帳はキャンペーンの備蓄から組まれ、
  // 月面基地の備蓄が既にあれば初期備蓄の通知は行わない。備蓄が無ければ新規の
  // キャンペーンとして、create と同じく初期備蓄を入れて最初のフレームで通知する
  // (GAME.md 11.2)。
  public static createFromCampaign(campaign: CampaignState, ...deps: StageDeps): StageStoryAct2 {
    const inherited = campaign.stockpiles[STORY_LUNAR_BASE_ID] !== undefined;
    const stage = new StageStoryAct2(
      deps, false, new StoryEconomy(deps[2].events, campaign.stockpiles), inherited, 0,
      new Set(campaign.defeatedEnemyIds),
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
    serialized: SerializedStageStoryAct2 | null, ...deps: StageDeps
  ): StageStoryAct2 {
    return new StageStoryAct2(
      deps,
      serialized?.actCompleted ?? false,
      serialized?.economy == null
        ? null
        : StoryEconomy.deserialize(serialized.economy, deps[2].events),
      serialized?.seedAnnounced ?? false,
      serialized?.lastProductionAt ?? 0,
      new Set(),
      serialized?.lastElapsedReportAt ?? 0,
      ...Stage.deserializeCommonState(serialized, deps, StageStoryAct2.stageRules),
    );
  }

  // 開始状態を置く。プレイヤー船(操作対象)を月周回軌道の中継ドックの近傍へ、月面基地を
  // 第1幕と同じ地表固定の開始状態で、観測拠点を地球低軌道へ置き、敵を観測拠点の
  // 近傍軌道へ散らす。
  private setupInitialPlacement(): void {
    const moon = this._celestialSystem.find('moon')?.motion;
    const earth = this._celestialSystem.find('earth')?.motion;
    if (moon === undefined || moon === null) throw new Error('story act2: moon not found');
    if (earth === undefined || earth === null) throw new Error('story act2: earth not found');

    this.addPlayer({
      name: '進出船',
      assembly: createDefaultCombatPreset(),
      state: storyAct2CircularOrbitState(
        moon, 0, LUNAR_ORBIT_ALTITUDE, DOCK_PHASE_RAD + PLAYER_PHASE_OFFSET_RAD,
      ),
    });

    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    const anchor = surfaceAnchorAtLatLon(
      moon.def.id, moon.def.radius, 0, 0, assemblyOriginHeight(assembly),
    );
    const shape = shipPhysicsShape(assembly);
    if (shape === null) throw new Error('story act2: base assembly has no physics shape');
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
      name: '地球観測拠点',
      id: STORY_EARTH_OBSERVATION_POST_ID,
      assembly: createBasePreset(),
      state: postState,
    });

    this.addAct2Enemies(postState);
  }

  // 第2幕の敵を、観測拠点の状態を基準に近傍軌道へ散らして置く。キャンペーンに
  // 撃破済みとして記録された敵は二度と戻らないため、置かない(GAME.md 11.2)。
  private addAct2Enemies(referenceState: KinematicState): void {
    const attractors = this._celestialSystem.celestialMotions;
    const scene = this._scene;
    const idAllocators = this._dynamicSystem.idAllocators;
    for (const spec of STORY_ACT2_ENEMIES) {
      if (this.defeatedEnemyIds.has(spec.id)) continue;
      switch (spec.kind) {
        case 'phased':
          this.addEnemy(generatePhasedEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id,
          ));
          break;
        case 'coelliptic':
          this.addEnemy(generateCoellipticEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.altitudeOffset, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id,
          ));
          break;
        case 'crossing':
          this.addEnemy(generateCrossingEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id,
          ));
          break;
        case 'elliptic':
          this.addEnemy(generateEllipticEnemy(
            spec.name, referenceState, attractors, spec.dAlong, spec.accent,
            COLOR_ENEMY_ORBIT_LINE, scene, idAllocators, spec.id,
          ));
          break;
      }
    }
  }

  // 敵の消滅を記録する。消滅した敵は id つきでキャンペーンへ知らせ、再入場時に
  // 再配置されないようにする。撃破によらない消滅も残存から消えたものとして
  // 知らせるが、撃破数には数えない(GAME.md 11.2)。
  public override recordEnemyDeath(
    enemy: Enemy, simTime: number, cause: EnemyDeathCause = 'killed',
  ): void {
    super.recordEnemyDeath(enemy, simTime, cause);
    if (cause === 'killed') {
      this._dynamicSystem.events.record({ kind: 'enemyDefeated', enemyId: enemy.id });
    } else if (STORY_ACT2_ENEMIES.some((spec) => spec.id === enemy.id)) {
      this._dynamicSystem.events.record({ kind: 'enemyLost', enemyId: enemy.id });
    }
  }

  // ステージ開始時のブリーフィング文言を返す。
  protected briefingHtml(): string {
    return (
      '<b>第2幕 進出</b><br>' +
      '月軌道ドックを中継して地球低軌道へ進出し、観測拠点の周囲の自動兵器を全て撃破せよ<br>' +
      '撃破した敵は素材を落とす — 回収して拠点へ持ち帰れば、修理と建造に使える<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 補給タイマーと台本の進行(幕完了)、経済(初期備蓄の通知・基地の生産・サルベージ
  // 回収)を1フレーム分進める。
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

    // 敵が全て残存から消えたら観測拠点の確保が完了し、幕が完了する(GAME.md 11.2)。
    if (!this.actCompleted && this.enemiesAppeared > 0
      && this.scoreCounter.kills + this.scoreCounter.losses >= this.enemiesAppeared) {
      this.actCompleted = true;
      this._dynamicSystem.events.record({ kind: 'storyActCompleted', act: 2 });
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

  // いまの目標をステータスパネルへ出す。
  protected hudSubStatus(): string {
    if (this.actCompleted) return '第2幕完了 — 地球低軌道の観測拠点を確保した';
    const remaining = this.enemiesAppeared - this.scoreCounter.kills - this.scoreCounter.losses;
    return `目標: 地球低軌道の自動兵器を全て撃破し、観測拠点を確保せよ(残り ${remaining} 機)`;
  }

  // 共通の内訳へ台本の進行を足して直列化する。
  public serialize(): SerializedStageStoryAct2 {
    return {
      ...super.serialize(),
      actCompleted: this.actCompleted,
      economy: this.economyLedger.serialize(),
      seedAnnounced: this.seedAnnounced,
      lastProductionAt: this.lastProductionAt,
      lastElapsedReportAt: this.lastElapsedReportAt,
    };
  }
}
