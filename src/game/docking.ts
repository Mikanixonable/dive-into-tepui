// 基地への収容・発進まわり一式。Player(艦の操作)・EntityManager(配置)・DockView(UI)・
// ActivePlayerController(操作対象の付け替え)・CameraSystem/ViewManager(カメラ・ビューの遷移)
// にまたがる横断的な関心事なので、それぞれに分岐と組み立てを残さずここへ切り出す(所有者が
// 1つに定まらない GUI/挙動は横断そのものを責務とするモジュールを立てる — MapContextActions/ViewManager と同じ形)。
import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { DockView } from './hud/dock-view';
import { Base } from './game-entity/base';
import { Player } from './player/player';
import type { EntityManager } from './simulation/entity-manager';
import type { MapContextActions } from './map-context-actions';
import type { CameraSystem } from './camera/camera-system';
import type { ViewManager } from './view-manager';
import type { Sfx } from '../audio/sfx';
import type { EffectsSystem } from './vfx/effects-system';
import type { MarkerManager } from './marker/marker-manager';
import type { ActivePlayerController } from './active-player-controller';
import type { Stage } from './stages/stage';

export class Docking {
  readonly dockView: DockView;
  // 選択中/ドックビューの対象基地。設定されている間だけドックビューへ遷移できる。
  private _activeBase: Base | null = null;
  // 新造艦の連番。基地をまたいで一意な id/表示名を割り振るだけの用途。
  private nextBuiltShipNo = 0;

  get activeBase(): Base | null { return this._activeBase; }

  constructor(
    // ポーズ操作だけはクロージャで受け取る。ポーズは Game 自身の状態なので、参照するなら
    // Game を丸ごと持つしかない。必要なのはこの2つだけで、それに対して Game は大きすぎ、
    // 発展途上のこのモジュールに何にでも手が届く経路を与えてしまう。「クロージャ注入は
    // 原則行わず参照を渡す」という規則に対する、意図的かつ暫定的な例外。
    private readonly pauseGame: () => void,
    private readonly resumeGame: () => void,
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly scene: THREE.Scene,
    private readonly effects: EffectsSystem,
    private readonly markerManager: MarkerManager,
    private readonly entities: EntityManager,
    private readonly mapActions: MapContextActions,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly activePlayers: ActivePlayerController,
    private readonly activeStage: Stage,
  ) {
    this.dockView = new DockView(this.hud.layers.view);
    this.dockView.onClose = () => this.viewManager.leaveDock();
    this.dockView.onLaunchShip = (ship, base) => this.launch(ship, base);
    this.dockView.onBuildShip = (base) => this.buildShip(base);
    this.viewManager.setDocking(this);
  }

  // 基地を選択状態にする(遷移はしない) — マップの左クリック選択と、明示的にドックへ
  // 入る操作(activate)の両方がここを通る。
  selectBase(base: Base): void {
    this._activeBase = base;
  }

  // 基地を選択し、そのままドックビューへ遷移する。
  activate(base: Base): void {
    this.selectBase(base);
    this.viewManager.setView('dock');
  }

  // ドックビューへ遷移できるか。対象基地が健在な間だけ true。
  canEnterDock(): boolean {
    return this._activeBase !== null && this._activeBase.alive;
  }

  // 対象基地が消えたらドックへ入れなくする。表示中なら元のビューへ戻す。
  clearActiveBaseIf(base: Base): void {
    if (this._activeBase !== base) return;
    this._activeBase = null;
    this.viewManager.leaveDock();
  }

  // ドックビューの開閉は ViewManager が遷移の一部として呼ぶ。ドック中は時間を止める。
  enterDock(): void {
    if (!this._activeBase) return;
    this.pauseGame();
    this.dockView.open(this._activeBase, this.activePlayers.current, this.activeStage.freeProcurement);
  }

  // ViewManager がドックから出るときに呼ぶ。
  leaveDock(): void {
    this.dockView.close();
    this.resumeGame();
  }

  // 生存中の全艦について基地との距離・相対速度を調べ、収容条件を満たす艦を収容する。
  // ドックビュー表示中は何もしない(発進直後の再収容ループを防ぐ)。
  checkProximity(): void {
    if (this.viewManager.current === 'dock') return;
    for (const base of this.entities.bases) {
      if (!base.alive) continue;
      for (const ship of [...this.entities.players]) {
        const dist = len(sub(ship.state.r, base.state.r));
        const relSpeed = len(sub(ship.state.v, base.state.v));
        if (dist < C.DOCK_CAPTURE_DIST && relSpeed < C.DOCK_CAPTURE_REL_V) this.dock(ship, base);
      }
    }
  }

  // 艦を基地へ収容する: 格納艦一覧へ登録し、entities.players から外して非表示にする。
  private dock(ship: Player, base: Base): void {
    base.baseState.dockedShips.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
    });
    // parkPlayer した艦は以後 syncPlayer が呼ばれないので、可視状態を一度だけここで確定させる。
    ship.obj.visible = false;
    const wasActive = this.activePlayers.current === ship;
    this.mapActions.close();
    this.cameraSystem.overviewCamera.clearFocusIf(ship.id);
    // 収容される艦がまさに操作対象だった場合、噴射中の推力/RCS音は艦自身の毎フレーム
    // 更新(player.behave)が以後走らなくなることで止まらなくなる — 明示的に止める。
    if (wasActive) {
      ship.clearTransientCommands();
      this.sfx.setThrust(false);
      this.sfx.setRcs(false);
    }
    this.entities.parkPlayer(ship);
    if (wasActive) {
      this.activePlayers.setOrNull(this.entities.players.find((p) => p.alive) ?? null);
      // 収容で操縦できる艦が無くなったら、戦闘ビューには映すものが無いのでマップへ移す。
      if (this.activePlayers.current === null) this.viewManager.setView('map');
    }
    this.hud.hint(`${ship.name} を基地に収容しました`);
  }

  // 既定パーツ一式の艦を1隻建造し、格納艦へ加える。費用の徴収は DockView 側で済んでいる。
  // 発進するまでは軌道上に実体化しない(dock() で収容した艦と同じ扱い)。
  private buildShip(base: Base): void {
    const no = ++this.nextBuiltShipNo;
    const id = `${base.id}-built-${no}`;
    const ship = new Player(this.hud, this.sfx, this.scene, this.effects, this.markerManager, { name: `新造艦-${no}`, state: base.state, id });
    ship.obj.visible = false;
    base.baseState.dockedShips.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
    });
    this.hud.hint(`${ship.name} を建造しました`);
  }

  // 格納艦を基地脇の軌道へ実体化し、操作対象に据える。
  private launch(ship: Player, base: Base): void {
    const br = base.state.r;
    ship.state = kinematicState(base.state.t, v3(br.x + 600, br.y, br.z), base.state.v);
    this.entities.addPlayer(ship);
    this.activePlayers.set(ship);
    this.viewManager.leaveDock();
    this.hud.hint(`${ship.name} を発進しました`);
  }

}
