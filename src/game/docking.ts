// 基地への収容・発進まわり一式。Player(艦の操作)・EntityManager(配置)・DockView(UI)・
// Game(操作対象/カメラ/計画編集の付け替え)にまたがる横断的な関心事なので、Game に分岐と
// 組み立てを残さずここへ切り出す(所有者が1つに定まらない GUI/挙動は横断そのものを
// 責務とするモジュールを立てる — MapPicker/ViewManager と同じ形)。
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { orbitState } from '../physics/orbital';
import { Hud } from './hud/hud';
import { DockView } from './hud/dock-view';
import { Base } from './game-entity/base';
import type { Player } from './player/player';
import type { EntityManager } from './simulation/entity-manager';
import type { MapPicker } from './map-picker';
import type { CameraSystem } from './camera/camera-system';
import type { Game } from './game';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import type { ViewManager } from './view-manager';

export class Docking {
  readonly dockView: DockView;
  // ドックビューの対象基地。設定されている間だけドックビューへ遷移できる。
  private _activeBase: Base | null = null;

  get activeBase(): Base | null { return this._activeBase; }

  constructor(
    private readonly game: Game,
    private readonly hud: Hud,
    private readonly entities: EntityManager,
    private readonly mapPicker: MapPicker,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
  ) {
    this.dockView = new DockView(this.hud.root);
    this.dockView.onClose = () => this.viewManager.leaveDock();
    this.dockView.onLaunchShip = (ship, base) => this.launch(ship, base);
    this.viewManager.setDocking(this);
  }

  // ドックビュー表示中の [ESC] を消費して閉じる。ポーズメニューより先に呼ぶ:
  // 先に消費しないと、同じキーで設定画面も同時に開く。
  handleInput(input: Input): void {
    if (this.viewManager.current !== 'dock') return;
    if (input.takeKey(K.pauseMenu)) this.viewManager.leaveDock();
  }

  // 基地をドックビューの対象に据え、そのままドックビューへ遷移する。
  activate(base: Base): void {
    this._activeBase = base;
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
    this.game.pause();
    this.dockView.open(this._activeBase, this.game.player, this.game.isCreative);
  }

  // ViewManager がドックから出るときに呼ぶ。
  leaveDock(): void {
    this.dockView.close();
    if (this.game.isPaused) this.game.resume();
  }

  // 生存中の全艦について基地との距離・相対速度を調べ、収容条件を満たす艦を収容する。
  // ドックビューが開いている間は呼ばない(呼び出し側の Game.update が保証する)。
  checkProximity(): void {
    for (const base of this.entities.bases) {
      if (!base.alive) continue;
      for (const ship of [...this.entities.players]) {
        if (!ship.alive) continue;
        const dist = len(sub(ship.state.r, base.state.r));
        const relSpeed = len(sub(ship.state.v, base.state.v));
        if (dist < C.DOCK_CAPTURE_DIST && relSpeed < C.DOCK_CAPTURE_REL_V) this.dock(ship, base);
      }
    }
  }

  private dock(ship: Player, base: Base): void {
    base.baseState.dockedShips.push({
      id: ship.id,
      name: ship.displayName,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
    });
    ship.alive = false;
    // parkPlayer した艦は以後 syncPlayer が呼ばれないので、可視状態を一度だけここで確定させる。
    ship.obj.visible = false;
    const wasActive = this.game.player === ship;
    this.mapPicker.close();
    this.cameraSystem.overviewCamera.clearFocusIf(ship.id);
    if (wasActive) ship.clearTransientCommands();
    this.entities.parkPlayer(ship);
    if (wasActive) this.game.setActivePlayerOrNull(this.entities.players.find((p) => p.alive) ?? null);
    this.hud.hint(`${ship.displayName} を基地に収容しました`);
  }

  private launch(ship: Player, base: Base): void {
    const br = base.state.r;
    ship.state = orbitState(base.state.t, v3(br.x + 600, br.y, br.z), base.state.v);
    ship.alive = true;
    this.entities.addPlayer(ship);
    this.game.setActivePlayer(ship);
    this.viewManager.leaveDock();
    this.hud.hint(`${ship.displayName} を発進しました`);
  }

}
