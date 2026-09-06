# 本質的なバグ懸念

## **「月回転系にしても予測軌道が月を周回する形で表示されない」**(`memos/mikanixonable/dev.md:741`)。
原因は `DebugTrajectoryLine.sync` に渡すベイク系がマニューバ計画用の `PlanDisplay.planFrame` に
なっており、エンティティの積分軌道表示が自分の座標系設定を持っていないこと
(`memos/mikanixonable/map-orbit-display-fixes.md` 問題2)。

これは「積分軌道をどの座標系でベイクするか」の配線ミスであって、今回直した「積分にどの重力を
入れるか」「解析楕円をどの天体中心で出すか」とは別の責務。**Step1 では意図的に触っていない。**
同文書の問題1(ワープ中に過去列と陳腐化した未来列を連結して線が破綻する)

## ノードが無くてもオレンジの計画線が出る？

## 戦闘ビューでのtrajlineの描画精度が低い
描画の問題なので、エルミート補間側が担うべき責務だが…
カメラに応じて（例えば画面上での向きの差や距離が大きい区間では分割数を増やすなど）できたら描画精度が高まりそうだが、頻繁なカメラ移動に応じてメッシュを再構築するのは…パフォーマンス的にどうなんだろう

## orbitLineの再マッピングが怪しい？
プレイヤーのorbitLineの描画精度が荒い。
プレイヤーがthrust中のみ、orbitLineがギザギザ（多角形的なギザギザではなくランダムなギザギザ）になって荒ぶる挙動がある。
以下の再マッピング部分をコメントアウトすると、多角形の精度が落ちるために乖離は激しくなるが、ギザギザにはならない。
      if (focusE !== undefined) {
        // focusE 周辺に頂点を集める非線形マッピング(3次関数による歪み)
        const f = focusE / (Math.PI * 2);
        let u = t - f;
        while (u > 0.5) u -= 1;
        while (u < -0.5) u += 1;
        // u は [-0.5, 0.5]。u^3 で中心付近を密にする
        t = f + 4 * u * u * u;
      }
この実装を直すか、他の方法で精度を保証するか。

## カメラのオイラーモードで、ロールとヨー/ピッチが噛み合っていない

ロールは効くが、ヨー/ピッチは極軸(`FocusCamera.eulerPolarAxis` = 最寄り天体の自転軸か
黄道面法線)まわりで計算される。90° ロールした状態で左右ドラッグすると、画面上の見た目と
回転方向が一致しない。**クォータニオンモードは現在の右/上軸を使うのでこの問題は出ない** —
座標系パネルの回転モード切替(`hud/frame/camera-frame-panel.ts`)で操作感が割れる。既定は
オイラー。カメラが1つに統合されたので、割れているのはカメラ間ではなく同じカメラの2モード間。


## CONTACTS が伸びると戦闘シェルフが画面上端を突き抜ける(広い幅のみ)

`--shelf-h` は `layout-tokens.ts` の各ブレークポイントで 82〜140px に絞られるが、
**1100px 超の既定値だけ `none`** で、`skeleton-style.ts` の
`#hud-combat-shelf > .panel { max-height: var(--shelf-h) }` が効かない。
シェルフは広い幅では画面下端に固定されるので、CONTACTS が伸びた分だけ上へ育って画面外へ出る。

再現: `SMOKE_QUERY="?stage=0" npm run smoke:browser`(訓練クラスタで敵が多い)。
1280x720 で `#hud-enemies` が高さ 795px になり、シェルフの top が **-87.5px**。
狭い幅では `--shelf-h` が効いてパネル側がスクロールするので出ない。

## ステージ状態パネルと仮想パッドが画面下端を奪い合う

どちらも画面下端中央に置かれ、パッドが出ている(`#touch-ui.shown`)間はどの画面寸法でも重なる。
`SMOKE_TOUCH=1` の検証で、この一件だけ比較対象から外してある
(`tools/browser-smoke.mjs` の該当コメント)。直したら、その除外も一緒に外す。

