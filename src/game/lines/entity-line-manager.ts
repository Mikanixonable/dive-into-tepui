// どのエンティティに、どんな見た目の軌道線・予測線・過去線を出すかを決め、View へ渡す。
import * as THREE from 'three/webgpu';
import type { View } from '../view/view';
import type { FrameAnchorSource } from '../../physics/frame';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import { FloatingOrigin } from '../camera/floating-origin';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicLineDisplay } from '../../render/dynamic/dynamic-view';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { isBase } from '../dynamic/dynamic-entity/base';
import { isPlayer } from '../player/player';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { currentThemePalette } from '../../theme';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { EntityRoster } from '../dynamic/entity-roster';
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

// 軌道基準の種別を、View がそのまま同期できる宣言へ変換する。
function orbitDisplay(
  entity: DynamicEntity, style: LineStyle | null, orbitRef: OrbitReference | undefined,
): DynamicLineDisplay['orbit'] {
  if (style === null) return null;
  const basis = orbitLineBasisOf(orbitRef, entity);
  switch (basis.kind) {
    case 'ellipse': return { kind: 'ellipse', style, center: basis.center };
    case 'relative': return { kind: 'relative', style, target: basis.target.motion };
    case 'none': return null;
  }
}

export class EntityLineManager {
  constructor(private readonly roster: EntityRoster) {}

  // 次回の予測更新が必要な個体を update フェーズで確定する。
  updatePredictionReaders(
    active: Controllable | null, primaryTarget: CombatTarget | null,
    view: View, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    this.forEachDisplay(
      active, primaryTarget, view, displayWindow, visibilityPolicy, undefined,
      (entity, display) => { entity.motion.trajectoryReader = display.predicted !== null; },
    );
  }

  // 各個体の線表示をこのフレームの確定状態から宣言し、View に一括同期させる。
  sync(
    active: Controllable | null, primaryTarget: CombatTarget | null,
    view: View, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
    orbitRef: OrbitReference | undefined,
    fo: FloatingOrigin, camera: THREE.Camera,
    frameAnchors: FrameAnchorSource, celestialBodies: CelestialBodies,
  ): void {
    const { frame, simTime, displayTime, duration, pastDuration } = displayWindow;
    this.forEachDisplay(
      active, primaryTarget, view, displayWindow, visibilityPolicy, orbitRef,
      (entity, display) => {
        // 予測が伸びきっていないフレームでは終端時刻を渡さず、届いたところまでで描かせる。
        const predictedTo = entity.motion.predictionTruncated ? null : simTime + duration;
        entity.view.syncLines(
          display, entity.motion, frame, simTime, displayTime, pastDuration, predictedTo,
          celestialBodies, fo, camera, frameAnchors,
        );
      },
    );
  }

  // 1フレーム分の表示判断を各対象へ配る。View にはこの結果だけを渡し、設定の正本を置かない。
  private forEachDisplay(
    active: Controllable | null, primaryTarget: CombatTarget | null,
    view: View, displayWindow: DisplayWindow, visibilityPolicy: MapVisibilityPolicy | null,
    orbitRef: OrbitReference | undefined,
    accept: (entity: DynamicEntity, display: DynamicLineDisplay) => void,
  ): void {
    const { pastDuration } = displayWindow;
    // マップビューは軌道情報パネルの固定設定に従わず、常に自動選択(最も強く引く天体)で描く。
    const lineOrbitRef = view === 'map' ? undefined : orbitRef;
    const palette = currentThemePalette();
    const primaryStyle: LineStyle = {
      color: palette.signal, opacity: TARGET_LINE_OPACITY, renderOrder: LINE_RENDER_ORDER.target,
    };
    const targetStyleOf = (entity: CombatTarget): LineStyle | null => (
      entity === primaryTarget ? primaryStyle : null
    );
    const playerOrbitStyleOf = (isActive: boolean): LineStyle => ({
      color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE,
      opacity: 0.55,
      renderOrder: LINE_RENDER_ORDER.shipOrbit,
    });
    const playerPredictedStyleOf = (isActive: boolean): LineStyle => ({
      color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE,
      opacity: 0.55,
      renderOrder: LINE_RENDER_ORDER.predicted,
    });
    const playerActualStyleOf = (isActive: boolean): LineStyle => ({
      color: isActive ? palette.accent : COLOR_PLAYER_ORBIT_LINE_INACTIVE,
      opacity: 0.3,
      renderOrder: LINE_RENDER_ORDER.predicted,
    });
    // 1個体の判定材料を、View へ渡す完全な線表示宣言へ変換する。
    const resolve = (
      entity: DynamicEntity, asTarget: LineStyle | null, lineVisible: boolean,
      trajectoryEligible: boolean, styles: TrajectoryStyles,
    ): void => {
      // 生存・カテゴリ可視性・表示設定・ターゲット強調を、3本の宣言へ畳み込む。
      const available = entity.motion.alive && lineVisible;
      const showTrajectories = trajectoryEligible && available && asTarget === null;
      const ownEllipse = showTrajectories && view !== 'map';
      const fallbackEllipse = !trajectoryEligible && view === 'map' && available && asTarget === null;
      const orbitStyle = asTarget !== null && available
        ? asTarget
        : (ownEllipse || fallbackEllipse ? styles.ellipse : null);
      accept(entity, {
        orbit: orbitDisplay(entity, orbitStyle, lineOrbitRef),
        predicted: showTrajectories && !ownEllipse ? styles.predicted : null,
        actual: showTrajectories && pastDuration > 0 ? styles.actual : null,
      });
    };

    // 種別ごとの差は色と表示設定だけに留め、最終判断は同じ resolve を通す。
    for (const ship of this.roster.all().filter(isPlayer)) {
      const isActive = ship === active;
      const visibility = visibilityPolicy?.entity('player', isActive);
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      resolve(
        ship, targetStyleOf(ship), lineVisible,
        isActive || (view === 'map' && ship.trajectoryLineVisible),
        {
          ellipse: playerOrbitStyleOf(isActive),
          predicted: playerPredictedStyleOf(isActive),
          actual: playerActualStyleOf(isActive),
        },
      );
    }
    for (const enemy of this.roster.all().filter(isEnemy)) {
      const visibility = visibilityPolicy?.entity('enemy');
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      const enemyLineStyle: LineStyle = { ...LINE_STYLE.enemyLine, color: enemy.orbitLineColor };
      resolve(
        enemy, targetStyleOf(enemy), lineVisible,
        view === 'map' && enemy.trajectoryLineVisible,
        sameTrajectoryStyle(enemyLineStyle),
      );
    }
    for (const base of this.roster.all().filter(isBase)) {
      const visibility = visibilityPolicy?.entity('base');
      const lineVisible = (visibility?.category ?? true) && (visibility?.orbit ?? true);
      resolve(
        base, targetStyleOf(base), lineVisible,
        view === 'map' && base.trajectoryLineVisible,
        sameTrajectoryStyle(LINE_STYLE.baseLine),
      );
    }
  }
}
