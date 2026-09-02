// マップビューの縮尺バー(#hud-map-scale)の要素へ、計算済みの縮尺値を書き込む。
import { formatMapScaleDistance, mapScaleFor } from '../map-scale';
import type { Game } from '../../game';

export class MapScaleBadge {
  // 縮尺パネルへラベル要素(「縮尺」)を1度だけ差し込む。
  public constructor(private readonly els: Map<string, HTMLElement>) {
    const panel = this.els.get('map-scale');
    if (!panel || panel.querySelector('.map-scale-label')) return;
    const label = document.createElement('span');
    label.className = 'map-scale-label';
    label.textContent = '縮尺';
    panel.prepend(label);
  }

  // マップビューの縮尺は、カメラから画面中心までではなく、現在フォーカスしている対象の
  // 深度における meters-per-pixel から求める。パンしてもフォーカス対象を基準にするため、
  // 同じ天体を見続ける限り、表示値はスクロールズームだけに対応して変化する。
  public sync(game: Game): void {
    const panel = this.els.get('map-scale');
    if (!panel) return;
    const mapView = game.viewManager.isMapView;
    // 基底の CSS 規則(#hud-map-scale)は display:none で固定されているため、'' へ戻すだけでは
    // 表示に復帰しない。表示側は常に明示の display 値を書く。
    panel.style.display = mapView ? 'block' : 'none';
    if (!mapView) return;

    const focus = game.cameraSystem.mapCamera.resolvedFocus;
    const metersPerPixel = game.cameraSystem.activeCameraScale(focus);
    const scale = mapScaleFor(metersPerPixel);
    const ruler = this.els.get('map-scale-ruler');
    if (!scale || !ruler) {
      panel.style.display = 'none';
      return;
    }
    const valueEl = this.els.get('map-scale-value');
    const text = formatMapScaleDistance(scale.distanceM);
    if (valueEl && valueEl.textContent !== text) valueEl.textContent = text;
    panel.setAttribute('aria-label', `マップ縮尺 ${text}`);
    ruler.style.width = `${scale.widthPx.toFixed(2)}px`;
    ruler.setAttribute('aria-label', `${text} の縮尺`);
  }
}