実測(`?stage=00`、パッド表示中):
- 1280x720 / 800x600 / 667x375: `#hud-stagestatus` × `#touch-mode-col`
- 480x800 / 320x568: 上に加えて `#touch-pad-move` `#touch-pad-rot` とも重なる

## LEAD表示の不具合　そもそも見えてないかも。
LEADマーカーは「その方向に撃ったら対応する敵に当たるはず」を表す方向マーカーらしいが、現在は位置マーカー（markerManager.setPosition）として実装されていておかしい。これはリファクタリングによるエンバグの可能性が高い。本来の挙動の確認が必要。
（見越し点の算出は `physics/intercept.ts` の `leadPoint`、表示は `marker/lead-markers.ts` に集約済み。
算出式はMarkerForGame解体時点の実装をそのまま移しただけなので、この項の検証はまだ済んでいない。）

## 基地を操作している間、戦闘ビューが直前の艦の表示で凍結する

`CombatView` の `handlePointer` は `activePlayers.current`(= 艦)が null なら即 return し、
`syncPanels` もタッチのモードボタンを player がいるときしか更新しない。基地を操作対象にすると
どちらも player=null になるため、モードボタンは直前の艦の値のまま残り、戦闘ビューの右クリックも
効かなくなる。**操作対象は `currentControllable`(艦または基地)なので、艦を前提にした
この2箇所が食い違っている。**(ビュー分離のレビューで見つけた既存の問題。分離では触っていない)

## マップの未来表示・ピックが、基地を操作中でも艦を対象にする

`MapView.syncPanels` は `displayWindowManager.sync` / `picking.sync` へ
`activePlayers.current`(艦)を渡す。表示窓の解決対象は `currentControllable` なので、
基地を操作している間だけ両者が食い違う。上の一件と同じ「艦 vs 操作対象」のずれ。

## 天球グリッドの経度が、赤経と逆向きに増える

`render/celestial-grid.ts` の `EQUATOR_BASIS` は `e1=(1,0,0)` / `e2=(0,0,1)` / `pole=(0,1,0)` で、
`e1×e2 = -pole` の**左手系**。`planePoint` は `cos(lon)·e1 + sin(lon)·e2` なので、経度は +X から
+Z へ増える。一方 `physics/ecliptic.ts` の `raDecToEci` は `stdToEci(cos ra, sin ra, 0)` =
`(cos ra, 0, -sin ra)` で、**赤経は +X から −Z へ**増える。**グリッドが「90°」と書く位置は、
赤経では 270° にあたる。**

グリッドは交点に `${lon}°/${lat}°` のラベルを実際に出している(`celestial-grid.ts` の
`gridLabels`)ので、この向きは画面に出る。

同名の `EQUATOR_BASIS` が `render/scale-grid.ts` では `planeBasisFromPole((0,1,0))` から
組まれていて `e2=(0,0,-1)` の**右手系**。隣接する2モジュールに、同じ名前で逆向きの定数が
並んでいる。

`SPEC/RENDERING.md` は天球グリッドの経度の向きを決めていないので、まず「グリッドの経度は
赤経なのか、独自の目盛りなのか」を決める必要がある。赤経なら `e2` の符号を反転する。

## ラジエーター全損時の破片が、描画原点ぶんずれた位置に出る

`player/radiator.ts` の `tipWorldPosition` は、THREE の `getWorldPosition` で得た値へ
さらに `shipR` を足している。

```ts
fold.getWorldPosition(worldPos);                                   // = r - fo.r + R·offset
return v3(shipR.x + worldPos.x, shipR.y + worldPos.y, shipR.z + worldPos.z);
```

`fold` は `renderObject` の子で、`renderObject.position` には `fo.RtoThreeV3(r)`(= `r - fo.r`)が
入る(`player.ts` の sync)。したがって戻り値は **`2·shipR - fo.r + R·offset`** で、`shipR` を
二重に足し描画原点を引いている(規約 1.8)。

**引数の `_att` が使われていないことが徴候。** 正しい形は同じファイルの `collisionFolds` が
既に書いている `add(shipR, qRotate(att.q, foldLocalPosition(side, last, even, odd)))`。

