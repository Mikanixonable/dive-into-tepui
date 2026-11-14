// ストーリー第1幕「月面スタート」。地表固定の月面基地(GAME.md 7.4)で、あと1モジュールで
// 完成するロケットを建造・分離して月周回軌道へ投入し、漂流デブリを回収すると幕が完了する
// (GAME.md 11.2)。敗北はなく、決着もしない — 進行はキャンペーン状態が持つ。
// 経済はこのステージが台帳を持ち、月面基地は素材と推進剤をゆっくり生産する
// (GAME.md 11.4)。デブリを失った場合は予備を再配置し、幕が完了不能にはならない
// (GAME.md 11.3)。
import { Stage, STORY_EPOCH, type CommonStageState, type SerializedStage, type StageDeps} from './stage';
import { KEY_MAPPING as K} from '../../input/key-mapping';
import { qRotate} from '../../math/quat';
import { add, cross, len, scale, sub, v3} from '../../math/vec3';
import type { CelestialBody} from '../../physics/celestial-body';
import { apsisAltitudes, orbitalElementsFromState} from '../../physics/elements';
import {
addPrimaryRelative, kinematicState, toPrimaryRelative, type KinematicState,
} from '../../physics/kinematic-state';
import type { SimSpeedManager} from '../dynamic/sim-speed-manager';
import { ShipAssembly} from '../ship/ship-assembly';
import { ShipConstructionEdits, type ConstructionShip} from '../ship/ship-construction-edits';
import { ShipDockState, type ShipConstructionDraftState} from '../ship/ship-dock-state';
import { isModularShip, ModularShip} from '../ship/modular-ship';
import { SHIP_MODULE_CATALOG} from '../ship/ship-module-catalog';
import { createShipModuleInstance} from '../ship/ship-module-instance';
import { shipPhysicsShape} from '../ship/ship-physics-shape';
import { createBasePreset} from '../ship/ship-presets';
import {
assemblyOriginHeight, surfaceAnchorAtLatLon, surfaceAnchorPose,
} from '../ship/surface-anchor';
import {
StoryEconomy, enemyDropMaterials,
LUNAR_BASE_INITIAL_MATERIALS, LUNAR_BASE_INITIAL_PROPELLANT,
LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR,
type SerializedStoryEconomy,
} from '../campaign/story-economy';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import { ConstructionScaleGate } from '../campaign/construction-scale-gate';
import { CAMPAIGN_ELAPSED_REPORT_SECONDS, type CampaignState } from '../campaign/campaign-state';

// 月面基地のエンティティ id。回収した素材の備蓄先として、キャンペーン出来事もこの id を指す。
export const STORY_LUNAR_BASE_ID = 'story-lunar-base';
// 漂流デブリのエンティティ id。
export const STORY_LUNAR_DEBRIS_ID = 'story-lunar-debris';
// デブリを回収して得られる素材の量。
export const STORY_LUNAR_DEBRIS_MATERIALS = 120;
// ロケットの建造が進む基地のドック。
const CONSTRUCTION_DOCK_ID = 'dock-left';
// デブリの軌道高度 [m] と、基地の子午線からの位相 [rad]。
const DEBRIS_ALTITUDE = 100_000;
const DEBRIS_PHASE_RAD = (50 * Math.PI) / 180;
// 軌道投入とみなす近地点高度の下限 [m] と、月の中心からの距離の上限 [m]。
const ORBIT_PERIAPSIS_MIN = 500;
const ORBIT_CENTER_DISTANCE_MAX = 20_000_000;
// デブリ回収とみなす距離 [m] と相対速度 [m/s]。
const CAPTURE_DISTANCE = 200;
const CAPTURE_RELATIVE_SPEED = 15;

export interface SerializedStageStoryLunar extends SerializedStage {
readonly orbitReached: boolean;
readonly debrisRecovered: boolean;
readonly actCompleted: boolean;
readonly economy: SerializedStoryEconomy;
readonly seedAnnounced: boolean;
readonly lastProductionAt: number;
readonly debrisId: string;
readonly debrisRespawns: number;
readonly lastElapsedReportAt: number;
}

