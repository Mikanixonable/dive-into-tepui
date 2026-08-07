// 基地への収容・発進まわり一式。Player(艦の操作)・EntityManager(配置)・DockView(UI)・
// Game(操作対象/カメラ/計画編集の付け替え)にまたがる横断的な関心事なので、Game に分岐と
// 組み立てを残さずここへ切り出す(所有者が1つに定まらない GUI/挙動は横断そのものを
// 責務とするモジュールを立てる — MapPicker/MapModeToggler と同じ形)。
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

export class Docking {
  readonly dockView: DockView;

  constructor(
    private readonly game: Game,
    private readonly hud: Hud,
    private readonly entities: EntityManager,
    private readonly mapPicker: MapPicker,
    private readonly cameraSystem: CameraSystem,
  ) {
    this.dockView = new DockView(this.hud.root);
    this.dockView.onClose = () => this.close();
    this.dockView.onLaunchShip = (ship, base) => this.launch(ship, base);
  }

  // ドックビュー表示中の [ESC] を消費して閉じる。ポーズメニューより先に呼ぶ:
  // 先に消費しないと、同じキーで設定画面も同時に開く。
  handleInput(input: Input): void {
    if (!this.dockView.visible) return;
    if (input.takeKey(K.pauseMenu)) this.close();
  }

  // ドックビューを閉じ、開いたときに掛けたポーズを解く。
  close(): void {
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
    this.close();
    this.hud.hint(`${ship.displayName} を発進しました`);
  }

  open(base: Base): void {
    this.game.pause();
    this.dockView.open(base, this.game.player, this.game.isCreative);
  }
}
