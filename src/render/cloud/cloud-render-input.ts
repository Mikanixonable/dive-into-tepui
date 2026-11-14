// 地表・大気・雲影が同じ焼成済み雲場を読むための共通表示入力。
// field のテクスチャ所有権は source 側に残し、generation と topAltitude を同じ
// スナップショットに束ねて、表現ごとの入力解釈を増やさない。
import type { CloudFieldBinding } from './cloud-field-sampler';

export interface CloudRenderInput {
  readonly field: CloudFieldBinding;
  readonly generation: number;
  readonly topAltitude: number;
  // 表示時刻 [s]。粒の移流と寿命はこの時刻で進む。
  readonly displayTime: number;
}
