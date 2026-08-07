// マップ上の被選択物(MapPickable)まわり一式 — このフレームの候補列の組み立て、右クリックの
// 解決、種別ごとのメニュー項目、選ばれた操作の各所有者への配分。候補列は1本だけ持つ:
// 種類ごとに列を分けると、片方しか見ない消費側が出て「メニューには出るがフォーカスは効かない」
// ように割れる。
import * as C from './const';
import { Hud } from './hud/hud';
import { fmtTime } from './hud/utils';
import { ContextMenu, MenuItem } from './hud/context-menu';
import { MenuAction, MenuCommon } from './hud/menu-actions';
import { MapPickable, pickNearest } from './map-pick';
import { ObjectListPanel } from './object-list-panel';
import type { Input } from './input/input';
import { EntityManager } from './simulation/entity-manager';
import { Ephemeris } from '../physics/ephemeris';
import { NavTarget } from './nav-target';
import { CameraSystem } from './camera/camera-system';
import { PlanEditor } from './plan/plan-editor';
import { SimSpeedManager } from './sim-speed-manager';
import type { Game } from './game';
import { v3 } from '../physics/vec3';

interface PickHandler {
  itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[];
  run(act: MenuAction, target: MapPickable): void;
}

export class MapPicker {
  private readonly menu = new ContextMenu<MapPickable, MenuAction>();
  private readonly objectListPanel: ObjectListPanel;
  private objectListVisible = false;
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
    this.menu.onSelect = (act, target) => {
      const handler = this.handlers[target.kind];
      if (handler) handler.run(act, target);
    };
    this.objectListPanel = new ObjectListPanel(hud.root);
    this.objectListPanel.onSelect = (id) => {
      this.cameraSystem.overviewCamera.setFocus(id);
      this.hud.hint(`${this.items.find((i) => i.id === id)?.name ?? id} にフォーカス`);
    };
    this.objectListPanel.onClose = () => {
      this.objectListVisible = false;
    };
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
    for (const ammo of this.entities.ammos) {
      if (!ammo.alive) continue;
      const pos = ammo.displayState(displayTime)?.r;
      if (pos) items.push({ id: ammo.id ?? 'ammo', name: '弾薬', pos, kind: 'ammo' });
    }
    for (const base of this.entities.bases) {
      if (!base.alive) continue;
      const pos = base.displayState(displayTime)?.r;
      if (pos) items.push({ id: base.id, name: '基地', pos, kind: 'base' });
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

  // 何も当たらなかった場合、「空域」として扱う（他のハンドラの後に呼ぶ）。
  handleEmptySpaceRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      const target = { id: 'empty', name: '宇宙空間', pos: v3(0, 0, 0), kind: 'empty-space' as any };
      this.menu.open(p.x, p.y, target, this.itemsFor(target, simTime));
      return true;
    });
  }

  // 軌道オブジェクトウィンドウの表示状態を、マップ視点かどうかと合わせて反映する。
  sync(overviewMode: boolean): void {
    const visible = overviewMode && this.objectListVisible;
    this.objectListPanel.setVisible(visible);
    if (visible) this.objectListPanel.sync(this.items, this.cameraSystem.overviewCamera.focus);
  }

  // 開いたままのメニュー・ウィンドウを畳む。
  close(): void {
    this.menu.close();
    this.objectListVisible = false;
  }

  private readonly handlers: Record<MapPickable['kind'], PickHandler> = {
    'body': {
      itemsFor: (target, simTime) => {
        let subLabel = '天体・ラグランジュ点';
        if (target.id === 'earth') subLabel = '母星 (中心天体)';
        else if (target.id === 'moon') subLabel = '衛星 (月)';
        else if (target.id === 'sun') subLabel = '恒星 (太陽)';
        else if (target.id.startsWith('em-l')) subLabel = '地球-月 ラグランジュ点';
        else if (target.id.startsWith('se-l')) subLabel = '太陽-地球 ラグランジュ点';
        return [
          { type: 'header', label: target.name, subLabel },
          MenuCommon.focus(),
          ...this.navTargetItems(target, simTime),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runBodyShip(act, target),
    },
    'ship': {
      itemsFor: (target, simTime) => [
        MenuCommon.focus(),
        ...this.navTargetItems(target, simTime),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const enemy = this.entities.enemies.find(e => e.name === target.id);
          if (enemy) enemy.alive = false;
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'ammo': {
      itemsFor: (target, simTime) => [
        MenuCommon.focus(),
        ...this.navTargetItems(target, simTime),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const ammo = this.entities.ammos.find(a => a.id === target.id);
          if (ammo) ammo.alive = false;
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'apsis': {
      itemsFor: (target, simTime) => {
        const apsisTime = target.time;
        const apsisLabel = target.id === 'apsisAp' ? '遠点 (Ap)' : '近点 (Pe)';
        const apsisSubLabel = apsisTime !== undefined ? `到達まで T+${fmtTime(apsisTime - simTime)}` : undefined;
        return [
          { type: 'header', label: apsisLabel, subLabel: apsisSubLabel },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'relnode': {
      itemsFor: (target, simTime) => {
        const relTime = target.time;
        const relLabel = target.id === 'nav-an' ? '昇交点 (AN)' : '降交点 (DN)';
        const targetName = this.navTarget.name ?? '対象';
        const relSubLabel = `対 ${targetName}面` + (relTime !== undefined ? ` / T+${fmtTime(relTime - simTime)}` : '');
        return [
          { type: 'header', label: relLabel, subLabel: relSubLabel },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'eqnode': {
      itemsFor: (target, simTime) => {
        const eqTime = target.time;
        const isMoon = target.id.endsWith('Moon');
        const prefix = isMoon ? '月' : '';
        const isAn = target.id.startsWith('eqAn');
        const eqLabel = `${prefix}赤道${isAn ? '昇' : '降'}交点 (${isAn ? 'EqAN' : 'EqDN'})`;
        const eqSubLabel = eqTime !== undefined ? `到達まで T+${fmtTime(eqTime - simTime)}` : undefined;
        return [
          { type: 'header', label: eqLabel, subLabel: eqSubLabel },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'player': {
      itemsFor: (target, simTime) => {
        const ship = this.entities.findPlayer(target.id);
        const isActive = ship === this.game.player;
        const activate: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '操作対象にする', act: 'activate' }];
        const remove: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
        return [
          ...activate,
          { label: ship?.followPlan ? '軌道計画への自動追従 OFF' : '軌道計画への自動追従 ON', act: 'followToggle' },
          MenuCommon.focus(),
          ...this.navTargetItems(target, simTime),
          ...remove,
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        if (act === 'activate') {
          const ship = this.entities.findPlayer(target.id);
          if (ship) this.game.setActivePlayer(ship);
        } else if (act === 'followToggle') {
          const ship = this.entities.findPlayer(target.id);
          if (ship) ship.followPlan = !ship.followPlan;
        } else if (act === 'delete') {
          const ship = this.entities.findPlayer(target.id);
          if (ship) this.game.removeCreativePlayer(ship);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'empty-space': {
      itemsFor: () => {
        const isCreative = (this.game.activeStage as any).stageId === 'creative';
        const placeItem: readonly MenuItem<MenuAction>[] = isCreative
          ? [{ label: 'オブジェクトを配置する', act: 'openShipPlacer', shortcut: 'Enter' }]
          : [];
        return [
          ...placeItem,
          { label: '軌道オブジェクトウィンドウを表示', act: 'openObjectList' },
          MenuCommon.cancel(),
        ];
      },
      run: (act) => {
        if (act === 'openShipPlacer') {
          if ((this.game.activeStage as any).stageId === 'creative') {
            (this.game.activeStage as any).openShipPlacer();
          }
        } else if (act === 'openObjectList') {
          this.objectListVisible = true;
        }
      },
    },
    'base': {
      itemsFor: (target) => {
        const base = this.entities.findBase(target.id);
        const subLabel = base 
          ? `所持金: ${base.baseState.money.toLocaleString()} Cr / 格納船: ${base.baseState.dockedShips.length}隻`
          : '基地';
        return [
          { type: 'header', label: '基地', subLabel },
          { label: 'ドックビューを開く', act: 'openDock' },
          { label: '別の船を発進', act: 'activate' },
          MenuCommon.focus(),
          ...this.navTargetItems(target, 0),
          { label: '削除', act: 'delete' },
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const base = this.entities.findBase(target.id);
        if (act === 'delete') {
          if (base) base.alive = false;
        } else if (act === 'openDock') {
          if (base) this.game.openDockView(base);
          else this.hud.hint('基地が見つかりません');
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
  };

  // 被選択物の種別に応じたコンテキストメニュー項目。
  private itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[] {
    const handler = this.handlers[target.kind];
    return handler ? handler.itemsFor(target, simTime) : [];
  }

  // 対象を航法ターゲットにする/解除する項目。軌道面が定まらない対象(地球・太陽自身など)
  // では選んでも AN/DN が出ないので項目自体を出さない。
  private navTargetItems(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[] {
    if (target.id === this.navTarget.id) return [MenuCommon.navTarget(true)];
    const canTarget = this.navTarget.canTarget(target.id, this.entities, this.ephemeris, simTime);
    return canTarget ? [MenuCommon.navTarget(false)] : [];
  }

  private runBodyShip(act: MenuAction, target: MapPickable): void {
    if (act === 'focus') {
      this.cameraSystem.overviewCamera.setFocus(target.id);
      this.hud.hint(`${target.name} にフォーカス`);
    } else if (act === 'navTarget') {
      this.navTarget.toggleTarget(target.id, target.name);
    }
  }

  private runApsisRelnode(act: MenuAction, target: MapPickable): void {
    if (act === 'warp') {
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
    } else {
      this.runBodyShip(act, target);
    }
  }
}
