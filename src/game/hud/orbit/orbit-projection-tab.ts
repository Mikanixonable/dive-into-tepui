// 軌道分析パネルの投影タブ: 背景テクスチャの読み込み・キャッシュを行い、操作対象・ターゲットの
// 経緯度点列を OrbitProjectionChart へ渡す。
import { strongestAttractor } from '../../../physics/attractor';
import { CelestialMotion } from '../../../physics/celestial-motion';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import { entityStateAt } from '../../dynamic/entity-state-at';
import { ACCENT, ACCENT_SECONDARY } from '../../theme';
import { ApproachTargetSource, projectionSeries, resolveTarget } from './orbit-analysis-data';
import { OrbitProjectionChart, ProjectionChartSpec, ProjectionSeriesSpec } from './orbit-projection-chart';

// id の天体が持つ円筒図法テクスチャの URL。実写テクスチャが無い天体(単色球扱い)は投影タブを
// 出せないので null。
export function projectionTextureUrl(game: Game, id: string): string | null {
  return game.celestialSystem.find(id)?.surfaceTextureUrl ?? null;
}

export class OrbitProjectionTab {
  public readonly chart = new OrbitProjectionChart();
  // 背景画像。URL ごとに読み込み、読み込み完了まではその天体を背景無し(空メッセージ)で描く。
  private readonly textureImages = new Map<string, HTMLImageElement>();

  // 保持しているチャートを破棄する。
  public dispose(): void {
    this.chart.dispose();
  }

  // 中心天体 center の反対側(遠地点付近)を通る軌道でも見失わないよう高度タブと同じ
  // サンプル数を使い、期間 spanSec はマップの未来表示(軌道予測パネル)が指す期間をそのまま使う。
  public draw(
    game: Game, entity: DynamicEntity, center: CelestialMotion, approachSource: ApproachTargetSource | null,
    celestialBodies: readonly CelestialMotion[], now: number, spanSec: number, sampleCount: number, textureUrl: string,
  ): void {
    const centerEntity = game.celestialSystem.entityOf(center.id);
    // 操作対象自身の軌跡(塗り丸)。
    const ship = projectionSeries(
      (t) => entityStateAt(entity, t, centerEntity), centerEntity, now, spanSec, sampleCount,
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
    // ターゲットが同じ中心天体を周回していれば、その軌跡(縁だけの丸)も重ねる。
    const resolvedTarget = approachSource
      ? resolveTarget(approachSource, game.celestialSystem, now) : null;
    const target = resolvedTarget
      && strongestAttractor(resolvedTarget.currentR, celestialBodies, now).id === center.id
      ? projectionSeries(
        (t) => resolvedTarget.stateAt(t, centerEntity), centerEntity, now, spanSec, sampleCount,
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
    // テクスチャが読み込み済みならそれを背景に、まだなら読み込み中の案内文を出す。
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
