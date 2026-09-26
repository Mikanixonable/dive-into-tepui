// 直近の進行で起きた一回きりの出来事の記録。進行の位相が起きたことを領域の言葉で積み、
// 表示の導出が通し番号を鍵に読んで、音・通知・閃光の宣言へ写す(R7)。
import type { CommandQueue } from './command-queue';
import type { BulletType } from './dynamic/dynamic-entity/bullet-reaction';
import type { DynamicEntityKind } from './dynamic/dynamic-entity/entity-kind';
import type { EnemyDeathCause } from './stages/stage-outcome';
import type { Attitude } from '../physics/attitude';
import type { KinematicState } from '../physics/kinematic-state';
import type { ProteinPhase } from '../render/protein/protein-display';
import type { Vec3 } from '../math/vec3';

// クリエイティブモードで、操作艦が要る操作。
export type ShipRequiredAction = 'addMagazine' | 'refillRcsFuel' | 'spawnEnemy';

// 出来事1件の中身。
export type RunEventBody =
  // 時間加速の段が変わった。speed は変わったあとの倍率、shipActs はその倍率で自機が行動できるか。
  | { readonly kind: 'simSpeedChanged'; readonly speed: number; readonly shipActs: boolean }
  // 直近ノードの実行時刻までの自動ワープが始まった。
  | { readonly kind: 'autoWarpStarted' }
  // 進行中の自動ワープが解除された。
  | { readonly kind: 'autoWarpCancelled' }
  // 自動ワープを起こせなかった。理由は、計画にノードが1件も無い('noNode')か、
  // 直近ノードの実行時刻を既に通過している('nodePassed')か。
  | { readonly kind: 'autoWarpUnavailable'; readonly reason: 'noNode' | 'nodePassed' }
  // 操作対象の状態が非有限値に汚染された。
  | {
    readonly kind: 'controlledStateCorrupted';
    readonly phase: string; // 汚染を捕まえた時点で直前に走っていた段
    readonly state: KinematicState;
    readonly attitude: Attitude;
    readonly simTime: number; // 検査した進行の先端時刻 [sim s]。これ自体も検査の対象
    readonly dt: number; // そのフレームの実時間の経過 [s]
    readonly simDt: number; // そのフレームで進めたシミュレーション時間 [sim s]
  }
  // 操作対象以外の個体の状態が非有限値に汚染された。
  | {
    readonly kind: 'entityStateCorrupted';
    readonly phase: string;
    readonly subject: string; // 汚染された個体の呼び名
    readonly state: KinematicState;
    readonly dt: number;
    readonly simDt: number;
  }

  // -------------------------------------------------------------------- 射撃
  // 機関砲が1発撃った。muzzleState は砲口の位置と、そのときの艦の速度・時刻。
  | { readonly kind: 'gunFired'; readonly muzzleState: KinematicState }
  // 機関砲のモーターが立ち上がり、連射の起動遅延に入った。
  | { readonly kind: 'gunSpunUp' }
  // 撃てない状態でトリガーを引いた。
  | { readonly kind: 'gunDryFired' }
  // 次のマガジンが給弾された。
  | { readonly kind: 'gunMagazineFed' }
  // 手動でマガジンを替えた。
  | { readonly kind: 'gunReloaded' }
  // 武装が壊れていて撃てない。
  | { readonly kind: 'gunDisabled' }
  // 弾薬を撃ち尽くした。
  | { readonly kind: 'gunOutOfAmmo' }
  // 発射弾がターゲットの標的面を自機側から通過した。offset はターゲット位置から見た通過点、
  // simTime は通過した時刻。
  | { readonly kind: 'targetBoardPassed'; readonly offset: Vec3; readonly simTime: number }

  // ------------------------------------------------------------ 被弾・接触
  // 自機の一点 impactPoint に衝撃が入った。shipState はそのときの艦の状態、bullet は衝撃を与えた
  // 弾の種類で、被弾以外の破断で入った衝撃では null。
  | {
    readonly kind: 'shipStruck';
    readonly impactPoint: Vec3;
    readonly shipState: KinematicState;
    readonly bullet: BulletType | null;
  }
  // 自機が接触で損傷した(喪失には至らない)。state は損傷した艦の状態。
  | { readonly kind: 'shipDamagedByContact'; readonly state: KinematicState }
  // 敵機が被弾した(撃破には至らない)。state は着弾点と機体の速度。
  | {
    readonly kind: 'enemyStruckByBullet';
    readonly bullet: BulletType;
    readonly state: KinematicState;
  }
  // 敵機が接触で損傷した(撃破には至らない)。state は損傷した機体の状態。
  | { readonly kind: 'enemyDamagedByContact'; readonly state: KinematicState }
  // 破片へ弾が当たった。state は着弾点と破片の速度。
  | { readonly kind: 'debrisStruckByBullet'; readonly state: KinematicState }
  // 薬莢が船体か他の薬莢へ接触した。
  | { readonly kind: 'casingContacted' }
  // 艦が爆散した(自機・敵機とも)。modelScale は機体模型の倍率で、爆散の大きさを決める。
  | {
    readonly kind: 'shipExploded';
    readonly state: KinematicState;
    readonly modelScale: number;
  }
  // 敵機がタンパク質の機能部位から1発撃った。muzzleState は砲口の位置と機体の速度。
  | { readonly kind: 'proteinSiteFired'; readonly muzzleState: KinematicState }
  // タンパク質敵の被弾で、機能部位が停止したか構造フェーズが遷移した。state は着弾点と機体の速度。
  | {
    readonly kind: 'proteinStateChanged';
    readonly state: KinematicState;
    readonly transition: ProteinPhase | 'site-disabled';
  }
  // 敵のプラズマ弾が交戦圏の中心の近くを初めて通り過ぎた。
  | { readonly kind: 'plasmaPassedClose' }
  // 敵1体が失われた。cause は撃破か自然損耗の別。
  | { readonly kind: 'enemyDied'; readonly name: string; readonly cause: EnemyDeathCause }
  // 自機を喪失した。reason は喪失の理由。
  | { readonly kind: 'shipLost'; readonly reason: string }
  // ステージの勝敗と結果が確定した。
  | { readonly kind: 'stageDecided' }

  // -------------------------------------------------------------------- 飛行
  // 高度の警戒線を下回った。threshold はその線の高度 [m]。
  | { readonly kind: 'altitudeWarned'; readonly threshold: number }
  // RCS 回転制動を切り替えた。
  | { readonly kind: 'rcsDampToggled'; readonly on: boolean }
  // 機首をプログレードへ向け直した。
  | { readonly kind: 'progradeHoldReset' }
  // 進行方向ホールドを切り替えた。
  | { readonly kind: 'progradeHoldToggled'; readonly on: boolean }
  // 手動の回転操作で進行方向ホールドが外れた。
  | { readonly kind: 'progradeHoldReleasedByInput' }
  // 並進出力の段を選び直した。index は THROTTLE_LEVELS の段。
  | { readonly kind: 'throttlePresetSelected'; readonly index: number }
  // 姿勢微調整モードを切り替えた。
  | { readonly kind: 'fineAttitudeToggled'; readonly on: boolean }

  // ---------------------------------------------------------------- ブースター
  // 繋げる段数の上限に掛かって追加できなかった。
  | { readonly kind: 'boosterLimitReached'; readonly limit: number }
  // ブースターを1段足した。stages は足したあとの段数。
  | { readonly kind: 'boosterAttached'; readonly stages: number }
  // 点火できる段が1つも無かった。
  | { readonly kind: 'boosterIgnitionUnavailable' }
  // 最後尾段の点火を切り替えた。fuelEmpty なら燃料切れで実際には燃えない。
  | { readonly kind: 'boosterIgnitionToggled'; readonly on: boolean; readonly fuelEmpty: boolean }
  // 分離できる段が1つも無かった。
  | { readonly kind: 'boosterDecoupleUnavailable' }
  // 最後尾段を切り離した。stages は切り離したあとの残り段数、jointState は分離面の位置と艦の速度。
  | {
    readonly kind: 'boosterDecoupled';
    readonly stages: number;
    readonly jointState: KinematicState;
  }

  // -------------------------------------------------------------------- 補給
  // 弾薬の補給が軌道上へ投入された。
  | { readonly kind: 'ammoResupplyDeployed' }
  // RCS 燃料の補給が軌道上へ投入された。
  | { readonly kind: 'rcsFuelResupplyDeployed' }
  // 弾薬の補給を取り込んだ。mags は増えたマガジン数。
  | { readonly kind: 'ammoPickedUp'; readonly mags: number }
  // RCS 燃料の補給を取り込んだ。fuel は増えた燃料 [kg]。
  | { readonly kind: 'rcsFuelPickedUp'; readonly fuel: number }

  // -------------------------------------------------------------------- 計画
  // 直近ノードの実行の窓に入った。
  | { readonly kind: 'maneuverNodeApproaching' }
  // 計画軌道へ到達してノードを消化した。remaining は消化後に残るノード数。
  | { readonly kind: 'maneuverNodeAchieved'; readonly remaining: number }
  // スナップショットの計画に、起点より前のノードが残っていて復元できなかった。
  | { readonly kind: 'planNodesDropped'; readonly ship: string; readonly count: number }

  // ------------------------------------------------------------------ ビュー
  // 操作対象が無いため、戦闘ビューへの切り替えを受け付けなかった。
  | { readonly kind: 'combatViewUnavailable' }
  // 計画ノードを確定して戦闘ビューへ戻った。nodeCount は確定したノード数。
  | { readonly kind: 'maneuverPlanConfirmed'; readonly nodeCount: number }
  // 軌道計画のためにマップビューへ入った。
  | { readonly kind: 'orbitPlanningOpened' }

  // ------------------------------------------------------------------ カメラ
  // ビューの視点をリセットした。
  | { readonly kind: 'cameraViewReset'; readonly view: 'combat' | 'map' }
  // 姿勢追従を切り替えた。
  | { readonly kind: 'cameraAttitudeFollowToggled'; readonly on: boolean }
  // 基準面に対する視点を選んだ。
  | { readonly kind: 'cameraReferenceViewSelected'; readonly view: 'above' | 'side' }

  // -------------------------------------------------------------------- 操作対象
  // 操作対象に選ばれた。
  | { readonly kind: 'controlTargetSelected'; readonly target: DynamicEntityKind; readonly name: string }
  // 操作対象から手で外された。
  | { readonly kind: 'controlTargetReleased'; readonly target: DynamicEntityKind }
  // 操作対象候補が世界から取り除かれた。id は取り除かれた個体の id。
  | { readonly kind: 'controllableRemoved'; readonly id: string }

  // ---------------------------------------------------------- 航法ターゲット
  // 航法ターゲットを切り替えた。name は新しいターゲットの表示名で、解除したなら null。
  | { readonly kind: 'navTargetToggled'; readonly name: string | null }
  // 航法ターゲットを戦闘対象へ固定した。name は固定した対象の表示名で、固定を外したなら null。
  | { readonly kind: 'navTargetLocked'; readonly name: string | null }

  // ---------------------------------------------------------------- 波状攻撃
  // 自機が弾薬を確保し、敵部隊の接近が始まった。
  | { readonly kind: 'waveAttackArmed' }
  // 次のウェーブが出撃した。
  | { readonly kind: 'waveSpawned'; readonly wave: number }

  // -------------------------------------------------------- クリエイティブの配置
  // 物体を1つ配置した。
  | { readonly kind: 'objectPlaced'; readonly name: string }
  // 入力を解釈できず配置できなかった。reason は解釈に失敗した理由。
  | { readonly kind: 'objectPlacementRejected'; readonly reason: string }
  // 配置できる艦の隻数が上限に達していた。
  | { readonly kind: 'shipPlacementLimitReached'; readonly limit: number }
  // 複製しようとした軌道を軌道要素へ逆算できなかった。
  | { readonly kind: 'orbitNotDuplicable' }
  // 操作艦が要る操作を、操作艦が居ない状態で行おうとした。
  | { readonly kind: 'shipRequiredForAction'; readonly action: ShipRequiredAction };

