// マップビューの縮尺バー(#hud-map-scale)の要素へ、計算済みの縮尺値を書き込む。
import { formatMapScaleDistance, mapScaleFor } from '../map-scale';
import type { ScaleFn } from '../../../math/projection';
import type { Vec3 } from '../../../math/vec3';

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

  // フォーカス対象の ECI 位置 focus の深度での meters-per-pixel から縮尺を求めて書き込む。
  // 同じ対象を見ている間、表示値はズームに追従する。縮尺が決まらなければパネルを隠す。
  public sync(screenScale: ScaleFn, focus: Vec3): void {
    const panel = this.els.get('map-scale');
    if (!panel) return;
    // 基底の CSS 規則(#hud-map-scale)が display:none なので、'' へ戻すと表示に復帰しない。
    panel.style.display = 'block';

    const metersPerPixel = screenScale(focus);
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
