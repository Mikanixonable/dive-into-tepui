// 実験環境の状態と URL の query の対応。モード・写し・時刻・両方の見る範囲・天気図の層を
// query へ載せて、開き直し・共有・撮影の再現を効かせる。知らないキー(撮影の駆動が使う
// capture-only など)は書き換えずに保持する — ここが触るのはここに書いたキーだけ。
import type { Framing } from './synoptic-map';

// URL に載る状態。読み出し側では、欠けた・壊れた項は null(既定へ戻す)。
export interface LabState {
  readonly mode: 'cloud' | 'synoptic' | null;
  readonly view: string | null; // 写しの id(モードが写しのとき)
  readonly hours: number | null; // 表示時刻 [h]
  readonly cap: Framing | null; // 写しの cap の中心・半径 [°]
  readonly map: Framing | null; // 天気図の窓 [°]
  // ON の層のキー。null は既定の層構成(DEFAULT_LAYERS)。層のキー名は LAYER_LABELS が正本。
  readonly layers: readonly string[] | null;
}

const numberAt = (params: URLSearchParams, key: string): number | null => {
  const value = params.get(key);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const framingAt = (params: URLSearchParams, prefix: 'cap' | 'map'): Framing | null => {
  const latitude = numberAt(params, `${prefix}Lat`);
  const longitude = numberAt(params, `${prefix}Lon`);
  const radius = numberAt(params, `${prefix}R`);
  return latitude === null || longitude === null || radius === null
    ? null : { latitude, longitude, radius };
};

// location.search から状態を読む。値が欠けたり壊れたりした項は null(既定へ戻す)。
export function parseLabState(search: string): LabState {
  const params = new URLSearchParams(search);
  const mode = params.get('mode');
  const layers = params.get('layers');
  return {
    mode: mode === 'cloud' || mode === 'synoptic' ? mode : null,
    view: params.get('view'),
    hours: numberAt(params, 'h'),
    cap: framingAt(params, 'cap'),
    map: framingAt(params, 'map'),
    layers: layers === null ? null : layers.split(',').filter((key) => key !== ''),
  };
}

const framingInto = (params: URLSearchParams, prefix: 'cap' | 'map', framing: Framing | null): void => {
  const set = (key: string, value: number | null): void => {
    if (value === null) params.delete(`${prefix}${key}`);
    else params.set(`${prefix}${key}`, String(value));
  };
  set('Lat', framing === null ? null : framing.latitude);
  set('Lon', framing === null ? null : framing.longitude);
  set('R', framing === null ? null : framing.radius);
};

// 状態を query へ書く。既存の search を元に組むので、知らないキーはそのまま残る。
export function labStateQuery(state: LabState, search: string): string {
  const params = new URLSearchParams(search);
  if (state.mode === null) params.delete('mode'); else params.set('mode', state.mode);
  if (state.view === null) params.delete('view'); else params.set('view', state.view);
  if (state.hours === null) params.delete('h'); else params.set('h', String(state.hours));
  framingInto(params, 'cap', state.cap);
  framingInto(params, 'map', state.map);
  if (state.layers === null) params.delete('layers'); else params.set('layers', state.layers.join(','));
  return params.toString();
}
