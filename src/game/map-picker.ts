// マップ上の被選択物(MapPickable)まわり一式 — このフレームの候補列の組み立て、右クリックの
// 解決、種別ごとのメニュー項目、選ばれた操作の各所有者への配分。候補列は1本だけ持つ:
// 種類ごとに列を分けると、片方しか見ない消費側が出て「メニューには出るがフォーカスは効かない」
// ように割れる。
import * as C from './const';
import { Hud } from './hud/hud';
import { fmtAmmoStatus, fmtDist, fmtEnergy, fmtSpeed, fmtTime } from './hud/utils';
import { orbitInfo, relativeInfo } from './hud/orbit-info';
import { ContextMenu, MenuItem } from './hud/context-menu';
import { PropertyRow, PropertyWindow, PropertyWindowContent, PropertyWindowItem } from './hud/property-window';
import { MenuAction, MenuCommon } from './hud/menu-actions';
import { ATTRACTOR_NAMES } from './hud/frame-labels';
import { MapPickable, pickNearest } from './map-pick';
import { ObjectListPanel } from './object-list-panel';
import type { Input } from './input/input';
import { EntityManager } from './simulation/entity-manager';
import { Ephemeris } from '../physics/ephemeris';
import { NavTarget } from './nav-target';
import { CameraSystem } from './camera/camera-system';
import { PlanEditor } from './plan/plan-editor';
import { SimSpeedManager } from './sim-speed-manager';
import type { Docking } from './docking';
import type { Game } from './game';
import type { Player } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import { len, sub, v3 } from '../physics/vec3';
import type { ObjectType } from './creative/ship-placer-panel';
import type { OrbitState } from '../physics/orbital-state';
import { AttractorId, Attractor, elementsAround, strongestAttractor } from '../physics/attractor';
import { apsisAltitudes } from '../physics/elements';
import { SOLAR_SYSTEM, bodyDef, primaryOf } from '../physics/solar-system';

interface PickHandler {
  itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[];
  run(act: MenuAction, target: MapPickable): void;
}

// 開いているプロパティウィンドウ本体と、開いた時点の対象。rows/items の再導出はこの target
// (毎フレーム候補列から更新されうる)を経由するので、対象が消滅したかどうかの判定にも使える。
interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  target: MapPickable;
}

export class MapPicker {
  // 'empty-space' は宇宙空間そのものでプロパティを持たないので、従来どおり ContextMenu を使う。
  private readonly menu = new ContextMenu<MapPickable, MenuAction>();
  // 開いているプロパティウィンドウ。`${kind}:${id}` でオブジェクト1つにつき高々1枚に保つ。
  private readonly windows = new Map<string, WindowEntry>();
  // クリップされていない一時ウィンドウのキー。存在は高々1枚。
  private tempWindowKey: string | null = null;
  private readonly objectListPanel: ObjectListPanel;
  private objectListVisible = false;
  private items: readonly MapPickable[] = [];

  // このフレームの被選択物候補。refresh の後に読む。
  get pickables(): readonly MapPickable[] { return this.items; }

  // Docking は MapPicker より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void { this.docking = docking; }
  private docking: Docking | null = null;

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

