// 地表・大気・雲影が同じ焼成済み雲場を読むための共通表示入力。
// field のテクスチャ所有権は source 側に残し、generation と topAltitude を同じ
// スナップショットに束ねて、表現ごとの入力解釈を増やさない。
import type { CloudFieldBinding } from './cloud-field-sampler';

export interface CloudRenderInput {
  readonly field: CloudFieldBinding;
  readonly generation: number;
  readonly topAltitude: number;
  // 雲の細部が流れ、生まれ直す時刻。止まった雲場(実写)では、どちらも 0 に止める。
  readonly clock: CloudDetailClockInput;
}

// 雲の細部の時刻。displayTime は表示時刻 [s]、simSpeed は実時間 1 秒あたりに進む表示時刻 [s]。
export interface CloudDetailClockInput {
  readonly displayTime: number;
  readonly simSpeed: number;
}
