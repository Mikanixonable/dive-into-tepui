// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決める。
// update が出す/消す/スタイルを決め、sync は既に出ている線の形状と変換を合わせる。
import * as THREE from 'three/webgpu';
import { Attractor } from '../physics/attractor';
import { Ephemeris } from '../physics/ephemeris';
import * as C from './const';
import { FloatingOrigin } from './floating-origin';
import { Player } from './player/player';
import type { CombatTarget } from './targeter';
import type { EntityManager } from './simulation/entity-manager';
import type { DisplayWindow } from './display-window-manager';
import type { MapVisibilityPolicy } from './celestial/map-visibility';

export class EntityLineManager {
  constructor(private readonly entities: EntityManager) {}

  // 出す/消す/スタイルを決める。判断材料(表示可否・ターゲット・操作艦・ビュー)が
  // このフレームの確定値になった後に呼ぶ。
  update(
    activePlayer: Player | null, primaryTarget: CombatTarget | null, secondaryTarget: CombatTarget | null,
    overviewMode: boolean, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const { pastDuration } = displayWindow;
    for (const ship of this.entities.players) {
      const isActive = ship === activePlayer;
      const show = (isActive || overviewMode)
        && (visibilityPolicy?.entity('player', isActive).orbit ?? true)
        && ship !== primaryTarget && ship !== secondaryTarget;
      if (show) ship.showPredictedLine(C.LINE_STYLE.playerPredicted);
      else ship.hidePredictedLine();
      if (show && pastDuration > 0) ship.showActualLine(C.LINE_STYLE.playerActual);
      else ship.hideActualLine();
    }
    for (const enemy of this.entities.enemies) {
      const show = overviewMode && enemy.alive && (visibilityPolicy?.entity('ship').orbit ?? false)
        && enemy !== primaryTarget && enemy !== secondaryTarget;
      if (show) enemy.showOrbitLine({ ...C.LINE_STYLE.enemyOrbit, color: enemy.orbitLineColor });
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
    }
    for (const enemy of this.entities.enemies) {
      enemy.syncOrbitLine(fo, camera, attractors, false, frame, displayTime, ephemeris);
    }
    for (const base of this.entities.bases) {
      base.syncOrbitLine(fo, camera, attractors, false, frame, displayTime, ephemeris);
    }
  }
}