  // 天体ラベルと航法ターゲットの AN/DN を求め直し、このフレームの候補列を組み直す(天体ラベル +
  // 生存中の自機・敵船 + AN/DN アイコン + 近地点・遠地点アイコン)。どちらも候補列の一部なので、
  // 求め直しとの対応付けはここに閉じる。物理積分の後に呼ぶ: 積分前に組むと、同フレームで
  // sync されるメッシュと座標が1ステップずれる。
  refresh(simTime: number, displayTime: number): void {
    this.cameraSystem.focusMarkers.update(displayTime);
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
      if (pos) items.push({ id: ammo.id, name: '弾薬', pos, kind: 'ammo' });
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

  // 右クリック位置の最寄り候補を探し、当たればその種別に応じたプロパティウィンドウを開いて消費する。
  handleRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      const target = pickNearest(
        this.items, p.x, p.y, this.cameraSystem.activeCameraProjection, C.MAP_PICK_PX_SQ,
      );
      if (!target) return false;
      this.openPropertyWindow(p.x, p.y, target, simTime);
      return true;
    });
  }

  // 対象1つにつきウィンドウは高々1枚: 既存があればクリック位置へ動かして最前面に出すだけで
  // 新規には開かない。新規に開いたウィンドウは既定でクリップされておらず一時ウィンドウとなるので、
  // 既存の一時ウィンドウがあれば入れ替わりに閉じる。
  private openPropertyWindow(clientX: number, clientY: number, target: MapPickable, simTime: number): void {
    const key = this.windowKey(target);
    const existing = this.windows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const w = new PropertyWindow<MenuAction>(this.hud.root, clientX, clientY, this.buildContent(target, simTime));
    const entry: WindowEntry = { win: w, target };
    this.windows.set(key, entry);
    if (!w.clipped) {
      if (this.tempWindowKey !== null) this.closeWindow(this.tempWindowKey);
      this.tempWindowKey = key;
    }
    // 実行時は entry.target(sync のたびに最新化される)を読む — 開いた瞬間の対象を
    // 捕まえたままだと、時刻に依存する操作(ワープ・ノード追加)が古い時刻へ向けて走ってしまう。
    // 操作項目のクリックは、クリップ済みなら開いたままにする。「削除」は対象自体が消えるので
    // クリップ状態によらず閉じる。
    w.onSelect = (act) => {
      const handler = this.handlers[entry.target.kind];
      if (handler) handler.run(act, entry.target);
      if (act === 'delete' || !w.clipped) this.closeWindow(key);
    };
    w.onClose = () => this.forgetWindow(key);
    w.onOutsideClick = () => { if (!w.clipped) this.closeWindow(key); };
    // クリップした瞬間に一時ウィンドウの座を明け渡し、逆にクリップを外した瞬間は既存の
    // 一時ウィンドウ(あれば)を閉じてその座に就く — 「一時ウィンドウは高々1枚」を両方向で保つ。
    w.onClipChange = (clipped) => {
      if (clipped) {
        if (this.tempWindowKey === key) this.tempWindowKey = null;
      } else {
        if (this.tempWindowKey !== null && this.tempWindowKey !== key) this.closeWindow(this.tempWindowKey);
        this.tempWindowKey = key;
      }
    };
  }

  // windows/tempWindowKey のキー。kind をまたいで id が衝突しないよう種別込みにする。
  private windowKey(target: MapPickable): string {
    return `${target.kind}:${target.id}`;
  }

  // 台帳から外すだけで DOM 破棄はしない — ✕ ボタン自身が dispose 済みのときに呼ぶ経路。
  private forgetWindow(key: string): void {
    this.windows.delete(key);
    if (this.tempWindowKey === key) this.tempWindowKey = null;
  }

  // ✕ ボタン以外の経路(対象消滅・ビュー離脱・一時ウィンドウの入れ替わり)で閉じる。
  private closeWindow(key: string): void {
    const entry = this.windows.get(key);
    if (!entry) return;
    entry.win.dispose();
    this.forgetWindow(key);
  }

  // 何も当たらなかった場合、「空域」として扱う（他のハンドラの後に呼ぶ）。
  handleEmptySpaceRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      const target = { id: 'empty', name: '宇宙空間', pos: v3(0, 0, 0), kind: 'empty-space' as any };
      this.menu.open(p.x, p.y, target, this.itemsFor(target, simTime));
      return true;
    });
  }

  // 軌道オブジェクトウィンドウの表示状態をマップ視点かどうかと合わせて反映し、開いている
  // 全プロパティウィンドウの値を最新化する。対象そのものが消滅していれば(撃破・回収・削除)
  // 閉じる — 未来ゴースト時刻で位置が求まらないだけのフレーム(displayState が null)は
  // 候補列(this.items)から外れるだけで消滅ではないので、生存判定は対象の alive で行う。
  sync(overviewMode: boolean, simTime: number, bodies: readonly Attractor[], player: Player | null): void {
    const visible = overviewMode && this.objectListVisible;
    this.objectListPanel.setVisible(visible);
    if (visible) this.objectListPanel.sync(this.items, this.cameraSystem.overviewCamera.focus);

    const byKey = new Map(this.items.map((i) => [this.windowKey(i), i]));
    for (const [key, entry] of [...this.windows]) {
      if (this.isTargetGone(entry.target)) { this.closeWindow(key); continue; }
      // 候補列に載っていれば最新の位置を反映し、載っていなければ開いた時点の対象のまま
      // 据え置く(rows の導出はどの種別も実体の state を直接読むので、位置の鮮度は無関係)。
      entry.target = byKey.get(key) ?? entry.target;
      const { title, subtitle, items } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRows(this.buildRows(entry.target, bodies, player, simTime));
      entry.win.syncItems(items);
    }
  }

  // ウィンドウの対象そのものが消滅したかどうか。生きている実体を指す種別は alive を直接見て、
  // 未来ゴースト時刻で位置が求まらないだけの休止フレームでは閉じないようにする。それ以外の
  // 種別(天体・アプシス・AN/DN)は実体を持たないので、候補列に載っているかで判定する。
  private isTargetGone(target: MapPickable): boolean {
    switch (target.kind) {
      case 'player': return !(this.entities.findPlayer(target.id)?.alive ?? false);
      case 'ship': return !(this.entities.enemies.find((e) => e.name === target.id)?.alive ?? false);
      case 'ammo': return !(this.entities.ammos.find((a) => a.id === target.id)?.alive ?? false);
      case 'base': return !(this.entities.findBase(target.id)?.alive ?? false);
      default: return !this.items.some((i) => this.windowKey(i) === this.windowKey(target));
    }
  }

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときに呼ぶ。
  close(): void {
    this.menu.close();
    this.objectListVisible = false;
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
  }

  private readonly handlers: Record<MapPickable['kind'], PickHandler> = {
    'body': {
      itemsFor: (target, simTime) => {
        let subLabel = '天体・ラグランジュ点';
        if (target.id === 'earth') subLabel = '母星 (中心天体)';
        else if (target.id === 'moon') subLabel = '衛星 (月)';
        else if (target.id === 'sun') subLabel = '恒星 (太陽)';
        else if (target.id.startsWith('moon-l')) subLabel = '地球-月 ラグランジュ点';
        else if (target.id.startsWith('earth-l')) subLabel = '太陽-地球 ラグランジュ点';
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
        ...this.duplicateItems(),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const enemy = this.entities.enemies.find(e => e.name === target.id);
          if (enemy) enemy.alive = false;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'ammo': {
      itemsFor: (target, simTime) => [
        MenuCommon.focus(),
        ...this.navTargetItems(target, simTime),
        ...this.duplicateItems(),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const ammo = this.entities.ammos.find(a => a.id === target.id);
          if (ammo) ammo.alive = false;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
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
        const isAn = target.id.endsWith('-eqan');
        const eqLabel = `${ATTRACTOR_NAMES[this.eqNodeCenterId(target)]}赤道${isAn ? '昇' : '降'}交点 (${isAn ? 'EqAN' : 'EqDN'})`;
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
          ...this.duplicateItems(),
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
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
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
        const placeItem: readonly MenuItem<MenuAction>[] = this.isCreativeMode()
          ? [{ label: 'オブジェクトを配置する', act: 'openShipPlacer', shortcut: 'Enter' }]
          : [];
        return [
          ...placeItem,
          { label: '軌道オブジェクトウィンドウを表示', act: 'openObjectList' },
          { label: '設定メニューを開く', act: 'openSettings' },
          MenuCommon.cancel(),
        ];
      },
      run: (act) => {
        if (act === 'openShipPlacer') {
          if (this.isCreativeMode()) {
            (this.game.activeStage as any).openShipPlacer(this.game.cameraSystem.overviewCamera.focus);
          }
        } else if (act === 'openObjectList') {
          this.objectListVisible = true;
        } else if (act === 'openSettings') {
          this.game.openSettingsMenu();
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
          MenuCommon.focus(),
          ...this.navTargetItems(target, 0),
          ...this.duplicateItems(),
          { label: '削除', act: 'delete' },
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const base = this.entities.findBase(target.id);
        if (act === 'delete') {
          if (base) {
            this.docking?.clearActiveBaseIf(base);
            base.alive = false;
          }
        } else if (act === 'openDock') {
          if (base) this.docking?.activate(base);
          else this.hud.hint('基地が見つかりません');
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
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

  // クリエイティブモードで実行中かどうか。activeStage を CreativeStage として直接扱えないので、
  // 既存の型消去アクセスをここへ集約する。
  private isCreativeMode(): boolean {
    return (this.game.activeStage as any).stageId === 'creative';
  }

  // 「複製」項目。クリエイティブモードでのみ出す — 複製先が艦艇配置パネルであり、
  // 通常ステージには存在しないため。
  private duplicateItems(): readonly MenuItem<MenuAction>[] {
    return this.isCreativeMode() ? [MenuCommon.duplicate()] : [];
  }

  // 対象の現在状態を軌道要素へ逆算し、その値をプリセットして艦艇配置パネルを開く。
  private runDuplicate(target: MapPickable): void {
    if (!this.isCreativeMode()) return;
    const source = this.duplicateSourceFor(target);
    if (!source) return;
    (this.game.activeStage as any).openShipPlacerForDuplicate(source.objectType, source.state);
  }

  // MapPickable を、複製できる実体の種類とその現在状態へ解決する。複製できない種別(天体・
  // 近点/遠点アイコン・相対AN/DN)ではメニュー自体を出していないので、ここに到達しない。
  private duplicateSourceFor(target: MapPickable): { objectType: ObjectType; state: OrbitState } | null {
    switch (target.kind) {
      case 'player': {
        const ship = this.entities.findPlayer(target.id);
        return ship ? { objectType: 'player', state: ship.state } : null;
      }
      case 'ship': {
        const enemy = this.entities.enemies.find((e) => e.name === target.id);
        return enemy ? { objectType: 'enemy', state: enemy.state } : null;
      }
      case 'ammo': {
        const ammo = this.entities.ammos.find((a) => a.id === target.id);
        return ammo ? { objectType: 'ammo', state: ammo.state } : null;
      }
      case 'base': {
        const base = this.entities.findBase(target.id);
        return base ? { objectType: 'base', state: base.state } : null;
      }
      default:
        return null;
    }
  }

  // itemsFor の出力をプロパティウィンドウの形へ組み替える: header 項目はタイトル/サブタイトルへ
  // 抜き出す。開いた直後から sync 時と同じ経路(windowParts)で求める。
  private buildContent(target: MapPickable, simTime: number): PropertyWindowContent<MenuAction> {
    const { title, subtitle, items } = this.windowParts(target, simTime);
    return { title, subtitle, rows: [], items };
  }

  // タイトル・サブタイトルは到達まで T+… や所持金など、操作項目は操作対象か・追従状態・
  // 航法ターゲットかなど、どちらも可変な状態に依存するため itemsFor を毎フレーム呼び直す
  // 必要があるが、呼び出しは1回にまとめる(header 項目からタイトル/サブタイトルを抜き出し、
  // 残りを操作項目とする)。
  private windowParts(
    target: MapPickable, simTime: number,
  ): { title: string; subtitle?: string; items: PropertyWindowItem<MenuAction>[] } {
    const all = this.itemsFor(target, simTime);
    const header = all.find((it) => it.type === 'header');
    const items = all
      .filter((it) => it.type !== 'header' && it.act !== undefined)
      .map((it) => ({ label: it.label, act: it.act as MenuAction, shortcut: it.shortcut }));
    return { title: header?.label ?? target.name, subtitle: header?.subLabel, items };
  }

  // 種別ごとのプロパティ行。値の導出は sync フェーズで毎フレーム呼び直す(表示専用のため)。
  private buildRows(
    target: MapPickable, bodies: readonly Attractor[], player: Player | null, simTime: number,
  ): PropertyRow[] {
    switch (target.kind) {
      case 'player': return this.playerRows(target, bodies);
      case 'ship': return this.shipRows(target, bodies, player);
      case 'base': return this.baseRows(target, bodies, player);
      case 'ammo': return this.ammoRows(target, bodies, player);
      case 'body': return this.bodyRows(target, bodies, player);
      case 'apsis': return this.apsisRows(target, bodies, simTime);
      case 'relnode': case 'eqnode': return this.nodeRows(target, simTime);
      case 'empty-space': return [];
    }
  }

  // 基準天体・高度・速度・AP/PE/INC/PRD の軌道要素一式。ship/base/ammo/player 共通で使う。
  private orbitRows(entity: GameEntity, bodies: readonly Attractor[]): PropertyRow[] {
    const oi = orbitInfo(entity, bodies);
    return [
      { key: 'center', label: '基準天体', value: oi.centerName },
      { key: 'alt', label: '高度', value: fmtDist(oi.alt) },
      { key: 'spd', label: '速度', value: fmtSpeed(oi.spd) },
      { key: 'ap', label: '遠地点 AP', value: fmtDist(oi.apAlt) },
      { key: 'pe', label: '近地点 PE', value: fmtDist(oi.peAlt) },
      { key: 'inc', label: '傾斜角 INC', value: isFinite(oi.incDeg) ? `${oi.incDeg.toFixed(2)}°` : '---' },
      { key: 'prd', label: '周期 PRD', value: fmtTime(oi.period) },
    ];
  }

  // 名前は既にウィンドウのタイトルにあるので行には含めない。
  private playerRows(target: MapPickable, bodies: readonly Attractor[]): PropertyRow[] {
    const ship = this.entities.findPlayer(target.id);
    if (!ship) return [];
    return [
      { key: 'active', label: '操作対象か', value: ship === this.game.player ? 'はい' : 'いいえ' },
      { key: 'follow', label: '計画追従', value: ship.followPlan ? 'ON' : 'OFF' },
      { key: 'hp', label: '装甲', value: `${Math.floor(ship.hp)} / ${ship.maxHp}` },
      { key: 'temp', label: '温度', value: `${ship.thermal.hullTemp.toFixed(0)} K` },
      { key: 'power', label: '電力', value: fmtEnergy(ship.power.chargeJ) },
      { key: 'ammo', label: '弾薬', value: fmtAmmoStatus(ship.roundsInMag, ship.magsLeft, ship.reloadTimer) },
      ...this.orbitRows(ship, bodies),
    ];
  }

  // 自機がいなければ距離・接近速度・相対速度・相対傾斜角の行はそもそも出さない。
  private shipRows(target: MapPickable, bodies: readonly Attractor[], player: Player | null): PropertyRow[] {
    const enemy = this.entities.enemies.find((e) => e.name === target.id);
    if (!enemy) return [];
    const rel = player ? relativeInfo(player, enemy, bodies) : null;
    const rows: PropertyRow[] = [{ key: 'hp', label: '装甲', value: `${Math.floor(enemy.hp)} / ${enemy.maxHp}` }];
    if (rel) {
      rows.push(
        { key: 'dist', label: '距離', value: fmtDist(rel.dist) },
        { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing) },
        { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed) },
      );
    }
    rows.push(...this.orbitRows(enemy, bodies));
    if (rel) {
      rows.push({
        key: 'relinc', label: '相対傾斜 [AN/DN]',
        value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---',
      });
    }
    return rows;
  }

  // 自機がいなければ距離の行は出さない。
  private baseRows(target: MapPickable, bodies: readonly Attractor[], player: Player | null): PropertyRow[] {
    const base = this.entities.findBase(target.id);
    if (!base) return [];
    const rows: PropertyRow[] = [
      { key: 'money', label: '所持金', value: `${base.baseState.money.toLocaleString()} Cr` },
      { key: 'ships', label: '格納艦数', value: `${base.baseState.dockedShips.length}` },
    ];
    if (player) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(base.state.r, player.state.r))) });
    rows.push(...this.orbitRows(base, bodies));
    return rows;
  }

  // 自機がいなければ距離の行は出さない。
  private ammoRows(target: MapPickable, bodies: readonly Attractor[], player: Player | null): PropertyRow[] {
    const ammo = this.entities.ammos.find((a) => a.id === target.id);
    if (!ammo) return [];
    const rows: PropertyRow[] = [];
    if (player) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(ammo.state.r, player.state.r))) });
    rows.push(...this.orbitRows(ammo, bodies));
    return rows;
  }

  // 実在の天体(SOLAR_SYSTEM に登録された ID)なら種別・μ・半径・(公転していれば)軌道要素を、
  // ラグランジュ点なら種別のみを出す。
  private bodyRows(target: MapPickable, bodies: readonly Attractor[], player: Player | null): PropertyRow[] {
    const rows: PropertyRow[] = [];
    if (player) rows.push({ key: 'dist', label: '自機からの距離', value: fmtDist(len(sub(target.pos, player.state.r))) });
    if (!(target.id in SOLAR_SYSTEM)) {
      rows.push({ key: 'kind', label: '種別', value: 'ラグランジュ点' });
      return rows;
    }
    const def = bodyDef(target.id as AttractorId);
    const kindLabel = def.kind === 'star' ? '恒星' : def.kind === 'planet' ? '惑星' : '衛星';
    rows.push(
      { key: 'kind', label: '種別', value: kindLabel },
      { key: 'mu', label: 'μ', value: `${def.mu.toExponential(3)} m³/s²` },
      { key: 'radius', label: '半径', value: fmtDist(def.radius) },
    );
    if (def.kind === 'star') return rows;
    const primary = bodies.find((b) => b.id === primaryOf(def.id));
    const self = bodies.find((b) => b.id === def.id);
    const el = primary && self ? elementsAround(self.state, primary) : null;
    if (!el) return rows;
    const apsis = apsisAltitudes(el);
    rows.push(
      { key: 'ap', label: '遠地点 AP', value: fmtDist(apsis.ap) },
      { key: 'pe', label: '近地点 PE', value: fmtDist(apsis.pe) },
      { key: 'inc', label: '傾斜角 INC', value: `${el.incDeg.toFixed(2)}°` },
      { key: 'prd', label: '周期 PRD', value: fmtTime(el.period) },
    );
    return rows;
  }

  // Pe/Ap の別・AN/DN の別はタイトル側(header)に既に出ているので、ここには乗せない。
  private apsisRows(target: MapPickable, bodies: readonly Attractor[], simTime: number): PropertyRow[] {
    const center = strongestAttractor(target.pos, bodies);
    const alt = len(sub(target.pos, center.state.r)) - center.radius;
    const rows: PropertyRow[] = [{ key: 'alt', label: '高度', value: fmtDist(alt) }];
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  // AN/DN の別はタイトル側(header)に既に出ているので、ここでは対象名と通過時刻のみ出す。
  private nodeRows(target: MapPickable, simTime: number): PropertyRow[] {
    const targetName = target.kind === 'relnode'
      ? (this.navTarget.name ?? '対象')
      : ATTRACTOR_NAMES[this.eqNodeCenterId(target)];
    const rows: PropertyRow[] = [{ key: 'target', label: '対象', value: targetName }];
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  // 赤道交点アイコンの id は `${中心天体}-eqan`/`${中心天体}-eqdn`(plan-display.ts)。
  private eqNodeCenterId(target: MapPickable): AttractorId {
    return target.id.replace(/-eq(an|dn)$/, '') as AttractorId;
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
