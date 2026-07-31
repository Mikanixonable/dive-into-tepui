// 全ステージ共通の骨格。撃破数による勝利判定(checkWin/onWin)・常時解放(isUnlocked)・
// HUD補助表示なし(hudSubStatus)を既定実装として持ち、必要なステージだけ override する。
// ステージ固有のランタイム状態(タイマー・ウェーブ管理・撃破集計・弾薬兵站など)は各派生
// クラス(stage00.ts等)や基底クラス自身がフィールドとして直接持つ — Game は
// stage-dictionary.ts の initStage() が新規 `new` したこのインスタンス自身を
// activeStage として保持するだけでよい。
import * as THREE from 'three/webgpu';
import { Enemy } from '../orbit-entity/enemy';
import { Player } from '../player/player';
import { Logistics } from './stage-utils/logistics';
import { ScoreCounter as scoreCounter } from './stage-utils/score-counter';
import { StageStatusPanel } from './stage-utils/stage-status-panel';
import { EffectsSystem } from '../vfx/effects-system';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { showResultScreen, showWinScreen } from '../hud/result-screen';
import type { ClearCounts, UnlockManager } from '../unlock-manager';
import type { Simulator } from '../orbit-entity/simulator';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { SimSpeedManager } from '../sim-speed-manager';
import type { ProjectFn } from '../camera/camera-system';
import type { MarkerManager } from '../marker/marker-manager';

export type StageId = '00' | '0' | '1' | '2';

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

export interface StageInitData {
  mags: number;
  rounds: number;
  briefingHtml: string;
}

export abstract class Stage {
  // id は各派生クラスが static readonly id で持つ(stage-dictionary.ts がインスタンス化前に
  // ID で検索できるようにするため)。ここでは実行時に `this.id` で読めるよう橋渡しするだけ。
  get id(): StageId {
    return (this.constructor as unknown as { id: StageId }).id;
  }
  abstract readonly selectLabel: string;
  abstract readonly selectSub: string;
  readonly selectLockedSub?: string;
  abstract readonly selectKeys: string[];
  abstract readonly initialAmmo: Pick<StageInitData, 'mags' | 'rounds'>;

  // 発射・命中・撃破の集計(全ステージ共通)。増減は ScoreCounter 自身のメソッドで行う。
  readonly scoreCounter = new scoreCounter();
  // 補給マガジンの兵站(全ステージ共通)。Game 固有のリソース(hud/sfx/scene/simulator)を
  // 必要とするため、モジュール読み込み時ではなく setup() で構築する。
  protected logistics!: Logistics;
  // ステージ状況パネル(HP・補助メッセージ・撃墜数)。表示内容を決めるのがステージ自身
  // (hudSubStatus)なので、パネルもステージが持つ。logistics と同じく setup() で構築する。
  private statusPanel!: StageStatusPanel;

  // setup() で受け取り私有する hud/sfx/scene(インスタンス化はステージ ID だけを
  // 持つ stage-dictionary.ts の initStage() 内で行うため、コンストラクタ注入ができず
  // setup() が代わりを担う。これは一度きりの注入であり、毎フレームの ctx 越しの受け渡しではない)。
  // 派生クラス(stage0/1/2/00.ts)は毎フレームの init/update からこれを直接使ってよい。
  protected _hud!: Hud;
  protected _sfx!: Sfx;
  protected _scene!: THREE.Scene;
  // fx も hud/sfx/scene と同じく setup() での一度きりの注入。敵/自機の生成
  // (spawner/enemy-generator.ts 等)にそのまま渡すため protected にする。
  protected _fx!: EffectsSystem;
  protected _unlockManager!: UnlockManager;

  // 勝敗/タイムアップの進行状況。Game はこれを読むだけの主体で、変更は Stage 自身
  // (recordEnemyDeath/recordPlayerLost、Stage0 のタイムアップ判定)だけが行う。
  private _phase: GamePhase = 'playing';
  get phase(): GamePhase { return this._phase; }
  // 外部(game.ts/map-mode-system.ts 等)の多くは playing か否かだけに関心があるため。
  get isPlaying(): boolean { return this._phase === 'playing'; }
  protected setPhase(phase: GamePhase): void { this._phase = phase; }

  // stage-dictionary.ts の initStage() がインスタンス生成直後に一度だけ呼ぶ
  // (`new` の時点では Game 固有のリソースが揃っていないため、コンストラクタではなく
  // ここで受け取る)。
  setup(
    hud: Hud,
    sfx: Sfx,
    scene: THREE.Scene,
    simulator: Simulator,
    unlockManager: UnlockManager,
    fx: EffectsSystem,
    markerManager: MarkerManager,
  ): void {
    this._hud = hud;
    this._sfx = sfx;
    this._scene = scene;
    this._unlockManager = unlockManager;
    this._fx = fx;
    this._phase = 'playing';
    this.logistics = new Logistics(hud, sfx, scene, simulator.ammos, (ammo) => simulator.addAmmo(ammo), markerManager);
    this.statusPanel = new StageStatusPanel(hud.root);
  }

