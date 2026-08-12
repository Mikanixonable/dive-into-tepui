// 全ステージ共通の骨格。撃破数による勝利判定・常時解放・HUD補助表示なしを既定実装として持ち、
// 必要なステージだけ override する。
import * as THREE from 'three/webgpu';
import { Enemy } from '../game-entity/enemy';
import { Player } from '../player/player';
import { Logistics } from './stage-utils/logistics';
import { ScoreCounter as scoreCounter } from './stage-utils/score-counter';
import { StageStatusPanel } from './stage-utils/stage-status-panel';
import { EffectsSystem } from '../vfx/effects-system';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { showResultScreen, showWinScreen } from '../hud/result-screen';
import type { ClearCounts, UnlockManager } from '../unlock-manager';
import type { EntityManager } from '../simulation/entity-manager';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { SimSpeedManager } from '../sim-speed-manager';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { FloatingOrigin } from '../floating-origin';
import type { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import type { Simulator } from '../simulation/simulator';
import type { StageSaveData } from '../save-data';
import type { MapVisibilityPolicy } from '../celestial/map-visibility';

export type StageId = '00' | '0' | '1' | '2' | 'debug' | 'debug-alt-system' | 'debug-load';

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

export interface StageInitData {
  mags: number;
  rounds: number;
  briefingHtml: string;
}

export abstract class Stage {
  // サブクラスが持つ static id を返す。
  get id(): StageId {
    return (this.constructor as unknown as { id: StageId }).id;
  }
  abstract readonly selectLabel: string;
  abstract readonly selectSub: string;
  readonly selectLockedSub?: string;
  // タイトルのステージ選択ボタン列に並べない。
  readonly hiddenFromSelect: boolean = false;
  abstract readonly selectKeys: string[];
  abstract readonly initialAmmo: Pick<StageInitData, 'mags' | 'rounds'>;

  readonly scoreCounter = new scoreCounter();
  protected logistics!: Logistics;
  private statusPanel!: StageStatusPanel;

  protected _hud!: Hud;
  protected _sfx!: Sfx;
  protected _scene!: THREE.Scene;
  protected _fx!: EffectsSystem;
  protected _unlockManager!: UnlockManager;
  protected _entities!: EntityManager;
  protected _markerManager!: MarkerManager;
  protected _ephemeris!: Ephemeris;
  protected _simulator!: Simulator;

  private _phase: GamePhase = 'playing';
  get phase(): GamePhase { return this._phase; }
  get isPlaying(): boolean { return this._phase === 'playing'; }
  protected setPhase(phase: GamePhase): void { this._phase = phase; }

  // ゲーム固有リソース(hud/sfx/scene 等)をインスタンス生成後に一度だけ注入する。
  setup(
    hud: Hud,
    sfx: Sfx,
    scene: THREE.Scene,
    entities: EntityManager,
    unlockManager: UnlockManager,
    fx: EffectsSystem,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
    simulator: Simulator,
  ): void {
    this._hud = hud;
    this._sfx = sfx;
    this._scene = scene;
    this._unlockManager = unlockManager;
    this._fx = fx;
    this._entities = entities;
    this._markerManager = markerManager;
    this._ephemeris = ephemeris;
    this._simulator = simulator;
    this._phase = 'playing';
    this.logistics = new Logistics(hud, sfx, scene, entities, markerManager);
    this.statusPanel = new StageStatusPanel(hud.layers.panel);
  }

  // ステージ固有の UI(トグル等)をステータスウィンドウ左部へ追加する。
  protected addStatusPanelWidget(el: HTMLElement): void {
    this.statusPanel.appendLeftWidget(el);
  }

  // 決着後の [R] で再出撃。プレイ中は素通しする。
  handleInput(input: Input): void {
    if (this.isPlaying) return;
    if (input.takeKey(K.restart)) this.restart();
  }

  // ?stage= を明示して replace する: 素のリロードでは選択画面へ戻るため。
  private restart(): void {
    location.replace(`${location.pathname}?stage=${this.id}`);
  }

  // ステータスパネルとロジスティクスのマーカーを同期する。fo・camera は配置プレビューなど
  // ステージ固有の描画物を持つサブクラスが使う。scale は overviewMode 中の ▣ AMMO マーカーの
  // 進行方向表示に使う。
  sync(
    player: Player | null, _fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, displayTime: number,
    overviewMode: boolean, visibilityPolicy: MapVisibilityPolicy | null, _camera: THREE.Camera,
  ): void {
    this.syncStatusPanel(player, overviewMode);
    this.logistics.syncMarkers(player, project, scale, displayTime, overviewMode, visibilityPolicy);
  }

  // hudSubStatus() が null ならパネルを隠し、文字列なら HP・スコアとともに表示する。
  private syncStatusPanel(player: Player | null, overviewMode: boolean): void {
    const message = this.hudSubStatus();
    if (!player || message === null || overviewMode) {
      this.statusPanel.hide();
      return;
    }
    this.statusPanel.sync(player, message, this.scoreCounter.kills);
  }

  // 敵を entities へ登録し、出撃数をスコアへ記録する。
  protected addEnemy(enemy: Enemy, entities: EntityManager): void {
    entities.addEnemy(enemy);
    this.scoreCounter.recordSpawnEnemy();
  }

  // 生存中の敵全てに AI 行動を1フレーム分実行させる。
  protected behaveAllEnemies(dt: number, player: Player, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    for (const e of entities.enemies) {
      if (e.alive) e.behave(dt, simTime, player, entities, simSpeed, this._ephemeris);
    }
  }

  // このステージが解放済みかどうかをクリア回数から判定する。既定では常に解放。
  isUnlocked(_clearCounts: ClearCounts): boolean {
    return true;
  }

  abstract briefingHtml(enemyCount: number): string;
  // 戻り値は初期敵数(ブリーフィング表示用)。
  abstract init(player: Player, entities: EntityManager): number;
  // 毎フレーム呼ぶ。艦が1隻も無い間(Creative の未配置状態)は player が null になる。
  abstract update(dt: number, player: Player | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void;

  // Simulator がsubstepをイベント直前で切るためのhook。通常ステージには時刻固定イベントがない。
  nextSimulationEventTime(_simTime: number): number | null { return null; }
  applySimulationEvents(_simTime: number): void { }

  // 残存敵数が 0 以下なら勝利。
  checkWin(): boolean {
    return this.scoreCounter.totalEnemiesSpawned - this.scoreCounter.kills - this.scoreCounter.losses <= 0;
  }
  // 勝利画面を表示する。
  onWin(simTime: number): void {
    showWinScreen(this._sfx, this.scoreCounter, this.scoreCounter.totalEnemiesSpawned, simTime);
  }

  // ステータスパネルに表示する補助メッセージ。既定では非表示(null)。
  hudSubStatus(): string | null {
    return null;
  }

  // 原因によらず勝利判定を通す: 再突入・離脱でも残存数 0 なら決着させる。
  recordEnemyDeath(enemy: Enemy, simTime: number, cause: 'killed' | 'reentry' | 'despawn' = 'killed'): void {
    if (cause === 'killed') {
      this.scoreCounter.recordKill();
      this._hud.hint(`${enemy.name} 撃破`);
    } else {
      this.scoreCounter.recordEnemyLoss();
      this._hud.hint(`${enemy.name} ${cause === 'reentry' ? '再突入により喪失' : '交戦圏を離脱'}`);
    }

    // isPlaying ガード: 敗北後に残存敵が再突入で消えても勝利判定が上書きしないよう。
    if (this.isPlaying && this.checkWin()) {
      this.setPhase('won');
      this._unlockManager.reportClear(this.id, this._hud);
      this.onWin(simTime);
    }
  }

  // 敗北を記録し、reason を添えて敗北画面を表示する。
  recordPlayerLost(reason: string): void {
    // isPlaying ガード: 勝利後に自機が再突入しても敗北で上書きしないよう。
    if (!this.isPlaying) return;
    this.setPhase('lost');
    showResultScreen(this._sfx, false, `${reason}<br>撃破 ${this.scoreCounter.kills}/${this.scoreCounter.totalEnemiesSpawned} 機`);
  }

  // スコア・決着状態・補給タイマーをセーブデータへ変換する。固有の内訳を持つ具象ステージは
  // これを拡張した戻り値型で override する。
  serialize(): StageSaveData {
    return {
      scoreCounter: this.scoreCounter.serialize(),
      phase: this._phase,
      logistics: this.logistics.serialize(),
    };
  }

  // serialize() の対になる復元。固有の内訳を持つ具象ステージは super.restore(data) を
  // 呼んでから自分の分を復元する override を書く。
  restore(data: StageSaveData): void {
    this.scoreCounter.restore(data.scoreCounter);
    this._phase = data.phase;
    this.logistics.restore(data.logistics);
  }
}
