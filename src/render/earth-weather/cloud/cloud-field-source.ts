// 雲データ供給源(生成/実写)の契約。供給源が消費側の CloudPresentation を引かないよう、
// 種別キーとインターフェースをここへ置く。
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../../gpu-timings';
import type { CloudBlend, CloudFieldSlot } from './cloud-field-sample';

// 雲データの供給源種別。generated は気候モデルから時々刻々生成する動的場、observed は衛星画像に基づく静止場。
// キー名は保存済み描画設定と対応するため変更しない。
export const CLOUD_FIELD_SOURCE_KIND = { observed: 'observed', generated: 'generated' } as const;
export type CloudFieldSourceKind = (typeof CLOUD_FIELD_SOURCE_KIND)[keyof typeof CLOUD_FIELD_SOURCE_KIND];

// 雲データ供給源のインターフェース。slots はキャップへ投影された 2 枚の写しであり、供給元が寿命を管理する。
export interface CloudFieldSource {
  // 焼いた雲場の 2 枚(同じ cap)。雲は R・G = 積雲・巻雲、B・A = 筋の倍角ベクトル。風は R・G = 地表付近、
  // B・A = 上層の東・北の成分 [m/s]。環境は R = 陸、G = 対流、B = 気候の雲量、A = 金床。
  // セル径は R = 積雲・G = 巻雲のセル径 log2(km) の生値、B・A = 予約(0)。
  readonly slots: readonly [CloudFieldSlot, CloudFieldSlot];
  // 2 枚の混ぜ方。供給元が毎フレーム書き換えるので、読み手は読んだ時点の値を使う。
  readonly blend: CloudBlend;
  // 表示時刻 displayTime [s] のテクスチャを準備する。GPU 生成時間は gpu 計測へ計上する。
  prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void;
  // 天体固定で見た太陽直下点の経度 [rad] を渡す。暦を持つ呼び出し側だけが実装先を持ち、
  // null で供給源側の既定の太陽へ戻す。
  setSolarLongitude?(rad: number | null): void;
  // 保持している GPU 資源を解放する。
  dispose(): void;
}
