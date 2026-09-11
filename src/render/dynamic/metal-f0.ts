// 剥き出しの金属のベース色。**金属度 1 ではベース色がそのまま垂直入射の反射率(F0)になる**ので、
// 値は各金属の可視域の代表的な F0 を sRGB へ写したもの。面ごとの違いは色でなく粗さで付ける。
// tools/model-builder/ が単体で transpile して読むので、他モジュールを import すると壊れる。

// 熱焼け・黒染めの鋼(砲身・ノズル・エンジン周りなど、焼きの入った鉄鋼部品)。
export const F0_BURNT_STEEL = 0xa2a6ad;
// 鋼・ステンレス(構造フレーム・リング・機構部品)。
export const F0_STEEL = 0xc4c8cd;
// アルミ・銀めっき(最も明るい金属面)。
export const F0_ALUMINIUM = 0xf4f5f6;
// 真鍮(薬莢・弾頭部)。
export const F0_BRASS = 0xf2e6b0;