// 記録された出来事1件。
export interface RunEvent {
  readonly seq: number; // 通し番号。表示の導出が同じ出来事を二度扱わないための鍵
  readonly body: RunEventBody;
}

// 出来事を記録する口。
export interface RunEventSink {
  // 起きたことを1件記録する。
  record(body: RunEventBody): void;
}

// 列を通して記録する口。DOM のイベントのように、フレームのどこから来たか分からないところで
// 起きたことは、これを通して次の進行の位相で積む(R8)。
export function queuedEventSink(queue: CommandQueue, events: RunEventSink): RunEventSink {
  return { record: (body) => queue.submit(() => events.record(body)) };
}

// 1ランぶんの出来事の記録。通し番号はランの中で単調増加する。
// 例外(ARCHITECTURE R11): モデル層の状態だが直列化しない。出来事は進行の位相の先頭で空にする1フレームの
// 通り道で、読み手もランと一緒に作り直す。保存すると、読み込んだフレームに前のランの音と通知が出る。
export class RunEventLog implements RunEventSink {
  private events: RunEvent[] = [];
  private nextSeq = 0;

  // 直近の進行で記録された出来事を、記録した順に返す。
  public get recent(): readonly RunEvent[] {
    return this.events;
  }

  // 進行の位相の先頭で呼び、前のフレームの出来事を捨てる。
  public beginStep(): void {
    this.events = [];
  }

  // 起きたことを1件、次の通し番号を付けて積む。
  public record(body: RunEventBody): void {
    this.events.push({ seq: this.nextSeq++, body });
  }
}
