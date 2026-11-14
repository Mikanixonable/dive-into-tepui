// 全ステージ共通の宣言部。Stage 基底と、その具象・launcher が共有する型・直列化形・
// 周回の始め方を置く。実装は stage.ts。
import type * as THREE from 'three/webgpu';
import type { TdbJulianDate } from '../../physics/time';
import type { HudLayers } from '../hud/hud-layers';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { ControlSelection } from '../control-selection';
import type { CommandQueue } from '../command-queue';
import type { OrbitSlotRegistry } from '../navigation/orbit-slot-registry';
import type { ShipBlueprintShelf } from '../ship/ship-blueprint';
import type { SalvageKind } from '../ship/salvage-blueprints';
import type { StageRules } from './stage-rules';
import type { PlayerLossCause } from './stage-outcome';
import type { ScoreCounter } from './stage-utils/score-counter';
import type { SerializedScoreCounter } from './stage-utils/score-counter';
import type { Logistics } from './stage-utils/logistics';
import type { SerializedLogistics } from './stage-utils/logistics';
import type { SalvageCargo } from './stage-utils/salvage-cargo';
import type { Stage } from './stage';

export type StageId = '00' | '0' | '1' | '2' | 'creative' | 'debug' | 'debug-alt-system' | 'debug-load';

// 全ステージ共通の協力者。create・deserialize が受け、基底のコンストラクタへそのまま渡す。
export type StageDeps = [
  hud: HudLayers,
  scene: THREE.Scene,
  dynamicSystem: EntityRegistry & EntityRoster,
  celestialSystem: CelestialSystem,
  controlSelection: ControlSelection,
  commandQueue: CommandQueue,
  orbitSlots: OrbitSlotRegistry,
  // セーブスロットの設計図の棚の読み取り面。鹵獲の授与が既に棚にある同名を除くために読む。
  blueprintShelf: ShipBlueprintShelf,
];

// 全ステージ共通の状態(スコア・決着状態・補給)。基底のコンストラクタが deps の後ろに受け、
// 省いたものは新しいランの初期値から始まる。
export type CommonStageState = [
  scoreCounter?: ScoreCounter, phase?: GamePhase, logistics?: Logistics, reinforced?: boolean,
  salvageCargo?: SalvageCargo, revealedBodies?: readonly string[],
];

// ステージクラスの静的側。起動時の設定はここから読む。
export interface StageClass {
  readonly id: StageId;
  readonly stageRules: StageRules;
  createCelestialSystem(
    epoch: TdbJulianDate, onProgress?: (ratio: number) => void, renderer?: THREE.WebGPURenderer,
  ): Promise<CelestialSystem>;
  // simTime=0 に置く絶対時刻。基底に既定値は無く、全ステージが自分で宣言する —
  // 置くと宣言し忘れが型検査に落ちなくなり、元期が共有の定数へ静かに戻る。
  readonly epoch: TdbJulianDate;
  // 開始前にプレイヤーへ開始日時を選ばせるか(GAME.md 9.0)。選ばせないステージは epoch で始まる。
  readonly picksStartEpoch: boolean;
  // 勝敗を判定するか。判定しないステージは勝利せず、セーブ枠の解放の記録を読まない(GAME.md「天体の解放」)。
  readonly judgesOutcome: boolean;
  // 選択画面が読む項目。
  readonly selectLabel: string;
  readonly selectSub: string;
  readonly selectLockedSub: string | null;
  // 行に出し、押されたら選ぶキー。持たないステージは null(SPEC GAME.md 1)。
  readonly selectKey: string | null;
  readonly selectGroup: string;
  readonly hiddenFromSelect: boolean;
  isUnlocked(clearCounts: ClearCounts): boolean;
  // 新しいランのステージを組み、初期配置を置く。
  create(...deps: StageDeps): Stage;
  // このステージクラスが直列化した形 serialized から復元する。記録が欠けていれば(null)、
  // 新しいランの初期値で補う。
  deserialize(serialized: SerializedStage | null, ...deps: StageDeps): Stage;
}

// ステージ ID → クリア回数(周回数によるアンロックに備えて、クリアの有無でなく回数で持つ)。
export type ClearCounts = Readonly<Record<string, number>>;

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

// 全ステージ共通の内訳(スコア・決着状態・補給タイマー)。ステージ固有の内訳は、これを拡張した
// 型に持つ。
export interface SerializedStage {
  readonly scoreCounter: SerializedScoreCounter;
  readonly phase: GamePhase;
  readonly logistics: SerializedLogistics;
  // 援護付きの再出撃か。古い記録には無いので欠けは援護なしとして読む。
  readonly reinforced?: boolean;
  // 補給艇で届けていない積荷。欠けた記録は空の待ち行列から始まる。
  readonly pendingSalvageCargo?: readonly SalvageKind[];
  // 解放された天体の id。欠けた記録は太陽・地球・月だけから始める。
  readonly revealedBodies?: readonly string[];
}

// 1周回の成績。撃破・命中・生存の値を結果画面と記録の両方が読む。
export interface RunStats {
  readonly kills: number;
  readonly appeared: number; // 戦場に現れた敵の数
  readonly shots: number;
  readonly hits: number;
  readonly survivalSec: number; // シミュレーション時間 [s]
}

// 決着した周回の結果画面に出す内容。stats と lossCause は、ステージが決着を記録したときだけ持つ
// (セーブに含まれない結果の代わりには null)。
export interface StageResult {
  readonly win: boolean;
  // 結果画面の見出し。null なら勝敗から決まる既定の見出し。
  readonly title: string | null;
  readonly detailHtml: string;
  readonly stats: RunStats | null;
  // 敗北の原因。勝利と原因の無い決着では null。
  readonly lossCause: PlayerLossCause | null;
}

// 周回の始め方で決まる選択。再出撃のたびに launcher が決めて、周回を組むときに渡す。
export interface RunOptions {
  // 援護付きの再出撃か(→ applyRunOptions)。
  readonly reinforced: boolean;
  // 連敗の予告を出すか。予告を持つステージだけが読む。
  readonly forecast: boolean;
  // このランの開始時点で解放されている天体の id。勝敗を判定しないステージには基底の天体だけを渡す。
  readonly revealedBodies: readonly string[];
}

// 生存時間を T+ の時分秒で書く。
export function missionTimeText(seconds: number): string {
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${Math.floor(seconds % 60)}s`;
}

// 撃破・命中・生存の要約。勝敗に関わらず結果画面の本文に同じ形で出す。
export function summaryHtml(stats: RunStats): string {
  const rate = stats.appeared > 0 ? (stats.kills / stats.appeared) * 100 : 0;
  const accuracy = stats.shots > 0 ? (stats.hits / stats.shots) * 100 : 0;
  const perKill = stats.kills > 0 ? (stats.shots / stats.kills).toFixed(1) : '—';
  return (
    `撃破 ${stats.kills}/${stats.appeared} 機（撃破率 ${rate.toFixed(0)}%）<br>` +
    `命中率 ${accuracy.toFixed(1)}%（${stats.hits}/${stats.shots} 発）・撃破あたり ${perKill} 発<br>` +
    `生存時間 T+ ${missionTimeText(stats.survivalSec)}`
  );
}
