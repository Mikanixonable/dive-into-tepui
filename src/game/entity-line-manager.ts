// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決める。
// update が出す/消す/スタイルを決め、sync は既に出ている線の形状と変換を合わせる。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../physics/ephemeris';
import type { FrameAnchorSource } from '../physics/frame';
import { LINE_RENDER_ORDER, type LineStyle } from '../render/line-style';
import * as C from './const';
import { FloatingOrigin } from './floating-origin';
import { Player } from './player/player';
import { currentThemePalette } from './theme';
import type { CombatTarget } from './targeter';
import type { EntityManager } from './simulation/entity-manager';
import type { DisplayWindow } from './display-window-manager';
import type { MapVisibilityPolicy } from './celestial/map-visibility';
import type { GameEntity } from './game-entity/game-entity';

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
    const primaryStyle: LineStyle = { color: palette.signal, opacity: TARGET_LINE_OPACITY, renderOrder: LINE_RENDER_ORDER.target };
    const targetStyleOf = (e: CombatTarget): LineStyle | null => e === primaryTarget ? primaryStyle : null;
    const playerOrbitStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : C.COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: LINE_RENDER_ORDER.shipOrbit }
    );
    const playerPredictedStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : C.COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: LINE_RENDER_ORDER.predicted }
    );
    const playerActualStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : C.COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.3, renderOrder: LINE_RENDER_ORDER.predicted }
    );
    // 1体分の判定材料から、解析楕円/予測線/過去線の出す/消す/スタイルを決める。ターゲットである間は
    // 常に asTarget のスタイルで解析楕円を維持し、予測線・過去線には切り替えない。lineVisible は
    // ターゲット強調時にも及ぶ表示可否、visibleWhenUntargeted はそれに加えてターゲットでないときだけ
    // 課される表示可否(敵の生存判定など)を表す。
    const applyEntityLines = (
      entity: GameEntity, asTarget: LineStyle | null, lineVisible: boolean, visibleWhenUntargeted: boolean,
      trajectoryEligible: boolean, ellipseStyle: LineStyle, predictedStyle: LineStyle, actualStyle: LineStyle,
    ): void => {
      const showLines = trajectoryEligible && visibleWhenUntargeted && asTarget === null;
      const ownEllipse = showLines && !overviewMode;
      const fallbackEllipse = !trajectoryEligible && overviewMode && visibleWhenUntargeted && asTarget === null;
      if (asTarget !== null && lineVisible) entity.showOrbitLine(asTarget);
      else if (ownEllipse || fallbackEllipse) entity.showOrbitLine(ellipseStyle);
      else entity.hideOrbitLine();
      if (showLines && !ownEllipse) entity.showPredictedLine(predictedStyle);
      else entity.hidePredictedLine();
      if (showLines && pastDuration > 0) entity.showActualLine(actualStyle);
      else entity.hideActualLine();
    };

    for (const ship of this.entities.players) {
      const isActive = ship === activePlayer;
      const visibility = visibilityPolicy?.entity('player', isActive);
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      // マップビューでは操作艦だけが既定で予測線・過去線を使う。それ以外の自艦は、
      // プロパティウィンドウのトグル(showTrajectoryLine)がONのときだけ同様に使う。
      const trajectoryEligible = isActive || (overviewMode && ship.showTrajectoryLine);
      applyEntityLines(
        ship, targetStyleOf(ship), lineVisible, lineVisible, trajectoryEligible,
        playerOrbitStyleOf(isActive), playerPredictedStyleOf(isActive), playerActualStyleOf(isActive),
      );
    }
    for (const enemy of this.entities.enemies) {
      const visibility = visibilityPolicy?.entity('ship');
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      const enemyLineStyle: LineStyle = { ...C.LINE_STYLE.enemyOrbit, color: enemy.orbitLineColor };
      applyEntityLines(
        enemy, targetStyleOf(enemy), lineVisible, lineVisible && enemy.alive, overviewMode && enemy.showTrajectoryLine,
        enemyLineStyle, enemyLineStyle, enemyLineStyle,
      );
    }
    for (const base of this.entities.bases) {
      const lineVisible = visibilityPolicy?.entity('base').orbit ?? false;
      applyEntityLines(
        base, targetStyleOf(base), lineVisible, lineVisible, overviewMode && base.showTrajectoryLine,
        C.LINE_STYLE.baseOrbit, C.LINE_STYLE.baseOrbit, C.LINE_STYLE.baseOrbit,
      );
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
      ship.syncOrbitLine(fo, camera, { frameAnchors, displayTime, ephemeris, force: ship.thrust !== null });
    }
    for (const enemy of this.entities.enemies) {
      const predictedTo = enemy.predictionTruncated ? null : simTime + duration;
      enemy.syncTrajectoryLines(
        frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, frameAnchors);
      enemy.syncOrbitLine(fo, camera, { frameAnchors, displayTime, ephemeris, force: enemy.thrust !== null });
    }
    for (const base of this.entities.bases) {
      const predictedTo = base.predictionTruncated ? null : simTime + duration;
      base.syncTrajectoryLines(
        frame, simTime, displayTime, pastDuration, predictedTo, ephemeris, fo, camera, frameAnchors);
      base.syncOrbitLine(fo, camera, { frameAnchors, displayTime, ephemeris, force: base.thrust !== null });
    }
  }
}
