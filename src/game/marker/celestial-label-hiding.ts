// 天体ラベルを畳む口。ビューを離れるときに、描かれているラベルを消す側が呼ぶ。
export interface CelestialLabelHiding {
  hideLabels(): void;
}
