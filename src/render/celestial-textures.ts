// 実写テクスチャを持つ天体のテクスチャと、そのアルベド倍率の型。値そのものは各天体の
// 構築箇所(game/celestial/solar-system/)が持つ。
//
// **実写テクスチャの明るさはそのままではアルベドではない。** 撮影・処理の過程で任意に
// スケールされているので、テクスチャの平均をその天体のボンドアルベドへ合わせる倍率を1つ持つ。
// 倍率は「テクスチャの緯度重み付き線形平均の Rec.709 輝度」と「公表アルベド」の比で、
// 2026-08-24 に各 JPEG をキャンバスへ読んで一度だけ測った(正距円筒図法なので行ごとの重みは
// cos(緯度))。テクスチャを差し替えたら測り直す。
//
// アルベドの取り方(ボンドアルベド、幾何アルベドからの位相積分)は celestial-albedo.ts と
// 同じ規約に従う。惑星は NASA Planetary Fact Sheet のボンドアルベドをそのまま使える。

// 1天体ぶんのテクスチャと、その明るさをアルベドへ合わせる倍率、そして合わせ先のボンド
// アルベド(倍率の導出元であり、輝点の明るさを引くのにも要る)。averageHue は緯度重み付き
// 平均色の色み(Rec.709 輝度 1 へ正規化した線形 RGB)で、天体を光源にするときの色。
// 倍率と同じ測り方で 2026-08-27 に一度だけ測った。
export type CelestialTexture = {
  readonly url: string;
  readonly albedoScale: number;
  readonly bondAlbedo: number;
  readonly averageHue: readonly [number, number, number];
};
