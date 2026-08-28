# 天体まわりの是正バックログ

refactor_celestial_structure2(手順0〜9 実施済み、手順10 見送り)の作業中に見つけた
「是正したいが、挙動不変の計画の中では直さなかった」項目。行番号・状態はすべて `0194dca7`
時点のスナップショット。食い違ったらコードを信じる。

## 1. 地球の自転位相が見た目と physics で二重定義

見た目(`game/celestial/earth.ts` の `sync`)は `phase0 + 2πt/SIDEREAL_DAY`、physics の
`spinRotationAt`(`physics/celestial-motion.ts` 経由、地球は `pole: { kind: 'eciPole' }`)は
phase0 を持たない。**地球自転系の向きと地表テクスチャの向きが一致していない。**
揃えるなら phase0 を physics 側の自転モデルへ渡す形になるが、地球自転系の向きが変わる =
挙動が変わるので計画の外とした(計画の落とし穴・手順9 の項どおり)。

## 2. 保存ブラウザの天体名は、実行中の周回が無いと素の id になる

`hud/windows/save-browser.ts` が `gameSource.current?.celestialSystem.nameOf(id) ?? id` を
スナップショット一覧の行(中心天体名)へ渡す。天体の日本語名の静的な表を消した帰結で、
周回が1つも動いていない状態で保存ブラウザを開くと `earth 高度 …` のような表示になる。
直すなら「周回に依らない名前の引き先」を1つ決める必要がある(名前の正本は各系ファイルの
構築コードなので、表の復活とは別の形が要る)。

## 3. `Game` の責務境界(CODING-RULE 1.2 / 1.9)

`game/game.ts` にオーケストレーション以外のメンバー(`setControlledBase` / `dispose` /
`advanceSimulation` / `handlePointerInput` / `objectName` / `viewBadgeContext` /
`proteinMotionFrameSample` 等)があり、`sync()` の中で `displayWindowManager` の解決など
update 相当を呼ぶ箇所がある。今回のリファクタ以前からの構造で、hook が毎回警告する。
横断を責務とするモジュールへ寄せる再編が要る。

## 4. `game/celestial/` の置き場と命名(手順10 の見送り理由)

`src/celestial/` へ出す条件「`game/` を import しない」が不成立。残っている import:
`game/camera/floating-origin`(12箇所)・`game/camera/camera-system`(8)・
`game/camera/focus-target`(1)・`game/marker/marker-manager`(3)・`game/lines/orbit-line`(3)・
`game/const`(2)。カメラ・マーカー・線の抽象を切るか、置き場は現状維持かの判断が要る。
あわせて `System` / `Manager` の使い分け(`CelestialSystem` と `EntityManager` の非対称)も
再検討する(計画の決めたこと3の宿題)。

## 5. `CelestialSystem.sunDirFrom` に単体テストが無い

`Ephemeris.sunDirFrom` の委譲テストは部品化のときに削除した(1行の式の再記述だったため)。
実装は `game/celestial/celestial-system.ts` にあり THREE を import するモジュールなので、
node のテストから実行できない。式を検証したいなら physics 側へ置き直すか、割り切って残す。

## 6. `tests/perf` の実験12本を削除した

`Ephemeris` を前提にしていた exp1/3/5/6/7/8/9/11/12/13/14/15 は、npm script から呼ばれて
いないため書き直さず削除した(計画の決めたこと7)。`common.ts` は天体窓ベースへ移して
あるので、必要になった実験はそこから部品 API で書き直す。

## 7. `marker-manager.ts` / `grouped-markers.ts` の `frames?: ReferenceFrames` が常に未指定

旧 `ephemeris?` を最小変換した引数で、現状すべての呼び出しが undefined を渡す。
使う経路を復活させる予定が無いなら引数ごと消せる。
