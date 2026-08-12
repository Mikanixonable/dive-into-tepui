import * as THREE from 'three/webgpu';
import { add, addScaled, dot, lenSq, norm, scale, sub, v3, Vec3 } from '../physics/vec3';
import { Attractor, strongestAttractor } from '../physics/attractor';
import { OrbitLine } from './orbit-line';
import * as C from './const';
import { ACCENT_SECONDARY } from './theme';
import { Enemy } from './game-entity/enemy';
import type { EntityManager } from './simulation/entity-manager';
import { Player } from './player/player';
import { Hud } from './hud/hud';
import { Sfx } from '../audio/sfx';
import { Input, PointerPoint } from './input/input';
import { ProjectFn, ScaleFn } from './camera/camera-system';
import type { GroupedMarkerItem } from './marker/grouped-markers';
import { ContextMenu, MenuItem } from './hud/context-menu';
import { MenuAction, MenuCommon } from './hud/menu-actions';
import { MarkerManager } from './marker/marker-manager';
import { DIRECTION_GLYPH } from './marker/marker-glyphs';
import { FloatingOrigin } from './floating-origin';
import { pickNearest } from './map-pick';
import { KEY_MAPPING as K } from './input/key-mapping';
import type { SettingsPanel } from './hud/settings-panel';
import type { MapVisibilityPolicy } from './celestial/map-visibility';

export type CombatTarget = Enemy | Player;

// マーカー上での対象の役割。第一/第二ターゲットは色と字形が変わる。
export type MarkerRole = 'none' | 'primary' | 'secondary';

export class Targeter {
  // syncTargetMarkers が毎フレーム組み直す作業用配列。
  private readonly aliveScratch: CombatTarget[] = [];
  private readonly markerItemScratch: GroupedMarkerItem[] = [];

  // 唯一の真実。右クリックメニューでのみ変わり、自動選定・自動再選択は行わない。
  target: CombatTarget | null = null;
  secondaryTarget: CombatTarget | null = null;
  private targetSelectAt = -Infinity;
  private targetSelectIndex = -1;

  // ターゲット標的面(自機の方を向いた仮想の的)の通過点(ターゲット相対オフセットで
  // 保持し、的に貼り付いて見せる)。updateBoardMarks が寿命を持ち、syncBoardMarkers が描く。
  boardMarks: { off: Vec3; age: number; }[] = [];

  // ターゲット軌道のハイライト線(オレンジ)。自機軌道とほぼ重なるケースが多い
  // (近傍ランデブー狙いのため)。埋もれて見えなくならないよう強い不透明度にし、
  // renderOrder を自機軌道より上げて透明オブジェクトの描画順に依存せず必ず上に描く。
  readonly orbitLine = new OrbitLine(0xff6a00, 0.9, C.LINE_RENDER_ORDER.target);
  // 第二ターゲットのハイライト線(シアン)。第一より薄い renderOrder に置く。
  readonly secondaryOrbitLine = new OrbitLine(ACCENT_SECONDARY, 0.9, C.LINE_RENDER_ORDER.secondaryTarget);

  private readonly contextMenu: ContextMenu<CombatTarget>;
  // ターゲットに当たらなかった右クリック(何もない箇所)向けのメニュー。実体を持たない
  // 対象なので ViewBadge と同じ形で true を的替わりに使う。
  private readonly emptySpaceMenu: ContextMenu<true, MenuAction>;

  // sfx は現状未使用だが、hud/sfx は必ず対で注入する方針のため受け取る(フィールドとしては保持しない)。
  constructor(
    private readonly _hud: Hud, _sfx: Sfx, private readonly markerManager: MarkerManager,
    scene: THREE.Scene, private readonly settingsPanel: SettingsPanel,
  ) {
    this.contextMenu = new ContextMenu<CombatTarget>(_hud.layers.popup);
    this.emptySpaceMenu = new ContextMenu<true, MenuAction>(_hud.layers.popup);
    scene.add(this.secondaryOrbitLine.line);
    scene.add(this.orbitLine.line);
    this.contextMenu.onSelect = (act, picked) => {
      if (act === 'primary') this.setTarget(this.target === picked ? null : picked);
      else if (act === 'secondary') this.setSecondaryTarget(this.secondaryTarget === picked ? null : picked);
    };
    this.emptySpaceMenu.onSelect = (act) => {
      if (act === 'openSettings') this.settingsPanel.toggle(true);
    };
  }

