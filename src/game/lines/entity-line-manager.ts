// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決め、出ている線の
// 形状と変換を合わせる。
import * as THREE from 'three/webgpu';
import type { View } from '../view/view';
import type { FrameAnchorSource } from '../../physics/frame';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import { FloatingOrigin } from '../camera/floating-origin';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { isBase } from '../dynamic/dynamic-entity/base';
import { isPlayer } from '../player/player';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { currentThemePalette } from '../../theme';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { DisplayWindow } from '../display-window-manager';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import { orbitLineBasisOf, type OrbitReference } from '../orbit-reference';
import { COLOR_BASE } from '../marker/marker-identity';
import type { CelestialBodies } from '../celestial/celestial-bodies';

export const COLOR_ENEMY_ORBIT_LINE = '#565b63';
const COLOR_PLAYER_ORBIT_LINE_INACTIVE = '#ffffff'; // マップビューで操作対象でない自艦の軌道線

// 役割ごとの軌道線の見た目(色・不透明度・描画順)を一括して決める表。
const LINE_STYLE = {
  enemyLine: { color: COLOR_ENEMY_ORBIT_LINE, opacity: 0.35, renderOrder: LINE_RENDER_ORDER.shipOrbit },
  baseLine: { color: COLOR_BASE, opacity: 0.35, renderOrder: LINE_RENDER_ORDER.shipOrbit },
} as const satisfies Record<string, LineStyle>;

// ターゲットの軌道は自機の軌道とほぼ重なりがちなので、埋もれないよう不透明度を上げる。
const TARGET_LINE_OPACITY = 0.9;

// 解析楕円・予測線・過去線それぞれの見た目。
interface TrajectoryStyles {
  readonly ellipse: LineStyle;
  readonly predicted: LineStyle;
  readonly actual: LineStyle;
}

// 3種の線を同じ見た目にする。
function sameTrajectoryStyle(style: LineStyle): TrajectoryStyles {
  return { ellipse: style, predicted: style, actual: style };
}

// 軌道線を出す/消す。style が null なら出さない。出す場合にどの基準で描くかは orbitRef が決める。
function applyOrbitLine(
  entity: DynamicEntity, style: LineStyle | null, orbitRef: OrbitReference | undefined,
): void {
  if (style === null) {
    entity.hideOrbitLine();
    return;
  }
  const basis = orbitLineBasisOf(orbitRef, entity);
  switch (basis.kind) {
    case 'ellipse': entity.showEllipseLine(style, basis.center); break;
    case 'relative': entity.showTargetRelativeLine(style, basis.target); break;
    case 'none': entity.hideOrbitLine(); break;
  }
}

export class EntityLineManager {
  constructor(private readonly dynamicSystem: DynamicSystem) {}

