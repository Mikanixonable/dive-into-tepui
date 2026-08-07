// マップ上の被選択物(MapPickable)まわり一式 — このフレームの候補列の組み立て、右クリックの
// 解決、種別ごとのメニュー項目、選ばれた操作の各所有者への配分。候補列は1本だけ持つ:
// 種類ごとに列を分けると、片方しか見ない消費側が出て「メニューには出るがフォーカスは効かない」
// ように割れる。
import * as C from './const';
import { Hud } from './hud/hud';
import { fmtTime } from './hud/utils';
import { ContextMenu, MenuItem } from './hud/context-menu';
import { MapPickable, pickNearest } from './map-pick';
import type { Input } from './input/input';
import { EntityManager } from './simulation/entity-manager';
import { Ephemeris } from '../physics/ephemeris';
import { NavTarget } from './nav-target';
import { CameraSystem } from './camera/camera-system';
import { PlanEditor } from './plan/plan-editor';
import { SimSpeedManager } from './sim-speed-manager';
import type { Game } from './game';
import { v3 } from '../physics/vec3';

type MapAction = 'focus' | 'navTarget' | 'warp' | 'addNode' | 'activate' | 'followToggle' | 'delete' | 'cancel' | 'openShipPlacer';
type MapMenuItem = MenuItem<MapAction>;

export class MapPicker {
  private readonly menu = new ContextMenu<MapPickable, MapAction>();
  private items: readonly MapPickable[] = [];

  // このフレームの被選択物候補。refresh の後に読む。
  get pickables(): readonly MapPickable[] { return this.items; }

  // 候補の供給元と、メニュー項目の実行先を参照として受け取る。
  constructor(
    private readonly game: Game,
    private readonly hud: Hud,
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly simSpeedManager: SimSpeedManager,
  ) {
    this.menu.onSelect = (act, target) => this.run(act, target);
  }

  // 航法ターゲットの AN/DN を求め直し、このフレームの候補列を組み直す(天体ラベル +
  // 生存中の自機・敵船 + AN/DN アイコン + 近地点・遠地点アイコン)。物理積分の後に呼ぶ:
  // 積分前に組むと、同フレームで sync されるメッシュと座標が1ステップずれる。
  refresh(simTime: number, displayTime: number): void {
    this.navTarget.update(this.game.player, this.entities, this.ephemeris, simTime);

    // 船の位置は表示時刻の displayState — 機体メッシュや敵マーカーと同じ未来ゴースト位置に揃える。
    const items: MapPickable[] = [...this.cameraSystem.focusMarkers.labels];
    for (const ship of this.entities.players) {
      if (!ship.alive) continue;
      const pos = ship.displayState(displayTime)?.r;
      if (pos) items.push({ id: ship.id, name: ship.displayName, pos, kind: 'player' });
    }
    for (const enemy of this.entities.enemies) {
      if (!enemy.alive) continue;
      const pos = enemy.displayState(displayTime)?.r;
      if (pos) items.push({ id: enemy.name, name: enemy.name, pos, kind: 'ship' });
    }
    items.push(...this.navTarget.mapPickables());
    items.push(...this.editor.planDisplay.apsisMarkers);
    this.items = items;
  }

