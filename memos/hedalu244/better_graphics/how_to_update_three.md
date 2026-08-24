# three.js を上げるときの手順

**このリポジトリは `three` を `0.185.1` へピン留めしている**(`@types/three` は `0.185.4`)。
上げること自体は禁じていないが、**ピン留めと同時に入れた回避策を外さないと描画順が黙って
逆さになる。** その回避策と、外し方と、外れたことの確かめ方をここに置く。

## なぜピン留めしているか

three `0.185.1` の `RenderList.sort`(`src/renderers/common/RenderList.js`)は、
`reversedDepthBuffer` が有効なとき **custom sort を適用したあとで** `opaque` /
`transparent` / `transparentDoublePass` を無条件に `.reverse()` する
(three.js Issue #33944、修正 PR #33945、マイルストーン r186)。
本作は深度を反転しているので、放置すると `renderOrder` の段が丸ごと逆順になる —
星殻が最前面に出て画面を塗り潰し、軌道線の優先度が裏返る。

**打ち消しは `src/render/pipeline/reversed-sort.ts`。** `renderer.setOpaqueSort()` /
`setTransparentSort()` へ **three の既定比較関数の符号を反転した比較**を渡している。
`.reverse()` は sort の直後に無条件で走り、既定の比較関数は最後に `a.id - b.id` でタイを割る
**全順序**なので、「反転比較でソート → reverse」は「既定比較でソート」と厳密に一致する。
近似でも回避でもなく等価変換である。

**修正の入った版へ上げると、この打ち消しが余計になって描画順が黙って逆さになる。例外は出ない。**

## 検知

`tools/check-three-pin.mjs` が `npm run ci` の中で次の 2 つを見る。どちらかが崩れたら落とす。

1. `node_modules/three/package.json` の `version` が `0.185.1` であること。
2. `node_modules/three/src/renderers/common/RenderList.js` に、空白を除いた
   `if(reversedDepth){this.opaque.reverse();` が含まれること。

**2 が本質で、1 は補助。** 版を上げなくても振る舞いが変われば落ちるようにしてある。

## 手順

1. `package.json` の `three` / `@types/three` を上げ、`npm install`。
2. `node tools/check-three-pin.mjs`。**2 の検査だけが落ちるなら、修正が入っている。**
3. `src/render/pipeline/reversed-sort.ts` を削除し、`src/render/scene.ts` の
   `setOpaqueSort()` / `setTransparentSort()` の呼び出しを消す。
4. `tools/check-three-pin.mjs` を削除し、`package.json` の `ci` からその行を消す。
   `three` / `@types/three` の指定を `^` 付きへ戻す。
5. **検証**: `npm run render-lab:shot` を撮り、`order` ケースで 5 本の線が奥から
   `reference → shipOrbit → target → plan → predicted` の順に重なることを確かめる。
   **これが唯一の判定** — 手順 3 をやらずに版だけ上げても、やりすぎて両方消しても、
   このケースの絵が逆順になる。
6. `leo` ケースの `diff` が変わっていないこと、実機で星空が最前面に来ていないことを確かめる。

**手順 3 と 4 は同じ commit で行う。** 片方だけ入った状態は、検査が通るのに絵が逆さ、
またはその逆になる。

## 版を上げるとき、ついでに確かめるもの

いずれも three の現在の振る舞いに合わせて置いてあるもので、three 側が変われば要らなくなる。

- **`reversedDepthBuffer` はコンストラクタ引数でしか渡せない。** 深度比較関数だけが構築時の値を
  読むため(`WebGPUPipelineUtils.js`)、あとから代入すると投影行列とクリア値だけが反転して
  比較関数が取り残される。渡している場所は `render/scene.ts` の 1 箇所。
- **`RenderTarget` の深度は明示しないと `depth24plus` のまま。** three は暗黙の深度テクスチャを
  `reversedDepthBuffer` に関係なく `UnsignedIntType` で作る(`Textures.js`)。だから深度を持つ
  ターゲットには全て `new THREE.DepthTexture(w, h, THREE.FloatType)` を据えてある。ここが
  直って自動で 32bit になるなら、その明示は消せる。
- **投影方式のコンパイル時分岐(`positionViewDirection` など)は当てにしない。** three は
  RenderObject をカメラで鍵付けしないので、平行投影と透視投影を同じマテリアルで行き来すると
  最初に組まれた枝が残る。視線は実行時の値から組む `render/pipeline/view-ray.ts` を通す。