// 月面基地の開始状態: 基地 preset のドックに、あと推進器1つで完成するロケットの建造予約が
// 途中まで進んだ assembly と、その予約。実艦を作る前に組むため、建造の同期先は要らない。
export function buildStoryLunarBaseAssembly(): {
assembly: ShipAssembly;
dockState: readonly ShipConstructionDraftState[];
} {
const assembly = createBasePreset();
const docks = new ShipDockState();
const facade: ConstructionShip = {
id: STORY_LUNAR_BASE_ID,
assembly,
docks,
capabilities: { controllable: true},
motion: { alive: true},
synchronizeAssemblyState: () => undefined,
};
const edits = new ShipConstructionEdits(facade, CONSTRUCTION_DOCK_ID);
edits.begin();
edits.place('cockpit-standard', 'axial', 'rocket-cockpit');
edits.place('tank-combat-main', 'axial', 'rocket-main-tank');
edits.place('tank-combat-rcs', 'axial', 'rocket-rcs-tank');
edits.place('rcs-combat', 'axial', 'rocket-rcs');
edits.place('solar-panel-standard', 'rocket-main-tank:side-x', 'rocket-solar-left');
edits.place('solar-panel-standard', 'rocket-main-tank:side+x', 'rocket-solar-right');
edits.place('radiator-standard', 'rocket-main-tank:side-y', 'rocket-radiator');
edits.place('docking-port-standard', 'rocket-main-tank:side+y', 'rocket-docking-port');
// 推進器は置かない — 完成はプレイヤーの最初の建造に委ねる。
return { assembly, dockState: docks.serialize()};
}

// 漂流デブリの assembly。コックピットを持たない旧時代の衛星で、ドッキングでも取り込める。
export function buildStoryLunarDebrisAssembly(): ShipAssembly {
const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, false);
const instance = (definitionId: string, id: string) =>
createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
assembly.addRoot(instance('tank-6-main', 'debris-tank'));
assembly.connectSide(instance('docking-port-standard', 'debris-docking-port'), 'debris-tank', 'side:+y');
assembly.connectSide(instance('solar-panel-standard', 'debris-solar'), 'debris-tank', 'side:+x');
assembly.connectSide(instance('radiator-standard', 'debris-radiator'), 'debris-tank', 'side:-x');
assembly.assertValid();
return assembly;
}

// 時刻 t のデブリの初期状態: 天体の赤道上を、基地の子午線から位相ぶん先行する円軌道。
// 基地を置く天体ならどれでも同じ形に置ける。
export function storyLunarDebrisState(body: CelestialBody, t: number): KinematicState {
const spin = body.spinRotationAt(t);
const meridian = spin === null? v3(1, 0, 0): qRotate(spin.q, v3(1, 0, 0));
const east = spin === null? v3(0, 1, 0): qRotate(spin.q, v3(0, 1, 0));
const pole = spin === null? v3(0, 0, 1): qRotate(spin.q, v3(0, 0, 1));
const direction = add(
scale(meridian, Math.cos(DEBRIS_PHASE_RAD)), scale(east, Math.sin(DEBRIS_PHASE_RAD)),
);
const radius = body.def.radius + DEBRIS_ALTITUDE;
const speed = Math.sqrt(body.def.mu / radius);
const rel = kinematicState<'primaryRel'>(
t, scale(direction, radius), scale(cross(pole, direction), speed),
);
return addPrimaryRelative(body.stateAt(t), rel);
}

// state が天体 body のまわりで、地表より上に近地点を持つ軌道へ投入されたかどうか。
export function isInOrbitAround(state: KinematicState, body: CelestialBody): boolean {
const bodyState = body.stateAt(state.t);
const rel = toPrimaryRelative(state.t, state, bodyState);
if (len(rel.r) > ORBIT_CENTER_DISTANCE_MAX) return false;
const elements = orbitalElementsFromState(rel, body, bodyState);
if (elements === null || elements.e >= 1) return false;
return apsisAltitudes(elements).pe > ORBIT_PERIAPSIS_MIN;
}

