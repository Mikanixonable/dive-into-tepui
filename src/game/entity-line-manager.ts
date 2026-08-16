// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決める。
// update が出す/消す/スタイルを決め、sync は既に出ている線の形状と変換を合わせる。
import * as THREE from 'three/webgpu';
import { Attractor } from '../physics/attractor';
import { Ephemeris } from '../physics/ephemeris';
import type { LineStyle } from '../render/line-style';
import * as C from './const';
import { FloatingOrigin } from './floating-origin';
import { Player } from './player/player';
import { currentThemePalette } from './theme';
import type { CombatTarget } from './targeter';
import type { EntityManager } from './simulation/entity-manager';
import type { DisplayWindow } from './display-window-manager';
import type { MapVisibilityPolicy } from './celestial/map-visibility';

// ターゲットの軌道はほぼ自機の軌道と重なることが多く(近傍ランデブーを狙うため)、
// 埋もれて見えなくならないよう不透明度を上げる。
const TARGET_LINE_OPACITY = 0.9;

export class EntityLineManager {
  constructor(private readonly entities: EntityManager) {}

  // 出す/消す/スタイルを決める。判断材料(表示可否・ターゲット・操作艦・ビュー)が
  // このフレームの確定値になった後に呼ぶ。
  update(
    activePlayer: Player | null, primaryTarget: CombatTarget | null, secondaryTarget: CombatTarget | null,
    overviewMode: boolean, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const { pastDuration } = displayWindow;
    const palette = currentThemePalette();
    const primaryStyle: LineStyle = { color: palette.accent, opacity: TARGET_LINE_OPACITY, renderOrder: C.LINE_RENDER_ORDER.target };
    const secondaryStyle: LineStyle = { color: palette.secondary, opacity: TARGET_LINE_OPACITY, renderOrder: C.LINE_RENDER_ORDER.secondaryTarget };
    const targetStyleOf = (e: CombatTarget): LineStyle | null =>
      e === primaryTarget ? primaryStyle : e === secondaryTarget ? secondaryStyle : null;

    for (const ship of this.entities.players) {
      const isActive = ship === activePlayer;
      const visible = visibilityPolicy?.entity('player', isActive).orbit ?? true;
      const asTarget = targetStyleOf(ship);
      const showLines = (isActive || overviewMode) && visible && asTarget === null;
      // 戦闘ビューの操作艦は、積分した予測線ではなく解析楕円で軌道を描く。
      const ownEllipse = showLines && !overviewMode;
      if (asTarget !== null && visible) ship.showOrbitLine(asTarget);
      else if (ownEllipse) ship.showOrbitLine(C.LINE_STYLE.playerOrbit);
      else ship.hideOrbitLine();
      if (showLines && !ownEllipse) ship.showPredictedLine(C.LINE_STYLE.playerPredicted);
      else ship.hidePredictedLine();
      if (showLines && pastDuration > 0) ship.showActualLine(C.LINE_STYLE.playerActual);
      else ship.hideActualLine();
    }
    for (const enemy of this.entities.enemies) {
      const asTarget = targetStyleOf(enemy);
      const orbit = visibilityPolicy?.entity('ship').orbit;
      // ターゲットはビューを問わず出し、可視性の既定も通常の線(false)と逆向き(true)。
      const show = asTarget !== null ? (orbit ?? true) : overviewMode && enemy.alive && (orbit ?? false);
      if (show) enemy.showOrbitLine(asTarget ?? { ...C.LINE_STYLE.enemyOrbit, color: enemy.orbitLineColor });
      else enemy.hideOrbitLine();
    }
    for (const base of this.entities.bases) {
      const show = overviewMode && (visibilityPolicy?.entity('base').orbit ?? false);
      if (show) base.showOrbitLine(C.LINE_STYLE.baseOrbit);
      else base.hideOrbitLine();
    }
  }

  // 既に出ている線の形状と変換を合わせる。どの線を持つかは update が決めきっているので、
  // ここでは全個体へ一律に呼ぶ。
  sync(
    displayWindow: DisplayWindow, fo: FloatingOrigin, camera: THREE.Camera,
    attractors: readonly Attractor[], ephemeris: Ephemeris,
  ): void {
    const { frame, simTime, displayTime, duration, pastDuration } = displayWindow;
    for (const ship of this.entities.players) {
      const predictedTo = ship.predictionTruncated ? null : simTime + duration;
      ship.syncTrajectoryLines(
        frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, attractors);
      // 噴射中は軌道要素が動き続けるので、閾値を待たずに焼き直す。
      ship.syncOrbitLine(fo, camera, attractors, ship.thrust !== null, frame, displayTime, ephemeris);
    }
    for (const enemy of this.entities.enemies) {
      enemy.syncOrbitLine(fo, camera, attractors, enemy.thrust !== null, frame, displayTime, ephemeris);
    }
    for (const base of this.entities.bases) {
      base.syncOrbitLine(fo, camera, attractors, base.thrust !== null, frame, displayTime, ephemeris);
    }
  }
}