  // 右クリック位置の最寄り候補を探し、当たればその種別に応じた項目でメニューを開いて消費する。
  handleRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      let target = pickNearest(
        this.items, p.x, p.y, this.cameraSystem.activeCameraProjection, C.MAP_PICK_PX_SQ,
      );
      if (!target) return false;
      this.menu.open(p.x, p.y, target, this.itemsFor(target, simTime));
      return true;
    });
  }

  // 何も当たらなかった場合、クリエイティブモードであれば「空域」として扱う（他のハンドラの後に呼ぶ）。
  handleEmptySpaceRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      if ((this.game.activeStage as any).stageId === 'creative') {
        const target = { id: 'empty', name: '宇宙空間', pos: v3(0, 0, 0), kind: 'empty-space' as any };
        this.menu.open(p.x, p.y, target, this.itemsFor(target, simTime));
        return true;
      }
      return false;
    });
  }

  // 開いたままのメニューを畳む。
  close(): void {
    this.menu.close();
  }

  // 被選択物の種別に応じたコンテキストメニュー項目。
  private itemsFor(target: MapPickable, simTime: number): readonly MapMenuItem[] {
    switch (target.kind) {
      case 'body':
      case 'ship':
        return [
          { label: 'フォーカスを移動', act: 'focus' },
          ...this.navTargetItems(target, simTime),
          { label: 'キャンセル [ESC]', act: 'cancel', shortcut: 'Escape' },
        ];
      case 'apsis': {
        const apsisTime = target.time;
        const apsisLabel = target.id === 'apsisAp' ? '遠点 (Ap)' : '近点 (Pe)';
        const apsisSubLabel = apsisTime !== undefined ? `到達まで T+${fmtTime(apsisTime - simTime)}` : undefined;
        return [
          { type: 'header', label: apsisLabel, subLabel: apsisSubLabel },
          { label: 'ここまで時間加速', act: 'warp' },
          { label: 'ここにノードを追加', act: 'addNode' },
          { label: 'フォーカスを移動', act: 'focus' },
          { label: 'キャンセル [ESC]', act: 'cancel', shortcut: 'Escape' },
        ];
      }
      // 操作対象の艦には「操作対象にする」「削除」を出さない(前者は無効、後者は自機が消える)。
      case 'player': {
        const ship = this.entities.findPlayer(target.id);
        const isActive = ship === this.game.player;
        const activate: readonly MapMenuItem[] = isActive ? [] : [{ label: '操作対象にする', act: 'activate' }];
        const remove: readonly MapMenuItem[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
        return [
          ...activate,
          { label: ship?.followPlan ? '軌道計画への自動追従 OFF' : '軌道計画への自動追従 ON', act: 'followToggle' },
          { label: 'フォーカスを移動', act: 'focus' },
          ...this.navTargetItems(target, simTime),
          ...remove,
          { label: 'キャンセル [ESC]', act: 'cancel', shortcut: 'Escape' },
        ];
      }
      case 'relnode': {
        const relTime = target.time;
        const relLabel = target.id === 'nav-an' ? '昇交点 (AN)' : '降交点 (DN)';
        const targetName = this.navTarget.name ?? '対象';
        const relSubLabel = `対 ${targetName}面` + (relTime !== undefined ? ` / T+${fmtTime(relTime - simTime)}` : '');
        return [
          { type: 'header', label: relLabel, subLabel: relSubLabel },
          { label: 'ここまで時間加速', act: 'warp' },
          { label: 'ここにノードを追加', act: 'addNode' },
          { label: 'フォーカスを移動', act: 'focus' },
          { label: 'キャンセル [ESC]', act: 'cancel', shortcut: 'Escape' },
        ];
      }
      case 'empty-space':
        return [
          { label: '艦艇を配置する [Enter]', act: 'openShipPlacer', shortcut: 'Enter' },
          { label: 'キャンセル [ESC]', act: 'cancel', shortcut: 'Escape' },
        ];
    }
  }

  // 対象を航法ターゲットにする/解除する項目。軌道面が定まらない対象(地球・太陽自身など)
  // では選んでも AN/DN が出ないので項目自体を出さない。
  private navTargetItems(target: MapPickable, simTime: number): readonly MapMenuItem[] {
    if (target.id === this.navTarget.id) return [{ label: '航法ターゲット解除', act: 'navTarget' }];
    const canTarget = this.navTarget.canTarget(target.id, this.entities, this.ephemeris, simTime);
    return canTarget ? [{ label: '航法ターゲットに設定', act: 'navTarget' }] : [];
  }

  // 選ばれた項目を、その操作を持つモジュールへ配る。
  private run(act: MapAction, target: MapPickable): void {
    if (act === 'focus') {
      this.cameraSystem.overviewCamera.setFocus(target.id);
      this.hud.hint(`${target.name} にフォーカス`);
    } else if (act === 'navTarget') {
      this.navTarget.toggleTarget(target.id, target.name);
    } else if (act === 'warp') {
      const t = target.time ?? (target.kind === 'apsis'
        ? this.editor.planDisplay.apsisTimeOf(target.id)
        : this.navTarget.passTimeOf(target.id));
      if (t !== null && !this.simSpeedManager.startAutoWarpTo(t, this.game.simTime)) {
        this.hud.hint('この時刻は既に通過しています');
      }
    } else if (act === 'addNode') {
      const t = target.time ?? (target.kind === 'apsis'
        ? this.editor.planDisplay.apsisTimeOf(target.id)
        : this.navTarget.passTimeOf(target.id));
      if (t !== null) this.editor.addNodeAt(t);
      else this.hud.hint('この時刻の計画軌道が求まりません');
    } else if (act === 'activate') {
      const ship = this.entities.findPlayer(target.id);
      if (ship) this.game.setActivePlayer(ship);
    } else if (act === 'followToggle') {
      const ship = this.entities.findPlayer(target.id);
      if (ship) ship.followPlan = !ship.followPlan;
    } else if (act === 'delete') {
      const ship = this.entities.findPlayer(target.id);
      if (ship) this.game.removeCreativePlayer(ship);
    } else if (act === 'openShipPlacer') {
      if ((this.game.activeStage as any).stageId === 'creative') {
        (this.game.activeStage as any).openShipPlacer();
      }
    }
  }
}