  // 出す/消す/スタイルを決める。
  private applyLines(
    active: Controllable | null, primaryTarget: CombatTarget | null,
    view: View, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
    orbitRef: OrbitReference | undefined,
  ): void {
    const { pastDuration } = displayWindow;
    // マップビューは軌道情報パネルの固定設定に従わず、常に自動選択(最も強く引く天体)で描く
    // (ORBIT.md「軌道線(3D描画)の基準天体」)。
    const lineOrbitRef = view === 'map' ? undefined : orbitRef;
    const palette = currentThemePalette();
    const primaryStyle: LineStyle = { color: palette.signal, opacity: TARGET_LINE_OPACITY, renderOrder: LINE_RENDER_ORDER.target };
    const targetStyleOf = (e: CombatTarget): LineStyle | null => e === primaryTarget ? primaryStyle : null;
    const playerOrbitStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: LINE_RENDER_ORDER.shipOrbit }
    );
    const playerPredictedStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.55, renderOrder: LINE_RENDER_ORDER.predicted }
    );
    const playerActualStyleOf = (isActive: boolean): LineStyle => (
      { color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE, opacity: 0.3, renderOrder: LINE_RENDER_ORDER.predicted }
    );
    // 1体分の判定材料から、軌道線/予測線/過去線の出す/消す/スタイルを決める。lineVisible は
    // ターゲット強調時にも及ぶ表示可否、visibleWhenUntargeted はターゲットでないときにだけ
    // 課される表示可否(敵の生存判定など)。
    const applyEntityLines = (
      entity: DynamicEntity, asTarget: LineStyle | null, lineVisible: boolean, visibleWhenUntargeted: boolean,
      trajectoryEligible: boolean, styles: TrajectoryStyles,
    ): void => {
      // 予測線・過去線を使う条件が揃っているか。
      const showLines = trajectoryEligible && visibleWhenUntargeted && asTarget === null;
      // 戦闘ビューの自艦・使用条件を満たさない機体は、積分線の代わりに解析楕円で描く。
      const ownEllipse = showLines && view !== 'map';
      const fallbackEllipse = !trajectoryEligible && view === 'map' && visibleWhenUntargeted && asTarget === null;
      const orbitLineStyle = asTarget !== null && lineVisible
        ? asTarget
        : (ownEllipse || fallbackEllipse ? styles.ellipse : null);
      applyOrbitLine(entity, orbitLineStyle, lineOrbitRef);
      if (showLines && !ownEllipse) entity.showPredictedLine(styles.predicted);
      else entity.hidePredictedLine();
      if (showLines && pastDuration > 0) entity.showActualLine(styles.actual);
      else entity.hideActualLine();
    };

    for (const ship of this.dynamicSystem.all().filter(isPlayer)) {
      const isActive = ship === active;
      const visibility = visibilityPolicy?.entity('player', isActive);
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      const trajectoryEligible = isActive || (view === 'map' && ship.showTrajectoryLine);
      applyEntityLines(
        ship, targetStyleOf(ship), lineVisible, lineVisible, trajectoryEligible,
        { ellipse: playerOrbitStyleOf(isActive), predicted: playerPredictedStyleOf(isActive), actual: playerActualStyleOf(isActive) },
      );
    }
    for (const enemy of this.dynamicSystem.all().filter(isEnemy)) {
      const visibility = visibilityPolicy?.entity('enemy');
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      const enemyLineStyle: LineStyle = { ...LINE_STYLE.enemyLine, color: enemy.orbitLineColor };
      applyEntityLines(
        enemy, targetStyleOf(enemy), lineVisible, lineVisible && enemy.alive, view === 'map' && enemy.showTrajectoryLine,
        sameTrajectoryStyle(enemyLineStyle),
      );
    }
    for (const base of this.dynamicSystem.all().filter(isBase)) {
      const visibility = visibilityPolicy?.entity('base');
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      applyEntityLines(
        base, targetStyleOf(base), lineVisible, lineVisible, view === 'map' && base.showTrajectoryLine,
        sameTrajectoryStyle(LINE_STYLE.baseLine),
      );
    }
  }

  // 各個体が持つべき線を揃えてから、その形状と変換をこのフレームの表示状態へ合わせる。
  // 判断材料(表示可否・ターゲット・操作対象・ビュー)はこのフレームの確定値を渡す。
  sync(
    active: Controllable | null, primaryTarget: CombatTarget | null,
    view: View, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
    orbitRef: OrbitReference | undefined,
    fo: FloatingOrigin, camera: THREE.Camera,
    frameAnchors: FrameAnchorSource, celestialBodies: CelestialBodies,
  ): void {
    this.applyLines(active, primaryTarget, view, displayWindow, visibilityPolicy, orbitRef);
    const { frame, simTime, displayTime, duration, pastDuration } = displayWindow;
    for (const group of this.lineOwners) {
      for (const entity of group) {
        // 予測が伸びきっていないフレームでは終端時刻を渡さず、届いたところまでで描かせる。
        const predictedTo = entity.predictionTruncated ? null : simTime + duration;
        entity.syncTrajectoryLines(
          frame, simTime, displayTime, pastDuration, predictedTo, celestialBodies, fo, camera, frameAnchors);
        entity.syncOrbitLine(displayTime, celestialBodies, fo, camera, frameAnchors);
      }
    }
  }

  // 線を持ちうるエンティティ。
  private get lineOwners(): readonly (readonly DynamicEntity[])[] {
    const entities = this.dynamicSystem.all();
    return [entities.filter(isPlayer), entities.filter(isEnemy), entities.filter(isBase)];
  }
}
