// 見る範囲の操作行。中心の緯度・経度と半径のつまみと「全球」を組む。
// 値の正本は呼び出し側が持つ。ここが持つのは画面に出している値だけで、つまみを動かすと新しい値を onEdit へ渡す。
import { buildSlider } from '../lab-controls';
import { GLOBE, MAX_RADIUS_DEG } from './synoptic-map';
import type { Framing } from './synoptic-map';

interface FramingRow {
  // 操作行を、与えた見る範囲と見出しへ合わせる。globeVisible が偽のときは「全球」を隠す。
  show(framing: Framing, title: string, globeVisible: boolean): void;
}

// row の中に見る範囲の操作を組む。見出しは titleId の要素に出す。
export function buildFramingRow(rowId: string, titleId: string, onEdit: (framing: Framing) => void): FramingRow {
  const title = document.getElementById(titleId)!;
  let shown: Framing = GLOBE;
  const edit = (next: Framing): void => {
    shown = next;
    onEdit(next);
  };
  const setLatitude = buildSlider(rowId, '中心緯度', -90, 90, 1,
    () => `${shown.latitude.toFixed(0)}°`, (latitude) => edit({ ...shown, latitude }));
  const setLongitude = buildSlider(rowId, '中心経度', -180, 180, 1,
    () => `${shown.longitude.toFixed(0)}°`, (longitude) => edit({ ...shown, longitude }));
  const setRadius = buildSlider(rowId, '半径', 1, MAX_RADIUS_DEG, 1,
    () => `${shown.radius.toFixed(0)}°`, (radius) => edit({ ...shown, radius }));
  // つまみと読み出しを、与えた見る範囲へ合わせる。
  const showKnobs = (framing: Framing): void => {
    shown = framing;
    setLatitude(framing.latitude);
    setLongitude(framing.longitude);
    setRadius(framing.radius);
  };
  const globe = document.createElement('button');
  globe.textContent = '全球';
  globe.addEventListener('click', () => {
    showKnobs(GLOBE);
    onEdit(GLOBE);
  });
  document.getElementById(rowId)!.appendChild(globe);
  return {
    show: (framing, text, globeVisible) => {
      title.textContent = text;
      globe.style.display = globeVisible ? '' : 'none';
      showKnobs(framing);
    },
  };
}
