# sunGlareSpreadScale 重複解消計画

## 1. 現状の要約

`src/game/vessel/gunnery.ts`(37-47行目)と `src/game/vessel/enemy-ai.ts`(27-37行目)に、
一字一句同一の非exportモジュール関数 `sunGlareSpreadScale(pos: Vec3, aimDir: Vec3, sunDir: Vec3): number`
が存在する。

内容は太陽グレアによる射撃散布角の倍率計算:
- `pos` が太陽方向から見て地球本体の影(`R_EARTH_EQ` 未満)にあれば 1 を返す
- それ以外は `aimDir` と `sunDir` のなす角度から、太陽に向けて撃つ(角度小)ほど散布を広げ
  (最大2倍)、太陽を背にして撃つ(角度大)ほど散布を狭める(最小0.5倍)線形補間

依存しているのは `physics/vec3.ts` の `dot`/`addScaled`/`lenSq`/`Vec3` 型と、
`physics/solar-system.ts` の `R_EARTH_EQ` 定数のみ。`THREE`・`Game`・`Vessel` など
ゲーム側の状態には一切依存しない**純粋関数**であることをコード読解で確認した。

呼び出し元は `gunnery.ts` の `fireGun`(プレイヤー弾)と `enemy-ai.ts` の敵AI発砲処理
(プラズマ弾)で、いずれも発射方向決定の直前に呼んでいる。

## 2. 新しい配置場所とその理由

**`src/physics/sun-glare.ts`(新設)に置く。**

理由:
- CLAUDE.md の規約上、`physics/` は「THREE非依存の純粋関数」の置き場であり、この関数は
  まさにその条件を満たす(`Vec3` と数値のみを扱い、副作用なし)。
- `vessel/` 配下に置く選択肢もあるが、この関数は「艦の射撃」固有ではなく「位置・視線方向・
  太陽方向から幾何的にグレア係数を求める」という物理寄りの計算であり、`physics/occlusion.ts`
  (視線と天体球の幾何判定)や `physics/shadow.ts`(日照率の幾何計算)と性質が近い。
  実際、既存コードも地球の影判定に `physics/vec3.ts` の演算を直接使っており、`vessel/` 固有の
  状態(`Vessel`/`Gunnery`/`EnemyAi`)には一切触れていない。
- 車両側の2ファイルがどちらも `vessel/` の中の別クラス(`Gunnery`/`EnemyAi`)であり、
  どちらか一方の所有物にするのは不自然。`physics/` に置けば両者から対等に import できる。

## 3. 具体的な変更手順

1. **新規ファイル作成**: `src/physics/sun-glare.ts`
   - `sunGlareSpreadScale(pos: Vec3, aimDir: Vec3, sunDir: Vec3): number` を `export` 付きで
     そのまま移設(ロジック変更なし)。
   - import: `dot`/`addScaled`/`lenSq`/`Vec3` を `./vec3` から、`R_EARTH_EQ` を `./solar-system` から。
   - 関数直前のコメントは「何をする関数か」を簡潔に一言添える程度に留め(既存に説明コメントが
     なければ無理に増やさない)、移設の経緯には触れない。

2. **`gunnery.ts` の書き換え**
   - 37-47行目の関数定義を削除。
   - `import { sunGlareSpreadScale } from '../../physics/sun-glare';` を追加
     (既存の `physics/` 系importと同じ並びに揃える)。
   - `R_EARTH_EQ` のimportがこのファイルの他の箇所で使われていなければ削除、使われていれば残す
     (要確認: 他に `R_EARTH_EQ` 参照があるかgrepする)。

3. **`enemy-ai.ts` の書き換え**
   - 27-37行目の関数定義を削除。
   - `import { sunGlareSpreadScale } from '../../physics/sun-glare';` を追加。
   - 同様に `R_EARTH_EQ` の単独importが不要になれば削除。

4. **import整理の確認**
   - `dot`/`addScaled`/`lenSq` が両ファイルの他の箇所でも使われているため、`vec3` からの
     importは残る想定(削除不要)。実際に他の使用箇所があるか確認してから判断する。

## 4. 検証方法

- `npm run typecheck`(必須)。
- `src/physics/` を新規作成・変更するため `npm run test:physics` も実行する
  (既存のphysicsテストが通ることを確認。この関数自体の新規テストは今回のスコープ外だが、
  既存スイートを壊していないことは確認する)。

## 5. リスク・注意点

- 関数のロジック自体は変更しないため、挙動に差が出るリスクは低い。
- `R_EARTH_EQ`/`dot`/`addScaled`/`lenSq` の import 整理で「他に使っているか」を見落として
  誤って必要なimportを消さないよう、削除前に各ファイル内で該当識別子をgrepしてから確定する。
- `physics/` 配下は `tsconfig.test.json`(DOM非依存)でもコンパイルされる対象なので、
  新規ファイルにDOM/THREE依存を紛れ込ませないこと(今回は該当なし)。
