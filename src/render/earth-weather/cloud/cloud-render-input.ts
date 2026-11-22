// 地表・大気・雲影が同じ焼成済み雲場を読むための共通表示入力。
// field のテクスチャ所有権は source 側に残し、topAltitude を同じ
// スナップショットに束ねて、表現ごとの入力解釈を増やさない。
import type { CloudFieldBinding } from './cloud-field-sampler';

export interface CloudRenderInput {
  readonly field: CloudFieldBinding;
  readonly topAltitude: number;
  // 雲の細部が流れ、生まれ直す時刻。止まった雲場(実写)では、どちらも 0 に止める。
  readonly clock: CloudDetailClockInput;
  // 実効の積雲の細部の段数(設定・フットプリント上限・予算上限の最小)。表面の雲が立てる
  // 段数と同じ値を雲影へ渡す。
  readonly cumulusOctaves: number;
  // 実効の巻雲の細部の段数。巻雲を読む大気と雲影が同じ値を使う。
  readonly cirrusOctaves: number;
}

// 雲の細部の時刻。displayTime は表示時刻 [s]、simSpeed は実時間 1 秒あたりに進む表示時刻 [s]。
export interface CloudDetailClockInput {
  readonly displayTime: number;
  readonly simSpeed: number;
}
