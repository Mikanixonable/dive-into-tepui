// 軌道分析パネルの投影タブ: 背景テクスチャの読み込み/キャッシュと、操作対象・ターゲットの
// 経緯度点列(orbit-analysis-data.ts)を OrbitProjectionChart へ渡すことだけを持つ。
import { CelestialBody, strongestAttractor } from '../../../physics/celestial-body';
import type { Game } from '../../game';
import type { GameEntity } from '../../game-entity/game-entity';
import { entityStateAt } from '../../simulation/entity-state-at';
import { EARTH_TEXTURES, textureOf } from '../../../render/celestial-textures';
import { ACCENT, ACCENT_SECONDARY } from '../../theme';
import { ApproachTargetSource, projectionSeries, resolveTarget } from './orbit-analysis-data';
import { OrbitProjectionChart, ProjectionChartSpec, ProjectionSeriesSpec } from './orbit-projection-chart';

// id の天体が持つ円筒図法テクスチャの URL。実写テクスチャが無い天体(単色球扱い)は投影タブを
// 出せないので null。地球は地表+雲を合成する専用テクスチャ(EARTH_TEXTURES)を持つため別扱い。
export function projectionTextureUrl(id: string): string | null {
  if (id === 'earth') return EARTH_TEXTURES.surfaceUrl;
  return textureOf(id)?.url ?? null;
}

export class OrbitProjectionTab {
  public readonly chart = new OrbitProjectionChart();
  // 背景画像。URL ごとに読み込み、読み込み完了まではその天体を背景無し(空メッセージ)で描く。
  private readonly textureImages = new Map<string, HTMLImageElement>();

  public dispose(): void {
    this.chart.dispose();
  }

  // 中心天体 center の反対側(遠地点付近)を通る軌道でも見失わないよう高度タブと同じ
  // サンプル数を使い、期間 spanSec はマップの未来表示(軌道予測パネル)が指す期間をそのまま使う。
  public draw(
    game: Game, entity: GameEntity, center: CelestialBody, approachSource: ApproachTargetSource | null,
    celestialBodies: readonly CelestialBody[], now: number, spanSec: number, sampleCount: number, textureUrl: string,
  ): void {
    const ship = projectionSeries(
      (t) => entityStateAt(entity, t, center, game.ephemeris), center, game.ephemeris, now, spanSec, sampleCount,
    );
    const series: ProjectionSeriesSpec[] = [];
    if (ship) {
      series.push({
        points: ship.samples.map((s) => s && { lonDeg: s.lonDeg, latDeg: s.latDeg }),
        current: { lonDeg: ship.current.lonDeg, latDeg: ship.current.latDeg },
        color: ACCENT,
        currentStyle: 'filled',
      });
    }
    const resolvedTarget = approachSource ? resolveTarget(approachSource) : null;
    const target = resolvedTarget && strongestAttractor(resolvedTarget.currentR, celestialBodies).id === center.id
      ? projectionSeries(
        (t) => resolvedTarget.stateAt(t, center, game.ephemeris), center, game.ephemeris, now, spanSec, sampleCount,
      )
      : null;
    if (target) {
      series.push({
        points: target.samples.map((s) => s && { lonDeg: s.lonDeg, latDeg: s.latDeg }),
        current: { lonDeg: target.current.lonDeg, latDeg: target.current.latDeg },
        color: ACCENT_SECONDARY,
        currentStyle: 'ring',
      });
    }
    const image = this.loadedTextureImage(textureUrl);
    const spec: ProjectionChartSpec = { textureImage: image, series, emptyMessage: image ? undefined : '読み込み中…' };
    this.chart.draw(spec);
  }

  // url のテクスチャ画像を読み込み済みなら返す。未読み込みなら読み込みを開始して次回以降の
  // draw で使えるようにし、今回は null(=空メッセージ描画)を返す。
  private loadedTextureImage(url: string): HTMLImageElement | null {
    const cached = this.textureImages.get(url);
    if (cached) return cached.complete ? cached : null;
    const image = new Image();
    image.src = url;
    this.textureImages.set(url, image);
    return null;
  }
}