export class StageStoryLunar extends Stage {
public static readonly id = 'story-lunar' as const;
public static readonly epoch = STORY_EPOCH;
public static readonly selectLabel = 'ストーリー 第1幕';
public static readonly selectSub = ' 月面基地でロケットを完成させ、月周回軌道へ打ち上げる';
// キャンペーンの各幕は内部のステージで、一覧には並ばない(GAME.md 11.2)。
public static readonly hiddenFromSelect = true;

// 経済の台帳。出来事の送り先は動的システムのイベント記録。
private readonly economyLedger: StoryEconomy;

// 規模ゲート。月面基地は地表基地の格で、建造できる総質量に上限を持つ(GAME.md 11.2)。
private readonly scaleGate = new ConstructionScaleGate({
[STORY_LUNAR_BASE_ID]: 'surface-base',
});

// 台本の進行(軌道投入・デブリ回収・幕完了の記録済みかどうか)と共通の状態から組む。
// 経済の台帳は、復元でなければ動的システムのイベント記録を送り先に新しく作る。
// 初期備蓄を知らせ済みかどうか、生産の積算に使う前回の時刻、現在の回収対象デブリの
// id と予備の再配置回数も台本の進行として持つ。
private constructor(
deps: StageDeps,
private orbitReached = false,
private debrisRecovered = false,
private actCompleted = false,
storyEconomy: StoryEconomy | null = null,
private seedAnnounced = false,
private lastProductionAt = 0,
private currentDebrisId: string = STORY_LUNAR_DEBRIS_ID,
private debrisRespawns = 0,
private lastElapsedReportAt = 0,
...common: CommonStageState
) {
super(deps,...common);
this.economyLedger = storyEconomy ?? new StoryEconomy(this._dynamicSystem.events);
}

// このステージの経済。建造・修理・製造・給油はここから備蓄を払う。
public override get economy(): StoryEconomy { return this.economyLedger; }

// このステージの規模ゲート。月面基地での建造が照らされる。
public override get constructionGate(): ConstructionScaleGate { return this.scaleGate; }

// 月面基地と未完成のロケット、漂流デブリを置いて始める。
// 経済の台帳には初期備蓄を入れる。キャンペーンへの通知は最初のフレームで行う。
public static create(...deps: StageDeps): StageStoryLunar {
const stage = new StageStoryLunar(deps);
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
public static createFromCampaign(campaign: CampaignState,...deps: StageDeps): StageStoryLunar {
const inherited = campaign.stockpiles[STORY_LUNAR_BASE_ID]!== undefined;
const stage = new StageStoryLunar(
deps, false, false, false,
new StoryEconomy(deps[2].events, campaign.stockpiles),
inherited,
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
serialized: SerializedStageStoryLunar | null,...deps: StageDeps
): StageStoryLunar {
return new StageStoryLunar(
deps,
serialized?.orbitReached?? false,
serialized?.debrisRecovered?? false,
serialized?.actCompleted?? false,
serialized?.economy == null
? null
: StoryEconomy.deserialize(serialized.economy, deps[2].events),
serialized?.seedAnnounced?? false,
serialized?.lastProductionAt?? 0,
serialized?.debrisId?? STORY_LUNAR_DEBRIS_ID,
serialized?.debrisRespawns?? 0,
serialized?.lastElapsedReportAt?? 0,
...Stage.deserializeCommonState(serialized, deps, StageStoryLunar.stageRules),
);
}

// 開始状態を置く。基地は月の赤道・本初子午線の地表に固定し、その横のドックで建造中の
// ロケットごと錨へ載せる。
private setupInitialPlacement(): void {
const moon = this._celestialSystem.find('moon')?.motion;
if (moon === undefined || moon === null) throw new Error('story lunar: moon not found');
const { assembly, dockState} = buildStoryLunarBaseAssembly();
const anchor = surfaceAnchorAtLatLon(
moon.def.id, moon.def.radius, 0, 0, assemblyOriginHeight(assembly),
);
const shape = shipPhysicsShape(assembly);
if (shape === null) throw new Error('story lunar: base assembly has no physics shape');
const pose = surfaceAnchorPose(anchor, moon, 0, shape.centerOffset);
this.addPlayer({
name: '月面基地',
id: STORY_LUNAR_BASE_ID,
assembly,
dockState,
state: pose.state,
att: { q: pose.q, w: pose.w, inertia: v3(1, 1, 1)},
surfaceAnchor: anchor,
});
const debris = ModularShip.create(
{
name: 'デブリ（旧時代の衛星）',
id: STORY_LUNAR_DEBRIS_ID,
assembly: buildStoryLunarDebrisAssembly(),
state: storyLunarDebrisState(moon, 0),
},
this._dynamicSystem,
this._scene,
);
this._dynamicSystem.add(debris);
}

// ステージ開始時のブリーフィング文言を返す。
protected briefingHtml(): string {
return (
'<b>第1幕 月面スタート</b><br>' +
'地球の自動兵器に阻まれ、人類は月に留まっている — 再植民への第一歩はこの基地から<br>' +
'ドックで建造中のロケットは、あと推進器1つで完成する。建造を終えて切り離し、月周回軌道へ打ち上げよ<br>' +
`[${K.help.label}] キーで操作方法を表示`
);
}

// 補給タイマーと台本の進行(軌道投入・デブリ回収・幕完了)、経済(初期備蓄の通知・
// 基地の生産・サルベージ回収)を1フレーム分進める。
public update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
const player = this.ship;
if (player!== null) this.logistics.updateLogistics(simTime, player, simSpeed);

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

const moon = this._celestialSystem.find('moon')?.motion;
if (moon === undefined || moon === null) return;
const ships = this._dynamicSystem.all().filter(isModularShip);

if (!this.orbitReached) {
const launched = ships.find((ship) =>
ship.id!== STORY_LUNAR_BASE_ID && ship.id!== this.currentDebrisId
&& ship.motion.alive && isInOrbitAround(ship.motion.state, moon));
if (launched!== undefined) this.orbitReached = true;
}

if (!this.debrisRecovered) this.updateDebrisRecovery(ships, moon, simTime);

if (this.orbitReached && this.debrisRecovered &&!this.actCompleted) {
this.actCompleted = true;
this._dynamicSystem.events.record({ kind: 'storyActCompleted', act: 1});
}
}

// 撃破した敵は、その質量に応じた素材サルベージを落とす(GAME.md 11.4)。
protected override salvageDropMaterials(enemy: Enemy): number | null {
return enemyDropMaterials(enemy.motion.mass);
}

// デブリの回収判定。接近して相対速度を落とした船があればその場で回収し、ドッキングで
// 取り込まれた場合はデブリのモジュールが船体へ移ったことから回収とみなす。
// どちらでもなくデブリが失われていたら、幕が完了不能にならないよう予備を再配置する
// (GAME.md 11.3)。
private updateDebrisRecovery(
ships: readonly ModularShip[], moon: CelestialBody, simTime: number,
): void {
const debris = ships.find((ship) => ship.id === this.currentDebrisId);
const heldByDocking = ships.some((ship) =>
ship.id!== this.currentDebrisId && ship.assembly.moduleIds.includes('debris-tank'));
if (!heldByDocking && debris!== undefined && debris.motion.alive) {
const capturer = ships.find((ship) =>
ship.id!== this.currentDebrisId && ship.id!== STORY_LUNAR_BASE_ID
&& ship.motion.alive
&& len(sub(ship.motion.state.r, debris.motion.state.r)) < CAPTURE_DISTANCE
&& len(sub(ship.motion.state.v, debris.motion.state.v)) < CAPTURE_RELATIVE_SPEED);
if (capturer === undefined) return;
debris.motion.kill();
} else if (!heldByDocking) {
this.replaceLostDebris(moon, simTime);
return;
}
this.debrisRecovered = true;
this.economyLedger.credit(STORY_LUNAR_BASE_ID, STORY_LUNAR_DEBRIS_MATERIALS, 0);
this._dynamicSystem.events.record({
kind: 'materialsRecovered', baseId: STORY_LUNAR_BASE_ID, materials: STORY_LUNAR_DEBRIS_MATERIALS,
});
}

// 失われたデブリの代わりに、同じ軌道へ予備デブリを1つ置く。
private replaceLostDebris(moon: CelestialBody, simTime: number): void {
this.debrisRespawns += 1;
this.currentDebrisId = `${STORY_LUNAR_DEBRIS_ID}-${this.debrisRespawns + 1}`;
const debris = ModularShip.create(
{
name: 'デブリ（旧時代の衛星）',
id: this.currentDebrisId,
assembly: buildStoryLunarDebrisAssembly(),
state: storyLunarDebrisState(moon, simTime),
},
this._dynamicSystem,
this._scene,
);
this._dynamicSystem.add(debris);
this._dynamicSystem.events.record({ kind: 'storyDebrisReplaced'});
}

// ストーリーモードに敗北はない(GAME.md 11.3)。艦を失っても決着させず、
// 喪失を評価の集計としてキャンペーンへ知らせる。
public recordPlayerLost(_reason: string): void {
this._dynamicSystem.events.record({ kind: 'storyShipLost' });
}

// 撃破数による勝利判定はストーリーモードには無い(GAME.md 11.2)。
protected checkWin(): boolean { return false;}

// いまの目標をステータスパネルへ出す。
protected hudSubStatus(): string {
if (this.actCompleted) return '第1幕完了 — キャンペーンは第2幕へ進んだ';
if (!this.orbitReached &&!this.debrisRecovered) {
return '目標: ロケットを完成させて月周回軌道へ投入し、漂流デブリを回収せよ';
}
if (!this.orbitReached) return '目標: ロケットを月周回軌道へ投入せよ';
if (!this.debrisRecovered) {
const debris = this._dynamicSystem.all().filter(isModularShip)
.find((ship) => ship.id === this.currentDebrisId);
const player = this.ship;
if (debris!== undefined && player!== null) {
const distance = len(sub(player.motion.state.r, debris.motion.state.r));
return `目標: 漂流デブリを回収せよ(あと ${(distance / 1000).toFixed(1)} km — 接近して相対速度を落とすと回収できる)`;
}
return '目標: 漂流デブリを回収せよ(接近して相対速度を落とすと回収できる)';
}
return '目標: 完了まであとわずか';
}

// 共通の内訳へ台本の進行を足して直列化する。
public serialize(): SerializedStageStoryLunar {
return {
...super.serialize(),
orbitReached: this.orbitReached,
debrisRecovered: this.debrisRecovered,
actCompleted: this.actCompleted,
economy: this.economyLedger.serialize(),
seedAnnounced: this.seedAnnounced,
lastProductionAt: this.lastProductionAt,
debrisId: this.currentDebrisId,
debrisRespawns: this.debrisRespawns,
lastElapsedReportAt: this.lastElapsedReportAt,
};
}
}
