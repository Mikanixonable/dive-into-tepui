// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import { FloatingOrigin } from './floating-origin';
import { v3 } from '../physics/vec3';
import { Player } from './player/player';
import { CameraSystem } from './camera/camera-system';
import { Stage, StageId } from './stages/stage';
import { MarkerCtx, MarkerForGame } from './marker/marker-for-game';
import { MarkerManager } from './marker/marker-manager';
import { EffectsSystem } from './vfx/effects-system';
import { initStage } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { PredictSystem } from './predict/predict-system';
import { PlanGuide } from './plan/plan-guide';
import { SimSpeedManager } from './sim-speed-manager';
import { PipRenderer } from './pip-renderer';
import { Simulator } from './orbit-entity/simulator';
import { Input } from './input/input';
import { TouchControls } from './input/touch';
import { Hud } from './hud/hud';
import { SettingsPanel } from './hud/settings-panel';
import { Sfx } from '../audio/sfx';
import { GameScene } from '../render/scene';
import { EnvironmentScene } from '../render/environment-scene';
import { Ephemeris } from '../physics/ephemeris';
import { MapModeToggler } from './map-mode-toggler';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];
  private floatingOrigin: FloatingOrigin;
  private readonly input: Input;
  touchControls: TouchControls | null = null;
  // hud/sfx/settingsPanel はタイトル画面でも使うため main.ts が生成して注入する(Game は所有せず
  // 参照共有するだけ)。注入である以上コンストラクタ引数でしか確定しないため、これらに依存する
  // 下記フィールドは(scene 依存のフィールドと同様に)field initializer ではなくコンストラクタ
  // 本体で組み立てる。
  private readonly _hud: Hud;
  private readonly _sfx: Sfx;
  private readonly settingsPanel: SettingsPanel;
  private readonly markerManager: MarkerManager;
  // 太陽・月の天体暦(状態を持たない純サンプラ)。environment/simulator/cameraSystem/
  // editor がこの単一インスタンスを共有参照する。cameraSystem など後続の構築より前に
  // 確定させる必要があるため、依存を持たないこれは field initializer のままでよい。
  private readonly ephemeris: Ephemeris;
  // hud.panels.update(this, ...) が Game インスタンスをまるごと受け取って状態を直接読むため、
  // panel.ts から参照されるフィールド(cameraSystem/player/activeStage/simulator/targeter 等)は
  // public にする。マップモードのフォーカス候補ラベル(地球・月・太陽・ラグランジュ点)と
  // その選択 UI(視点パネル・ラベル右クリックメニュー)は「どこを注視するか」= mapCamera 寄りの
  // 責務なので cameraSystem が所有し、その HUD 配線も cameraSystem 自身が張る。
  readonly cameraSystem: CameraSystem;
  readonly player: Player;

  // シミュレーション速度(HUD ヒント・SFX 上は「ワープ」と呼ぶ、sfx.warp() 参照)の
  // 段階管理と、[N] キーによるノードへの自動ワープ。
  readonly simSpeedManager: SimSpeedManager;

  // 軌道計画まわりの三系統。かつて PlanSystem が束ねていたが、たらい回しを排して game が直接
  // 保持する: editor(ノード列 Plan・予測折れ線キャッシュ traj・編集モード editMode・ノード
  // 編集入力)、predict(未来表示 = ゴースト・表示期間・予測軌道の表示座標系と、その操作パネル)、
  // guide(戦闘ビューの噴射ガイド。マップモード中は呼ばない — [M] で開いている間は WASDQE が
  // Δv編集に使われるため)。
  // editor/guide は scene を要し、editor は cameraSystem の projection を要するため、いずれも
  // コンストラクタ本体で構築する(effects 等と同じ理由)。
  private readonly editor: PlanEditor;
  private readonly predict: PredictSystem;
  private readonly guide: PlanGuide;
  readonly mapModeToggler: MapModeToggler;

  // 選択されたステージの振る舞い(初期化・毎フレーム処理・勝敗判定、stages/ 参照)。
  // 固有のランタイム状態(タイマー・ウェーブ管理等)もこれ自身が持つ。
  readonly activeStage: Stage;
  // 唯一の書き換え口は pause()/resume()。SettingsPanel.onSettingsOpenChange の配線は
  // main.ts の役目(settingsPanel を所有するのが main.ts のため)。
  private _isPaused = false;
  get isPaused(): boolean { return this._isPaused; }

  // 空の天体・地球・環境光・参照軌道線をまとめて所有する描画系。天体暦は上の ephemeris を
  // 共有参照する(所有はしない)。
  private readonly environment: EnvironmentScene;

  private readonly unlockManager: UnlockManager;
  private readonly MarkerForGame: MarkerForGame;
  // フラッシュ・破片エフェクトのスポーン窓口(effects-system.ts)。scene への注入・
  // FlashEffectManager の所有もここに一元化されており、Player/Enemy/PlayerFire は
  // scene を持ち回さずに済む。scene(_scene)はコンストラクタ引数 gs 由来で field
  // initializer の時点では未確定のため、コンストラクタ本体で構築する(environment/player
  // と同じ理由)。
  private readonly effects: EffectsSystem;
  readonly targeter: Targeter;
  readonly simulator: Simulator;
  private readonly pipRenderer: PipRenderer;

  constructor(
    gs: GameScene,
    stageId: StageId,
    hud: Hud,
    sfx: Sfx,
    settingsPanel: SettingsPanel,
    unlockManager: UnlockManager,
  ) {
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this._hud = hud;
    this._sfx = sfx;
    this.settingsPanel = settingsPanel;
    this.unlockManager = unlockManager;

    this.ephemeris = new Ephemeris();

    this.markerManager = new MarkerManager(this._hud.root, this._hud.svgOverlay);
    this.MarkerForGame = new MarkerForGame(this.markerManager); // 解体すべき
    this.cameraSystem = new CameraSystem(this._hud, this._sfx, this.markerManager, this.ephemeris);
    this.simSpeedManager = new SimSpeedManager(this._hud, this._sfx);

    this.effects = new EffectsSystem(this._scene, (piece) => this.simulator.addDebris(piece));
    this.pipRenderer = new PipRenderer(this._scene);
    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene);
    this.environment = new EnvironmentScene(this._scene, this.ephemeris);
    this.predict = new PredictSystem(this._hud.root, this.markerManager);
    this.editor = new PlanEditor(
      this._hud,
      this._sfx,
      this.simSpeedManager,
      this.ephemeris,
      this._scene,
      this.cameraSystem.activeCameraProjection,
      () => this.player.fineAttitude,
    );

    // 表示期間は predict の状態、予測折れ線のキャッシュは editor の持ち物なので、両者に
    // またがるこの一本だけをオーケストレータが配線する(期間を変えた瞬間に引き直させる)。
    this.predict.onDurationChange = () => this.editor.traj.invalidate();
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager);
    this.mapModeToggler = new MapModeToggler(this._hud);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);

    this.simulator = new Simulator(this.ephemeris, this._sfx);

    this.player = new Player(this._hud, this._sfx, this._scene, this.effects);

    this.activeStage = initStage(
      stageId,
      this.player,
      this.simulator,
      this._hud,
      this._sfx,
      this._scene,
      this.unlockManager,
      this.effects,
    );

    this.floatingOrigin = new FloatingOrigin(this.player.state.r, this.player.state.v);
  }

  // ------------------------------------------------------------------ lifecycle

  pause(): void {
    this.simulator.lastSimDt = 0;
    this._sfx.setThrust(false);
    this.player.pause();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  // ------------------------------------------------------------ update

  // per frameの論理値更新
  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleInput();

    // ゲームオーバー後もシミュレーションは進めるが、プレイヤーの入力は無効化し、
    // 積分もサブステップなしの簡略版(integrateSimulation の hardCollision/doSubstep 引数)にする。
    // behave が呼ばれなくなる分、勝敗確定時点の thrustFn が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      this.player.thrustFn = null;
      this.player.torque = v3();
      const simDt = dt * Math.min(this.simSpeedManager.simSpeed, 4);
      this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage, false, false, false);
      return;
    }

    // ポーズ中の処理
    if (this._isPaused) { return; }

    // プレイヤーの HP 回復・移動/発射の試行
    this.player.behave({
      dt,
      input: this.input,
      simSpeed: this.simSpeedManager,
      editMode: this.editor.editMode,
      scoreCounter: this.activeStage.scoreCounter,
      simTime: this.simulator.simTime,
      zoomActive: this.cameraSystem.zoomActive,
      addBullet: (bullet) => this.simulator.addBullet(bullet),
    });

    // ステージの更新 (敵の行動・スポーン管理・スコア加算・勝敗判定を含む)
    this.activeStage.update(dt, this.player, this.simulator, this.simulator.simTime, this.simSpeedManager);

    this.simSpeedManager.update(this.simulator.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage,
      true, // bulletCollision
      this.simSpeedManager.canResolvePhysicalCollisions, // resolveCollision
      true, // doSubstep 
    );

    this.targeter.markBoardCrossings(this.player, this.simulator);

    this.player.checkLoss(dt, this.simulator.simTime, this.activeStage);

    this.simulator.cleanup(dt, this.activeStage);

    // カメラ更新は物理積分の後に行う: 追従カメラは自機を絶対 ECI 座標で追い、その基準は
    // sync 時のフローティングオリジン(積分後の自機位置)と一致していなければならない。
    this.cameraSystem.update(
      this.player,
      this.simulator.simTime,
      this.input,
      dt,
    );

    // 計画が空の間、予定 player の起点を現在状態へ追従させる(最初のノードで凍結)。
    this.editor.plan.trackAnchor(this.player.state);

    if (this.editor.editMode) {
      // 右クリックはノード(メニュー)を先に試し、外したぶんだけフォーカス選択へ回る。
      // 二つのギズモは互いを知らず、優先順位はこの呼び出し順だけで決まる。
      this.editor.handleMapPointer(this.input);
      this.cameraSystem.handleMapPointer(this.input);
      this.editor.updateEditing(dt, this.simulator.simTime, this.input);
    }
    else {
      this.targeter.updateCombatTargeting(this.player, this.simulator.enemies, this.input, this.cameraSystem);
    }
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。どのキー/クリックが何をするかは各モジュールが
  // 持ち、ここが決めるのは**優先順位 = 呼ぶ順序**だけ。処理したモジュールが input から
  // そのイベントを消費するので、後ろのモジュールには届かない。
  //
  // ここで配るのは、決着後・ポーズ中も効くべき操作(設定・ヘルプ・再出撃・ワープ・マップ開閉・
  // 計画破棄)。プレイ中のみ効く操作は、それぞれの持ち主の毎フレーム処理が input を受けて
  // 自分で拾う(Player.behave / CameraSystem.update / PlanEditor.handleMapPointer /
  // Targeter.updateCombatTargeting)。
  private handleInput(): void {
    this.settingsPanel.handleInput(this.input);
    this._hud.handleInput(this.input);
    this.activeStage.handleInput(this.input);
    this.simSpeedManager.handleInput(
      this.input,
      this.activeStage.isPlaying,
      this.editor.editMode,
      this.editor.plan.firstNode(),
    );
    this.mapModeToggler.update(
      this.input, this.activeStage.isPlaying, this.editor, this.touchControls, this.cameraSystem,
    );
    this.editor.handleInput(this.input);
  }

  // ------------------------------------------------------------------ sync

  sync(dt: number): void {
    // 設定し、sync 系全体へ共通の基準として渡す。player.state とは意味論的に別物 —
    // 将来この原点を別の点(カメラ座標など)へ差し替えても描画が破綻しないよう、
    // 各 sync はこの fo だけを参照し player.state.r を描画原点として直接使わない。
    this.floatingOrigin = new FloatingOrigin(this.player.state.r, this.player.state.v);

    // カメラ姿勢を THREE.js に反映するのを最初に行う: environment.sync や
    // マーカー投影(activeCameraProjection)がこのフレームのカメラ行列を読むため。
    const displayTime = this.predict.resolveDisplayTime(
      this.cameraSystem.mapMode,
      this.player.elements?.period ?? null,
      this.simulator.simTime,
    );

    this.cameraSystem.sync(this.floatingOrigin, displayTime);

    this.environment.sync({
      dt,
      player: this.player,
      floatingOrigin: this.floatingOrigin,
      displayTime,
      cameraSystem: this.cameraSystem,
    });

    this.player.syncPlayer(this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this._isPaused);

    this.simulator.sync(this.floatingOrigin);

    this.effects.sync(dt, this.simulator.lastSimDt, this.floatingOrigin, this.cameraSystem.activeCamera);

    this.targeter.sync(dt, this.floatingOrigin, this.simulator.enemies, this.cameraSystem.mapMode, this.cameraSystem.activeCameraProjection);

    const simTime = this.simulator.simTime;
    const orbitPeriod = this.player.elements?.period ?? null;
    const predictDuration = this.predict.durationSec(orbitPeriod);

    this.editor.sync(
      this.floatingOrigin, simTime, predictDuration,
      this.predict.trajectoryFrame, this.cameraSystem.mapCamera.dist,
    );

    // 自機のモード状態を映す先が2つある(HUD ステータスパネルとタッチUIのトグルボタン)。
    // どちらも表示側なので、状態の所有者から見て対称になるようここで両方へ渡す。
    this.touchControls?.syncModeButtons(this.player.rcsDamp, this.player.fineAttitude, this.player.progradeHold);
    this.activeStage.syncStatusPanel(this.player);

    this._hud.panels.update(this, dt);
    this._hud.tick();

    const project = this.cameraSystem.activeCameraProjection;
    const mapMode = this.cameraSystem.mapMode;

    // 未来ゴースト(predict)は B-2 の sampleAt/toDisplay を、マップラベル(camera)は表示時刻を受ける。
    this.predict.sync(
      (t) => this.editor.traj.sampleAt(t),
      (r, t) => this.editor.traj.toDisplay(r, t),
      orbitPeriod,
      simTime,
      mapMode,
      project);

    this.MarkerForGame.updateMarkers(this.markerCtx(), project);
    this.MarkerForGame.updateNodeMarkers(this.player, this.targeter.aliveTarget, project);

    this.guide.update(this.editor.plan, this.player, simTime, this.simSpeedManager, this.editor.editMode, project);

  }

  // MarkersSystem の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private markerCtx(): MarkerCtx {
    return {
      mapMode: this.cameraSystem.mapMode,
      player: this.player,
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      ammos: this.simulator.ammos,
      mapLabelIds: this.cameraSystem.mapLabelIds(),
      simTime: this.simulator.simTime,
    };
  }

  // ------------------------------------------------------------------ render

  render(): void {
    // 通常の全画面描画
    this.renderer.render(this._scene, this.cameraSystem.activeCamera);

    // PIP 描画
    this.pipRenderer.renderPip(this.renderer, {
      renderPip: this.player.isFiring && !this.cameraSystem.mapMode,
      pipCamera: this.cameraSystem.pipCamera,
      playerShipObj: this.player.obj,
      setMuzzleFlashesVisible: (visible) => this.effects.setMuzzleFlashesVisible(visible),
      updateOverlay: (rect) => this.MarkerForGame.updatePipOverlay(
        this.targeter.autoTarget, this.player, this.cameraSystem.pipCamera.projection, rect,
      ),
    });
  }

  // ------------------------------------------------------------------ debug

  // ?perf=1 のデバッグ表示用エンティティ数。
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number; } {
    return {
      enemies: this.simulator.enemies.length,
      bullets: this.simulator.bullets.length,
      casings: this.simulator.casings.length,
      debris: this.simulator.debris.length,
    };
  }
}