  // 生存判定込みの現在の第一ターゲット。撃破後は target を保持したままにせず、ここで
  // 死亡個体を隠す(描画・軌道線更新など「生きているターゲットだけを見たい」箇所が使う)。
  get aliveTarget(): CombatTarget | null {
    return this.target && this.target.alive ? this.target : null;
  }

  // 生存判定込みの現在の第二ターゲット。表示専用の扱いは aliveTarget と同じ。
  get aliveSecondaryTarget(): CombatTarget | null {
    return this.secondaryTarget && this.secondaryTarget.alive ? this.secondaryTarget : null;
  }

  // アクティブ艦の切替時などに、選定済みのターゲットをまとめて解除する。
  clearTargets(): void {
    this.target = null;
    this.secondaryTarget = null;
    this.targetSelectAt = -Infinity;
    this.targetSelectIndex = -1;
  }

  // 右クリックによるターゲット選択メニューを扱う。オート選定は行わない。
  updateCombatTargeting(player: Player, targets: CombatTarget[], input: Input, project: ProjectFn): void {
    this.handleTargetSelectKey(input, targets, project);
    this.handleTargetContextMenu(input, targets, player, project);
  }

  // Tキーで照準中心に近い敵を選ぶ。連打(2秒以内)では第二ターゲット候補を順送りする。
  private handleTargetSelectKey(input: Input, targets: CombatTarget[], project: ProjectFn): void {
    if (!input.takeKey(K.targetSelect)) return;
    const now = performance.now() / 1000;
    const candidates = targets
      .filter((e) => e.alive)
      .map((target) => {
        const p = project(target.state.r);
        const dx = p.x - window.innerWidth * 0.5;
        const dy = p.y - window.innerHeight * 0.5;
        return { target, d2: dx * dx + dy * dy, front: p.front };
      })
      .filter((x) => x.front)
      .sort((a, b) => a.d2 - b.d2);
    const primary = this.aliveTarget;
    if (!primary) {
      const next = candidates[0]?.target ?? null;
      this.setTarget(next);
      this.targetSelectIndex = -1;
      this.targetSelectAt = now;
      return;
    }
    // 第一ターゲットが既にあるので、以降の連打は候補を順送りして第二ターゲットへ回す
    const secondaryCandidates = candidates.filter((x) => x.target !== primary);
    if (now - this.targetSelectAt > 2) this.targetSelectIndex = -1;
    this.targetSelectIndex = (this.targetSelectIndex + 1) % Math.max(1, secondaryCandidates.length);
    const next = secondaryCandidates[this.targetSelectIndex]?.target ?? null;
    if (next) this.setSecondaryTarget(next);
    this.targetSelectAt = now;
  }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、発射弾がその面を自機側から
  // 通過した点をターゲット相対で記録する。既存の記録は経過時間を進め、寿命切れを捨てる。
  updateBoardMarks(dt: number, player: Player, entities: EntityManager): void {
    const target = this.aliveTarget;
    // 記録側と描画側で同じ aliveTarget を見る: target のままだと撃破後も死亡個体の
    // 凍結位置を基準に ✦ を残し続けてしまう。
    if (!target) {
      this.boardMarks.length = 0;
      return;
    }
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < C.BOARD_MARK_LIFETIME;
    });
    const n = norm(sub(target.state.r, player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    // 各弾について、前フレームと今フレームの位置が的面をどちら向きに跨いだかを見る。
    for (const b of entities.bullets) {
      if (b.type !== 'normal' || !b.alive) continue; // 的通過マーカーは通常弾のみ対象
      const prevR = b.prevState.r;
      const d0 = dot(sub(prevR, target.state.r), n);
      const d1 = dot(sub(b.state.r, target.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(prevR, sub(b.state.r, prevR), t);
      const off = sub(pos, target.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > C.MAX_BOARD_MARKS) this.boardMarks.shift();
    }
  }

  // ターゲットに紐づく表示物(軌道線・的通過マーク・方位マーカー)をまとめて更新する。
  // ターゲットの選定を持つのがここなので、その表示もここに閉じる。
  sync(
    fo: FloatingOrigin, player: Player | null, targets: readonly CombatTarget[], overviewMode: boolean,
    project: ProjectFn, camera: THREE.Camera, attractors: readonly Attractor[],
    visibilityPolicy: MapVisibilityPolicy | null = null,
  ): void {
    this.syncOrbitLine(fo, player, targets, overviewMode, camera, attractors, visibilityPolicy);
    this.syncBoardMarkers(project);
    this.syncTargetDirMarkers(player, overviewMode, project);
  }

  // 全戦闘対象のマーカー集合(第一/第二ターゲットの役割を含む)と LEAD マーカーを同期する。
  // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
  // 予測地平の先を指していて displayState を返せない対象と、可視性判定で選択不可の対象は出さない。
  syncTargetMarkers(
    player: Player | null, targets: readonly CombatTarget[], displayTime: number, simTime: number,
    overviewMode: boolean, project: ProjectFn, screenScale: ScaleFn, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const viewerPos = player?.state.r ?? v3();
    this.aliveScratch.length = 0;
    this.markerItemScratch.length = 0;
    for (const tgt of targets) {
      if (!tgt.alive) continue;
      this.aliveScratch.push(tgt);
      const ds = tgt.displayState(displayTime);
      if (!ds) continue;
      const visibility = visibilityPolicy?.entity(tgt instanceof Player ? 'player' : 'ship', tgt === player);
      if (visibility && !visibility.pickable) continue;
      const role: MarkerRole =
        tgt === this.aliveTarget ? 'primary' : tgt === this.aliveSecondaryTarget ? 'secondary' : 'none';
      const item = tgt.markerItem(role, viewerPos, ds.r, ds.v, overviewMode);
      this.markerItemScratch.push(visibility ? {
        ...item,
        sym: visibility.icon ? item.sym : '',
        name: visibility.label ? item.name : '',
        detail: visibility.label ? item.detail : '',
      } : item);
    }
    this.markerManager.combatMarkers.sync(this.markerItemScratch, project, overviewMode, screenScale);
    if (player) {
      this.markerManager.leadMarkers.sync(
        player, this.aliveScratch, this.aliveTarget, this.aliveSecondaryTarget, simTime, overviewMode, project);
    }
  }

  // 第一・第二ターゲットのハイライト線を最新の状態に合わせる。
  private syncOrbitLine(
    fo: FloatingOrigin, player: Player | null, targets: readonly CombatTarget[], overviewMode: boolean,
    camera: THREE.Camera, attractors: readonly Attractor[], visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const tgt = this.aliveTarget;
    const secTgt = this.aliveSecondaryTarget;
    for (const t of targets) {
      const entityVisibility = visibilityPolicy?.entity(t instanceof Player ? 'player' : 'ship', t === player);
      const showGray = overviewMode && t.alive && t !== tgt && t !== secTgt && (entityVisibility?.orbit ?? true);
      t.syncOrbitLine(showGray, fo, camera, attractors);
    }

    const targetVisibility = tgt === null ? null : visibilityPolicy?.entity(tgt instanceof Player ? 'player' : 'ship', tgt === player);
    if (tgt && (targetVisibility?.orbit ?? true)) {
      const center = strongestAttractor(tgt.state.r, attractors);
      this.orbitLine.sync(tgt.orbitalElementsAround(center), fo, camera);
    } else {
      this.orbitLine.sync(null, fo, camera);
    }

    const secondaryVisibility = secTgt === null ? null : visibilityPolicy?.entity(secTgt instanceof Player ? 'player' : 'ship', secTgt === player);
    if (secTgt && (secondaryVisibility?.orbit ?? true)) {
      const center = strongestAttractor(secTgt.state.r, attractors);
      this.secondaryOrbitLine.sync(secTgt.orbitalElementsAround(center), fo, camera);
    } else {
      this.secondaryOrbitLine.sync(null, fo, camera);
    }
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  private syncBoardMarkers(project: ProjectFn): void {
    const target = this.aliveTarget;
    for (let i = 0; i < C.MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !target) {
        this.markerManager.hide(key);
        continue;
      }
      const fade = 1 - m.age / C.BOARD_MARK_LIFETIME;
      this.markerManager.setPosition(key, 'mk-boardpass', '✦', add(target.state.r, m.off), project, '', 0.25 + 0.75 * fade);
    }
  }

  // ターゲット/その反対方向を指す方向マーカー(戦闘ビューのみ)。自機の軌道基準方向マーカー
  // (player-markers.ts)と同じ扱いで、自機位置を原点に置く。第一ターゲットのみ。
  private syncTargetDirMarkers(player: Player | null, overviewMode: boolean, project: ProjectFn): void {
    const tgt = this.aliveTarget;
    if (overviewMode || !tgt || !player) {
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
      return;
    }
    const tgtDir = norm(sub(tgt.state.r, player.state.r));
    this.markerManager.setDirection('tgtdir', 'mk-tgtdir', DIRECTION_GLYPH.target, player.state.r, tgtDir, project);
    this.markerManager.setDirection('atgdir', 'mk-tgtdir', DIRECTION_GLYPH.antiTarget, player.state.r, scale(tgtDir, -1), project);
  }

  // 戦闘ビューの右クリックは射撃と兼用。移動量が閾値内(input.ts が判定済み)の
  // 右クリックが敵に当たった場合だけ、その敵を対象にコンテキストメニューを開く。
  // 外れたクリックは消費するだけで何もしない(自動選定・自動解除は行わない)。
  private handleTargetContextMenu(input: Input, targets: CombatTarget[], player: Player, project: ProjectFn): void {
    if (!player.alive) return;
    input.takeRightClicks((click) => {
      const picked = this.pickTargetAt(click, targets, project);
      if (picked) this.openMenu(click, picked);
      else this.emptySpaceMenu.open(click.x, click.y, true, [
        { label: '設定メニューを開く', act: 'openSettings' },
        MenuCommon.cancel(),
      ]);
      return true;
    });
  }

  // クリック位置の許容半径内で画面上最も近い生存ターゲットを返す。範囲外なら null。
  private pickTargetAt(click: PointerPoint, targets: CombatTarget[], project: ProjectFn): CombatTarget | null {
    const pickables = targets.filter((e) => e.alive).map((target) => ({ pos: target.state.r, target }));
    const picked = pickNearest(pickables, click.x, click.y, project, C.TARGET_LOCK_PICK_PX_SQ);
    return picked?.target ?? null;
  }

  // picked を対象に、現在の第一/第二設定に応じたラベルでメニューを開く。
  private openMenu(click: PointerPoint, picked: CombatTarget): void {
    const items: MenuItem[] = [
      { label: picked === this.target ? 'ターゲット解除' : 'ターゲットに設定', act: 'primary' },
      { label: picked === this.secondaryTarget ? '第二ターゲット解除' : '第二ターゲットに設定', act: 'secondary' },
      { label: 'キャンセル', act: 'cancel' },
    ];
    this.contextMenu.open(click.x, click.y, picked, items);
  }

  // 第一ターゲットを設定する。同じ個体が第二ターゲットなら外す(両方兼務を禁止)。
  private setTarget(t: CombatTarget | null): void {
    if (t && this.secondaryTarget === t) this.secondaryTarget = null;
    this.target = t;
    this._hud.hint(t ? `ターゲット固定: ${t.name}` : 'ターゲット固定解除');
  }

  // 第二ターゲットを設定する。同じ個体が第一ターゲットなら外す(両方兼務を禁止)。
  private setSecondaryTarget(t: CombatTarget | null): void {
    if (t && this.target === t) this.target = null;
    this.secondaryTarget = t;
    this._hud.hint(t ? `第二ターゲット固定: ${t.name}` : '第二ターゲット固定解除');
  }
}
