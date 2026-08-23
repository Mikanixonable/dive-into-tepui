// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決める。
// update が出す/消す/スタイルを決め、sync は既に出ている線の形状と変換を合わせる。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../physics/ephemeris';
import type { FrameAnchorSource } from '../physics/frame';
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
    activePlayer: Player | null, primaryTarget: CombatTarget | null,
    overviewMode: boolean, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const { pastDuration } = displayWindow;
    const palette = currentThemePalette();
    const primaryStyle: LineStyle = { color: palette.secondary, opacity: TARGET_LINE_OPACITY, renderOrder: C.LINE_RENDER_ORDER.target };
    const targetStyleOf = (e: CombatTarget): LineStyle | null => e === primaryTarget ? primaryStyle : null;
    const playerOrbitStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : C.COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: C.LINE_RENDER_ORDER.shipOrbit }
    );
    const playerPredictedStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : C.COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: C.LINE_RENDER_ORDER.predicted }
    );
    const playerActualStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : C.COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.3, renderOrder: C.LINE_RENDER_ORDER.predicted }
    );

    for (const ship of this.entities.players) {
      const isActive = ship === activePlayer;
      const visibility = visibilityPolicy?.entity('player', isActive);
      const categoryVisible = visibility?.category ?? true;
      const orbitVisible = visibility?.orbit ?? true;
      const asTarget = targetStyleOf(ship);
      // マップビューでは操作艦だけが既定で予測線・過去線を使う。それ以外の自艦は、
      // プロパティウィンドウのトグル(showTrajectoryLine)がONのときだけ同様に使う。
      const trajectoryEligible = isActive || (overviewMode && ship.showTrajectoryLine);
      // クラス自体が表示対象外なら線も出さない。クラスは表示中だがマップの軌道線
      // トグルだけがOFFの場合は、予測線・過去線ではなく解析楕円へフォールバックする。
      const showLines = trajectoryEligible && categoryVisible && orbitVisible && asTarget === null;
      // 戦闘ビューの操作艦は、積分した予測線ではなく解析楕円で軌道を描く。
      const ownEllipse = showLines && !overviewMode;
      const fallbackEllipse = !trajectoryEligible && overviewMode && categoryVisible && asTarget === null;
      const orbitToggleFallback = overviewMode && categoryVisible && !orbitVisible;
      if (asTarget !== null && categoryVisible) ship.showOrbitLine(asTarget);
      else if (ownEllipse || fallbackEllipse || orbitToggleFallback) ship.showOrbitLine(playerOrbitStyleOf(isActive));
      else ship.hideOrbitLine();
      if (showLines && !ownEllipse) ship.showPredictedLine(playerPredictedStyleOf(isActive));
      else ship.hidePredictedLine();
      if (showLines && pastDuration > 0) ship.showActualLine(playerActualStyleOf(isActive));
      else ship.hideActualLine();
    }
    for (const enemy of this.entities.enemies) {
      const asTarget = targetStyleOf(enemy);
      const visibility = visibilityPolicy?.entity('ship');
      const categoryVisible = visibility?.category ?? true;
      const orbitVisible = visibility?.orbit ?? true;
      // クラスが表示対象ならターゲットはビューを問わず出す。ターゲットは常に解析楕円のまま
      // (強調色を保つため)、それ以外はマップの軌道線トグルがONで個別トグルもONなら予測線・
      // 過去線に切り替える。軌道線トグルがOFFなら解析楕円へフォールバックする。
      const show = asTarget !== null ? categoryVisible : overviewMode && enemy.alive && categoryVisible;
      const useTrajectory = show && asTarget === null && overviewMode && enemy.showTrajectoryLine && orbitVisible;
      const enemyLineStyle: LineStyle = { ...C.LINE_STYLE.enemyOrbit, color: enemy.orbitLineColor };
      if (show && !useTrajectory) enemy.showOrbitLine(asTarget ?? enemyLineStyle);
      else enemy.hideOrbitLine();
      if (useTrajectory) enemy.showPredictedLine(enemyLineStyle);
      else enemy.hidePredictedLine();
      if (useTrajectory && pastDuration > 0) enemy.showActualLine(enemyLineStyle);
      else enemy.hideActualLine();
    }
    for (const base of this.entities.bases) {
      const show = overviewMode && (visibilityPolicy?.entity('base').orbit ?? false);
      const useTrajectory = show && base.showTrajectoryLine;
      if (show && !useTrajectory) base.showOrbitLine(C.LINE_STYLE.baseOrbit);
      else base.hideOrbitLine();
      if (useTrajectory) base.showPredictedLine(C.LINE_STYLE.baseOrbit);
      else base.hidePredictedLine();
      if (useTrajectory && pastDuration > 0) base.showActualLine(C.LINE_STYLE.baseOrbit);
      else base.hideActualLine();
    }
  }

  // 既に出ている線の形状と変換を合わせる。どの線を持つかは update が決めきっているので、
  // ここでは全個体へ一律に呼ぶ。
  sync(
    displayWindow: DisplayWindow, fo: FloatingOrigin, camera: THREE.Camera,
    frameAnchors: FrameAnchorSource, ephemeris: Ephemeris,
  ): void {
    const { frame, simTime, displayTime, duration, pastDuration } = displayWindow;
    for (const ship of this.entities.players) {
      const predictedTo = ship.predictionTruncated ? null : simTime + duration;
      ship.syncTrajectoryLines(
        frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, frameAnchors);
      // 噴射中は軌道要素が動き続けるので、閾値を待たずに焼き直す。
      ship.syncOrbitLine(fo, camera, frameAnchors, ship.thrust !== null, displayTime, ephemeris);
    }
    for (const enemy of this.entities.enemies) {
      const predictedTo = enemy.predictionTruncated ? null : simTime + duration;
      enemy.syncTrajectoryLines(
        frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, frameAnchors);
      enemy.syncOrbitLine(fo, camera, frameAnchors, enemy.thrust !== null, displayTime, ephemeris);
    }
    for (const base of this.entities.bases) {
      const predictedTo = base.predictionTruncated ? null : simTime + duration;
      base.syncTrajectoryLines(
        frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, frameAnchors);
      base.syncOrbitLine(fo, camera, frameAnchors, base.thrust !== null, displayTime, ephemeris);
    }
  }
}