  // 決着後の [R] = 再出撃。「[R] キーまたはタップで再出撃」と案内する結果画面を出すのが
  // この Stage なので、その案内に応えるキーもここで受ける。プレイ中の [R] は素通しして
  // Player のマニュアル装填に渡す。
  handleInput(input: Input): void {
    if (this.isPlaying) return;
    if (input.takeKey(K.restart)) this.restart();
  }

  // 同じステージで出撃し直す。選択画面から入ったときは URL にステージ指定が無いため、
  // 自分の ID を明示して読み込み直す(素のリロードだと選択画面へ戻ってしまう)。
  // 履歴を増やさないよう replace で遷移する。
  private restart(): void {
    location.replace(`${location.pathname}?stage=${this.id}`);
  }

  // 毎フレーム(sync 時)呼ぶ、ステージ所有の表示物の同期。
  sync(player: Player, project: ProjectFn): void {
    this.syncStatusPanel(player);
    this.logistics.syncMarkers(player, project);
  }

  // hudSubStatus() を返すステージでだけ状況パネルを表示する。
  private syncStatusPanel(player: Player): void {
    const message = this.hudSubStatus();
    if (message === null) {
      this.statusPanel.hide();
      return;
    }
    this.statusPanel.sync(player.hp, player.maxHp, message, this.scoreCounter.kills);
  }

  // 敵の生成登録(Simulator への追加 + 出撃数カウント)を一箇所にまとめる。
  protected addEnemy(enemy: Enemy, simulator: Simulator): void {
    simulator.addEnemy(enemy);
    this.scoreCounter.recordSpawnEnemy();
  }

  protected behaveAllEnemies(dt: number, player: Player, simulator: Simulator, simTime: number, simSpeed: SimSpeedManager): void {
    for (const e of simulator.enemies) {
      if (e.alive) e.behave(dt, simTime, player, simulator, simSpeed);
    }
  }

  // 省略時(既定実装)は常に解放。unlock-manager.ts が記録するクリア回数だけを条件式の引数
  // として渡す(localStorage 等の永続化には一切触れない)。
  isUnlocked(_clearCounts: ClearCounts): boolean {
    return true;
  }

  abstract briefingHtml(enemyCount: number): string;
  // ステージ開始時の処理(初期敵配置・初期補給投入)。戻り値は初期敵数(ブリーフィング表示用)。
  abstract init(player: Player, simulator: Simulator): number;
  // 毎フレームの処理(弾薬兵站・タイマー・ウェーブ生成など、このステージに必要な分だけ書く)。
  abstract update(dt: number, player: Player, simulator: Simulator, simTime: number, simSpeed: SimSpeedManager): void;

  // 既定: 敵全機撃破で勝利(再突入等の自然損耗は losses を差し引くためだけに使う)。
  // 時間切れで終わるステージ(Stage0/Stage00)は false 固定・onWin no-op に override する。
  checkWin(): boolean {
    return this.scoreCounter.totalEnemiesSpawned - this.scoreCounter.kills - this.scoreCounter.losses <= 0;
  }
  onWin(simTime: number): void {
    showWinScreen(this._sfx, this.scoreCounter, this.scoreCounter.totalEnemiesSpawned, simTime);
  }

  // HUDステータスパネルの補助表示(サバイバル波数・残り時間など)。既定は非表示。
  hudSubStatus(): string | null {
    return null;
  }

  // 敵が1機減ったことを集計し、勝利条件判定・解放記録への橋渡しを行う(alive 遷移・
  // 撃破エフェクトは呼び出し元の Ship.attacked/checkLoss が既に済ませている — ここでは呼ばない)。
  //           'killed'  = 自機による撃破(撃破数に加算)
  //           'reentry' = 再突入など物理的消滅(自然損耗に加算)
  //           'despawn' = 交戦圏外への離脱(同上)
  // 原因によらず勝利判定を通す: 既定の checkWin() は「残存機が居ないこと」を撃破数と自然損耗の
  // 両方から見るので、最後の1機が再突入で消えた場合もそこで決着させないと終了できなくなる。
  recordEnemyDeath(enemy: Enemy, simTime: number, cause: 'killed' | 'reentry' | 'despawn' = 'killed'): void {
    if (cause === 'killed') {
      this.scoreCounter.recordKill();
      this._hud.hint(`${enemy.name} 撃破`);
    } else {
      this.scoreCounter.recordEnemyLoss();
      this._hud.hint(`${enemy.name} ${cause === 'reentry' ? '再突入により喪失' : '交戦圏を離脱'}`);
    }

    if (this.checkWin()) {
      this.setPhase('won');
      this._unlockManager.reportClear(this.id, this._hud);
      this.onWin(simTime);
    }
  }

  // 自機の被弾死・自然死(checkLoss)を集計する。原因ごとに文言が異なるため reason で
  // 明示的に渡す。
  recordPlayerLost(reason: string): void {
    this.setPhase('lost');
    showResultScreen(this._sfx, false, `${reason}<br>撃破 ${this.scoreCounter.kills}/${this.scoreCounter.totalEnemiesSpawned} 機`);
  }
}
