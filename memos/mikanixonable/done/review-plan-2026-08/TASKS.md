# レビュー結果 対処タスク

全10章の findings + 追加調査の集約。**P1〜P3 は 2026-08-10 に対応完了**(下記「完了」節)。
未対処分は「残タスク」節にある。

## 完了(main にマージ済み・typecheck 通過 / test:physics 391/391 green)

### コードの実バグ
- **`plan-executor.ts` の遮断判定** — 高warp でゲートが閉じている間(実際には燃焼していない)も
  `burnCutoffProjection <= 0` が無条件に評価され、軌道力学による自然な速度変化だけで `finish()` が
  発火してノードが未燃焼のまま消費されていた。ガードを `update()` 側と同じ順序に移動。回帰テスト追加。
- **`chase-camera.ts` の破壊後タンブル追従** — `7a2310f`(クオータニオン化)で `player.alive` ゲートが
  取りこぼされたリグレッション。`reinterpretRot` を切り出し、生死の変化フレームで一度だけ相対⇄絶対を
  読み替えることで視点ジャンプなしに復旧。艦の切替(`setPlayer`)を偽の死亡/復活と誤検出しないようにも対応。
- **`player-fire.ts` の `[R]` 手動リロード** — `canReload` の条件が `mags > 0 && (rounds < MAG_ROUNDS ||
  barrel < MAGS_PER_BARREL)` と `||` になっており、装填中が満タンでも予備マガジンを1本消費していた。
  `rounds < MAG_ROUNDS` のみに絞る最小修正。`DEVELOP/BELT_COUNT_BUG.md` の該当節を解決済みに書き換え。
- **`belt-physics.ts` のクランプ角** — `tanMaxPitch`/`tanMaxYaw` に代入する定数が入れ替わっており、
  左右45°/上下15°と `const.ts` の意図と逆の制約になっていた。
- **`base.ts` の id 復元漏れ** — `Base.restore` が `data.id` を受け取りながらコンストラクタに渡しておらず、
  セーブ/ロードのたびに基地の id が変わっていた(他クラスは正しく動作していた)。
- **`save-browser.ts` / `dock-view.ts` の XSS** — 艦名(`Player.displayName`、自由入力)と
  `celestialBodyName()` の未登録 id フォールバックをエスケープせず `innerHTML` に埋めていた格納型 XSS。
- **`dom.ts` のマーカーラベル CSS** — `.mk .lbl`/`.mk-poi .lbl`/`.mk-base .lbl` の margin/padding が
  `#hud, #hud *` リセットに ID 特異性で負けて無効化されていた。`#hud` スコープ化。
- **`celestial-grid.ts` の render→game import 違反** — `CameraSystem` 丸ごとと `game/const` への依存を
  `sync(visibility, cam, scale)` の引数化で解消。`orbit-line`/`sampled-line`/`ships` の依存は
  `RtoThreeV3` 経由の構造的なものと判断し、CLAUDE.md 側に例外として明記。
- **`tsconfig.test.json`** — `include` に残っていた実在しない3パスを整理。

### 文書(コードが正、文書を修正)
- **ラジエーターの左右** — 右手系 nose=+Z/up=+Y より starboard = Z×Y = -X、つまり **+X は左舷**。
  コードは `f97aae2` で既に正しく、CLAUDE.md と `DEVELOP/BELT.md` だけが古かった。
- **右クリック優先順** — `3a659a6` で「マーカー → ノード → 空域」の3段フォールスルーへ意図的に
  再設計済み。CLAUDE.md 3箇所と `DEVELOP/CALLSTACK.md` を現順序に修正。
- **姿勢積分の刻み幅** — 存在しない `attDt = min(simDt, 0.12)` の記述を削除(実装は全エンティティ一律 `subDt`)。
- **廃止シンボル** — `hitRadius`/`sideHitBy`/`RADIATOR_HITTABLE_DEPLOY`/`RADIATOR_TIP_DISTANCE` の記述を
  現行の `RadiatorFold` 接触方式に書き直し。