影響: 呼び出し元は `player.ts` の `radiatorBreakEffect` 1箇所で、全損の瞬間に
`scatterFragments` の発生位置と `worldSfx.hit` の距離へ渡る。描画原点(= カメラ)が自機から
離れているほど破片の湧く位置がずれ、距離が伸びたぶん効果音も減衰する。

直すこと自体は3行だが、見た目が変わるので実機で確かめてから入れる。

## ベルトの節点に時刻が無く、掃引判定が一度も効いていない(速い弾がすり抜ける)

`BeltPhysics.collisionSections`(`belt-physics.ts:233`)が節点の world 状態を

```ts
s.state = kinematicState<'eci'>(s.state.t, /* 位置 */, /* 速度 */);
```

と、**自分の古い `t` を読み直して**置いている。`BeltSection` は `kinematicState(0, …)` で
生成される(`belt-physics.ts:26`)ので、節点の時刻は生成時の **0 のまま一度も進まない。**
`state` セッタは `prevState` をいまの先端へ進める(`dynamic-trajectory.ts:100`)ので、
`prevState.t` も 0。したがって `entity-contact-response.ts:92` の

```ts
const sweptValid = a.prevState.t < a.state.t && b.prevState.t < b.state.t && …
```

が **常に false** になり、ベルトの節点は掃引 TOI へ進まず、区間終端の重なり判定だけを
通っている(`resolveSphereCollision` に `prevA`/`prevB` が渡らず、`sphereContactGeometry` が
静止判定に落ちる)。

**すり抜ける量:** 節点半径 0.8 m + 弾 0.02 m = 0.82 m の窓に対し、機関砲初速は 1000 m/s
(`ship.ts:41`)。倍率 ×1 の substep 幅 1/60 s では弾が 16.7 m 進むので、終端の重なりで
捕まるのは 2 × 0.82 / 16.7 ≈ **1 割**。9 割方は当たらずに抜ける。無言で当たらないので、
「ベルトに当たり判定が無い」ようにしか見えない。

**手本は同じ艦の放熱板の折りで、そちらは正しい。** `RadiatorSystem.collisionFolds`
(`radiator.ts:203`)は時刻を引数で受け、`fold.state = kinematicState<'eci'>(t, …)`(:216)と
置いている。呼び出し元の `Player.contactProxies(simTime, dt)`(`player.ts:457`)は既に
`simTime` を受け取っており、`Simulator` はそれを **substep の終端まで進めた後**に呼ぶ
(`simulator.ts:137` で `this.simTime = endTime`、:157 で `contactProxies`)。よって折りの
`prevState.t` は前 substep の終端 = この区間の始点となり、他の個体と 1e-6 以内で揃う。
**ベルトも `collisionSections` へ時刻を渡し、`s.state.t` の使い回しをやめれば同じ形になる**
(`belt.ts:84` の委譲も署名を合わせる)。書き戻し側(`applyCollisionSections`)は `t` を
読まないので変更不要。

**これは当たり方が変わる変更なので、単独で入れて実機で見る。**

- 速い弾が当たるようになる = 難易度が変わる。振り回したベルトが弾をはたく挙動も出るはず
  (区間 `prevState.r → state.r` は Verlet 変位と姿勢回転を合わせた節点の実際の動きを結ぶ)。
- 代理が前 substep に置き直されていない局面 — 自機の生成直後、節点数が増えた直後、
  倍率が `MAX_PHYS_SIM_SPEED = 4` を超えて物体接触が止まっていた区間の直後
  (`simulator.ts:148` の `canResolveEntityContacts`) — では `prevState.t` が相手とずれ、
  `sweptValid` は false へ落ちて今までどおりの重なり判定に戻る。**壊れるとしても
  「当たらない」側へしか倒れない**ので、この経路を特別扱いする必要はない。
- ベルトの接触を見る回帰テストは無い(`tests/` に belt を触るものが1つも無い)。入れるなら
  節点1つと高速な球を substep 2 回ぶん進める形で、掃引が効くことを直接見るものになる。
