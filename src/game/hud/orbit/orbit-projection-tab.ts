// 軌道分析パネルの投影タブ: 操作対象が周回している天体の円筒図法テクスチャを背景に、操作対象と
// ターゲットの経緯度の軌跡を重ねる。表示範囲(中心経緯度・ズーム)はチャート自身が持つので、
// このタブはスケール入力欄を持たない。
import { strongestAttractor } from '../../../physics/attractor';
import { PointerPanZoom } from '../widgets/pointer-pan-zoom';
import { ACCENT, ACCENT_SECONDARY } from '../../theme';
import { projectionSeries, resolveTarget } from './orbit-analysis-data';
import { buildTabControls, sampleCountFor } from './orbit-analysis-tab';
import { OrbitProjectionChart } from './orbit-projection-chart';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { OrbitReference } from '../../orbit-reference';
import type { ApproachTargetSource } from './orbit-analysis-data';
import type { AnalysisTab } from './orbit-analysis-tab';
import type { ProjectionSeriesSpec } from './orbit-projection-chart';

// id の天体が持つ円筒図法テクスチャの URL。実写テクスチャが無い天体(単色球扱い)は null。
function projectionTextureUrl(game: Game, id: string): string | null {
  return game.celestialSystem.find(id)?.surfaceTextureUrl ?? null;
}

// 経緯度の点列を、投影チャートが描ける1系統の指定へ移す。
function seriesSpecOf(
  track: NonNullable<ReturnType<typeof projectionSeries>>,
  color: string,
  currentStyle: ProjectionSeriesSpec['currentStyle'],
): ProjectionSeriesSpec {
  return {
    points: track.samples.map((s) => s && { lonDeg: s.lonDeg, latDeg: s.latDeg }),
    current: { lonDeg: track.current.lonDeg, latDeg: track.current.latDeg },
    color,
    currentStyle,
  };
}

export class ProjectionTab implements AnalysisTab {
  public readonly label = '投影';
  public readonly element: HTMLElement;
  private readonly chart = new OrbitProjectionChart();
  // 背景画像。URL ごとに読み込み、読み込み完了まではその天体を背景無し(空メッセージ)で描く。
  private readonly textureImages = new Map<string, HTMLImageElement>();

  // チャートと、リセットボタンだけの行を積む。
  public constructor() {
    this.chart.element.classList.add('panzoom');
    new PointerPanZoom(
      this.chart.element, (dxPx, dyPx) => this.chart.pan(dxPx, dyPx), (wd) => this.chart.zoom(wd),
    );
    this.element = document.createElement('div');
    this.element.appendChild(this.chart.element);
    this.element.appendChild(buildTabControls([], () => this.resetView()));
  }

  // 基準天体が円筒図法テクスチャを持つときだけ選べる(単色球の天体では地図を敷けない)。
  public available(game: Game, _entity: DynamicEntity, reference: OrbitReference): boolean {
    const center = reference.attractor;
    return center !== null && projectionTextureUrl(game, center.id) !== null;
  }

  public dispose(): void {
    this.chart.dispose();
  }

  public resetView(): void {
    this.chart.resetView();
  }

  // 中心天体の反対側(遠地点付近)を通る軌道でも見失わないよう高度タブと同じサンプル数を使い、
  // 描く未来の期間はマップの未来表示(軌道予測パネル)が指す期間をそのまま使う。
  public draw(
    game: Game, entity: DynamicEntity, reference: OrbitReference, target: ApproachTargetSource | null,
  ): void {
    const center = reference.attractor;
    const textureUrl = center === null ? null : projectionTextureUrl(game, center.id);
    if (center === null || textureUrl === null) return;
    const { celestialSystem } = game;
    const now = entity.state.t;
    const spanSec = game.displayWindowManager.current.duration;
    const sampleCount = sampleCountFor(this.chart.element);
    const centerEntity = celestialSystem.entityOf(center.id);

    // 操作対象自身の軌跡(塗り丸)と、同じ中心天体を周回しているターゲットの軌跡(縁だけの丸)。
    const ship = projectionSeries(
      (t) => entity.stateAt(t, celestialSystem), centerEntity, now, spanSec, sampleCount,
    );
    const resolvedTarget = target === null ? null : resolveTarget(target, celestialSystem, now);
    const targetTrack = resolvedTarget !== null
      && strongestAttractor(resolvedTarget.currentR, celestialSystem.celestialMotions, now).id === center.id
      ? projectionSeries((t) => resolvedTarget.stateAt(t), centerEntity, now, spanSec, sampleCount)
      : null;
    const series: ProjectionSeriesSpec[] = [];
    if (ship) series.push(seriesSpecOf(ship, ACCENT, 'filled'));
    if (targetTrack) series.push(seriesSpecOf(targetTrack, ACCENT_SECONDARY, 'ring'));

    // テクスチャが読み込み済みならそれを背景に、まだなら読み込み中の案内文を出す。
    const image = this.loadedTextureImage(textureUrl);
    this.chart.draw({ textureImage: image, series, emptyMessage: image ? undefined : '読み込み中…' });
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