- **未記載モジュールの追記** — `physics/ephemeris-pack/`(二段構え暦)・`absolute-ephemeris`・
  `packed-absolute-ephemeris`・`ephemeris-profile`・`ephemeris-catalog`・`time/`、`plan-gizmo-3d.ts`、
  `ring-optics.ts`、`radiator-hinge.ts`、`aurora.ts`。`test:physics` 節にも該当テストを追記。
- **天体数** — 「27 bodies」を実測値(恒星1・planet 49・satellite 51 = **101体**)の構成説明に書き直し。
- **環の描画** — TSL シェーダによる Beer-Lambert 透過・Henyey-Greenstein 単一散乱・
  `setRingShadowSystem` の環影・`ringLod` のクロスフェードという現行実装に合わせて全面書き直し。
- **`stars.ts`** — 「微小三角形」から実装どおりのテクスチャ球殻に修正(WebGPU の Points 制約自体は残置)。

### レビューの穴埋め
- 章04(セーブ)・章06(天体表示)の findings を作成(未実施だった2章)。

## 残タスク

### 要判断(仕様の決定が必要)
1. **ノード右クリックが到達不能になる条件** — 現在の優先順自体は正しいが、ノードの約24.5px以内に
   マーカー候補(遠点/近点・AN/DN・艦・天体ラベル)があると、ノードの削除/ワープメニューが開けない
   (`MAP_PICK_PX_SQ`=600≒24.5px < `NODE_PICK_PX`=30px の非対称も一因)。
   対処案: 選択中ノードだけ editor を先行させる / ノードを `pickables` に統合する など。

2. **`EarthBody.phase0` の非決定性** — `earth-body.ts:13` の自転初期位相が `Math.random()` で、
   `Ephemeris` の位相オフセット(`GameSaveData.phaseOffsets` として永続化)と違い save/restore 経路が
   一切ない。同じセーブを開くたび地球の自転角だけが変わる。実装漏れの可能性が高いが確証なし。

### セーブフォーマット変更を要する
3. **`Enemy.restore` の accent 使い回し** — 機体色と軌道線色に同じ `accent` を使っており、
   訓練クラスタ敵(accent≠軌道線色で生成)をセーブ/ロードすると軌道線の色が変わる。見た目のみ。

### テスト
4. **`ring.test.ts` が quaoar/chariklo の環を未検証** — 環を持つ天体が6体に増えたがテストは4体のまま。
5. **測定値 pin の網羅的な妥当性確認** — 章10 が優先度を挙げた `n-body.test.ts` の質量→0 極限の
   収束閾値と、`plan-executor*.test.ts` のタイミング系マージン。

### 低優先リファクタ
6. `ContextMenu.open` の label/subLabel が無エスケープ `innerHTML`(現呼び出し元は静的文字列のみ)
7. `dom.ts` に残る z-index(マーカー種別 0-4 / `.dock-toggle`:20 / svgOverlay:0)が
   `overlay-layer.ts` の「z-index はここだけ」規約と矛盾
8. `map-picker.ts` `isCreativeMode()` の `as any`(循環 import 回避の設計判断が要る)
9. `orbit-line.ts` の `snap.hHat`/`snap.pHat` がスプレッド構文で `Vec3` を構築(`v3()` 規約違反)
10. `deque.ts` の4スペースインデント
11. `ChebyshevAbsoluteEphemeris`/`PackedAbsoluteEphemeris` の重複気味な2実装
12. `icrfToGameEci` の `-0` 回避分岐に理由コメントなし
13. `refactoring_todo.md` の完了項目棚卸し(責務判断を refactor-fixed へ移してから消す手順で)

## 備考

- 章01(軌道力学)・章02(シミュレーション)は確証ある `[bug]` ゼロ。検算・grep・テストで確認済み。
- 「接近猶予窓」の PlanGuide/PlanExecutor 差と node-gizmo の occlusion 非対称は意図的と判断、対処不要。
