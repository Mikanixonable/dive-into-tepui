# 組み立てウィンドウ リファクタリング計画 (1) バグと未使用コード

## 前提 / 対象範囲

対象は組み立てセッション(`src/game/docking.ts` の `AssemblySession` と関連メソッド群、
`src/game/vessel/dock-workbench.ts` の `DockWorkbenchSession`、`dock-workbench-controller.ts` の
`DockWorkbenchController`、`src/game/hud/assembly-panel.ts` の `AssemblyPanel`)のうち、先行調査で
挙がったバグ候補 B1〜B5 と未使用コード候補 D1〜D6 のみ。`Docking` 938行全体の責務分割・部品ドラッグ
UI・パネル UI の使い勝手といった論点は別担当(R1/R2/R3/P1〜P4/U1〜U5)が扱うため、本書では触れない。
すべて実装を実際に読んで検証済みで、仮説と結果が食い違った箇所は明記した。

## B1 `dockedCount` のセッション開始時キャプチャが古くなる

### 検証結果
仮説はおおむね正しい。`Docking.startAssembly`(`docking.ts:293`)で

```293:304:src/game/docking.ts
    const dockedCount = base.baseState?.dockedVessels.length ?? 0;
    const session = new DockWorkbenchSession(
      { ... },
      () => ({ valid: true, errors: [] }),
      { targetValidator: (target) => targetValidation(target, dockedCount) },
    );
```

のように `dockedCount` を数値としてクロージャへ焼き込んでいる。一方 `Docking.buildDraft`
(`docking.ts:785-811`)は同じセッションが開いている間に

```802:805:src/game/docking.ts
    base.baseState.dockedVessels.push({
      id: vessel.id, name: vessel.name, hp: vessel.hp, maxHp: vessel.maxHp, parts: vessel.parts, vessel, slotIndex: draft.slotIndex,
    });
    base.attachDockedVesselMesh(vessel, draft.slotIndex);
```

と `base.baseState.dockedVessels` へ**実機を直接** push する(建造は資源をその場で引く即時操作であり、
ファイル冒頭のコメント「実機へ書き戻すのは確定を押した瞬間だけ」の例外として意図的に設計されている
—— `docking.ts:784` のコメント参照)。この push は `dockedCount` を更新しない。

`dockedCount` は `targetValidation`(`docking.ts:900-906`)経由で `baseInvariants`
(`base-assembly-validation.ts:17-40`)の `occupiedDockCount` に渡り、基地モジュールのドック容量が
収容中の艦数を下回っていないかを見る。`DockWorkbenchSession.validate()`/`validateTarget()`
(`dock-workbench.ts:114-131`)はこの `targetValidator` を毎回呼ぶので、`AssemblyPanel.sync` が
`syncErrors`(`assembly-panel.ts:376-378`)から**毎フレーム** `session.validateTarget(...)` を叩いている
にもかかわらず、そこで使われる収容数はセッション開始時点のまま動かない。

**実害の範囲を確認したところ、原調査より深刻ではない**: `DockWorkbenchSession.applyAssemblyEdit`
(`dock-workbench.ts:183-206`)は編集後に `this.validate()` を呼び、不正なら `before` へ即座に巻き戻す
(197-202行)。つまり編集そのものはこのライブ検証でブロックされる設計になっている。`dockedCount` が
古いままだと「本来ブロックされるべき編集(ドック容量を実際の収容数未満へ削る等)がブロックされずに
セッションへ入ってしまう」という誤検証は起きるが、`commitBaseAssembly`(`docking.ts:717-739`)は
確定時に `base.baseState.dockedVessels.length` を**都度読み直して**再検証している(719行)ため、
確定そのものは正しく拒まれる。つまり実害は「編集中ずっと嘘のグリーンライトが出続け、確定ボタンを
押した瞬間に初めて理由を伴わずに弾かれる」という UX 上の遅延であり、データ破壊には直結しない
(破壊しない理由は B2 の検証結果を参照 —— 基地ターゲットは常にコミット順序の先頭で処理されるため)。

### 影響
- 組立中プレイヤーが下書きを建造してドック収容数が増えた後、同じセッションで基地モジュールの
  ドック容量を(実際にはもう足りないところまで)削っても、パネルはエラーを表示しない。
- 確定ボタンを押した瞬間に初めて「構成を適用できないため、確定を中止しました」とだけ表示され、
  なぜ拒否されたのか(容量不足)がプレイヤーに伝わらない。せっかく組んだ編集を丸ごと見直す羽目になる。
- 実行頻度は高くない(「同じセッション内で建造してから基地モジュールの容量を削る」という組み合わせ
  が必要)が、発生した場合の手戻りコストは大きい。

### 修正案
場当たり的に「使う直前に読み直す」関数を足すのではなく、**そもそも何が間違っていたか**を直す。
`targetValidation` が本来必要としているのは「収容中の艦数」という**基地の現在の事実**であり、
これは `Docking` が唯一保持している `Vessel`(`base`)から常に導出できる値である。にもかかわらず
`startAssembly` はその値を一度だけ数値へ潰してクロージャに閉じ込めてしまった —— これは
「セッションが `Vessel` を持たない」という正しい境界(`DockWorkbenchSession` は THREE/Vessel 非依存の
純粋な編集セッションである、というこのモジュール自体の設計方針、`dock-workbench.ts:68-69` のコメント
参照)を守ろうとした結果、本来 `Docking` 側が毎回読み直すべき値を、必要以上に早い段階で値へ固定して
しまった実装ミスだと捉えるべきである。

したがって修正は「`dockedCount` という数値を渡すのをやめ、`base`(`Docking` が既に持っている
`Vessel` 参照)を直接閉じ込め、呼ばれるたびに `base.baseState?.dockedVessels.length ?? 0` を読む」
という1行の書き換えで足りる:

```ts
{ targetValidator: (target) => targetValidation(target, base.baseState?.dockedVessels.length ?? 0) }
```

`targetValidator` という関数型のフィールド自体が `DockWorkbenchSession` の構築時にクロージャを注入する
既存の設計であり(`DockWorkbenchOptions.targetValidator`、`dock-workbench.ts:50-53`)、これ自体は
「セッションを実機非依存に保ったまま基地固有の検証を差し込む」ための正しい継ぎ目である。今回の修正は
その継ぎ目を保ったまま、閉じ込める値を「スナップショットされた数値」から「常に現在を指す `Vessel`
参照」に直すだけであり、新しい抽象や状態を持ち込まない。

### 変更ファイルと手順
1. `src/game/docking.ts` の `startAssembly`(293行目付近)から `const dockedCount = ...` の行を削除し、
   `targetValidator` のクロージャ内で `base.baseState?.dockedVessels.length ?? 0` を都度評価するよう
   書き換える。
2. `targetValidation` 関数(900行目付近)のシグネチャ自体は変更不要(`dockedCount: number` を
   引き続き受け取る —— 呼び出し側が渡す値を最新化するだけ)。

### 検証方法
- `npm run typecheck`。
- (手動)組立セッションを開き、新規船下書きを作って建造 → 同セッション内で基地モジュールの
  ドック容量を収容数未満まで削る → パネルにその場でエラーが出ることを確認(従来は確定ボタンを
  押すまでエラーが出なかった)。
- 既存の `tests/unit/dock-workbench.test.ts` はこの経路を直接カバーしていないため、余裕があれば
  「セッション中に対象を追加してから targetValidator が最新の値を見る」ケースをユニットテストへ
  追加するのが望ましい(質問事項参照)。

### リスク / 波及
なし。`Docking` 内で完結する1行の修正であり、`DockWorkbenchSession`/`DockWorkbenchController`/
`AssemblyPanel` のインターフェースは一切変わらない。

---

## B2 `commitAssembly` の「全部通らなければ何も適用しない」が実際には守られていない

### 検証結果
仮説の要点(基地に確定時限定チェックがあり `targetValidator` に含まれていない)は正しいが、
**より重大な、仮説が指摘していなかった構造的欠陥**が見つかった。

`commitAssembly`(`docking.ts:359-379`)はコメントで「1つでも対象の検証が通らなければ何も適用しない」
と宣言し、`snapshot.targets` を1つずつ `applyTargetAssembly` に通す:

```369:374:src/game/docking.ts
    for (const target of snapshot.targets) {
      if (!this.applyTargetAssembly(entry.base, target.id, target.assembly)) {
        this.hud.hint('構成を適用できないため、確定を中止しました');
        return;
      }
    }
```

しかし `applyTargetAssembly`(`docking.ts:698-713`)は対象ごとに**その場で実機を書き換える**副作用を
持つ。基地ターゲット(`target.kind === 'base'`)の場合は `commitBaseAssembly` → `base.replaceAssembly`
(`vessel.ts:625-655`)を呼び、そこでは即座に

- レンダーツリーの子を破棄・再構築(636-641行)
- `this.assembly`/`collisionCapsules`/`collisionGeom`/`massProperties`/`mass`/`radius`/`att.inertia`
  の書き換え(644-650行)
- `this.inventory.replaceAll(design.parts)`(651行、= 基地の部品構成そのものの差し替え)

をすべて**同期的に、ロールバック手段なしで**行う。つまり `applyTargetAssembly` はトランザクションの
一部を実行するのではなく、呼ばれた瞬間に**確定する**。

`assemblyTargets`(`docking.ts:549-560`)の返す配列は常に「基地本体 → ドック中の艦 → 下書き」の順
(551-558行)であり、`DockWorkbenchSession` の内部配列 `targets` もこの順で構築され(`startAssembly`
296-300行)、以後 `addTarget`(下書き追加、`dock-workbench.ts:288-295`)は末尾に push、
`removeTarget`(303-309行)は該当要素をフィルタで除くだけなので、**基地ターゲットは常に
`snapshot.targets` の先頭に来る**。したがって `commitAssembly` のループは必ず基地から処理する。

この順序のおかげで、"基地の検証だけが確定時限定チェックで失敗する" ケース(仮説が想定していたケース)
に限っては、失敗が先頭で起きるため他のターゲットへ波及する前に中断でき、部分適用にはならない
(＝この特定のケースについては仮説の「基地ターゲットが先に適用された後で別ターゲットが失敗すると
矛盾が起きる」という記述は、原因の特定としては半分正しいが、影響範囲の記述としては誤り)。

しかし、これは**たまたま今の実装順序がそうなっているだけ**であり、`applyTargetAssembly` 自体には
「ここまでの適用を元に戻す」手段が存在しない。基地の検証と適用がどちらも成功したあと、2番目以降の
ターゲット(ドック中の艦や下書き)の適用が失敗するケース——`commitDockedAssembly`
(`docking.ts:616-638`)は `index < 0`(対象艦がドックに見当たらない、620行)で失敗しうる——が
起きれば、**基地は新しい構成のまま、艦は古い構成のまま**という中途半端な状態が実際に残る。
現状の呼び出し順ではこの経路に実際に到達するシナリオを作れなかった(組立セッション中はゲームが
一時停止しており `dockedVessels` が外部要因で変化しないため)が、これは「今のコードがたまたま
壊れていないように見える」だけであり、`commitAssembly` のコメントが主張する不変条件をコード自体は
一切保証していない。

### 影響
- 現状で再現する具体的なシナリオは特定できなかった(一時停止中は `dockedVessels` が組立セッションの
  外から変化しないため)が、**将来 `assemblyTargets` の順序を変えたり、`commitDockedAssembly`/
  `applyTargetAssembly` に新しい失敗条件を足したりした瞬間に、無警告でデータ不整合を起こす**。
  「全部通らなければ何も適用しない」という宣言をコメントに書いている以上、それを実際に保証しない
  実装は将来の変更に対して極めて脆い。
- 仮説が挙げた「基地固有の確定時限定チェック(モジュールID一致・ドックポート継続性、
  `commitBaseAssembly` 727-733行)が `targetValidator`/ライブ検証に含まれない」こと自体は事実であり、
  これによりプレイヤーは基地モジュールを差し替えたりドック口を動かしたりする編集を、確定ボタンを
  押すまで一切警告なしに行える。実害は B1 と同種(確定時に初めて、理由の説明が薄いまま拒否される)。

### 修正案
2つの問題は別レイヤーの問題であり、混同せず別々に直す。

**(a) 確定の「全部通らなければ何も適用しない」を実際に保証する。**
これは対症療法(たとえば「基地を最後に適用する」という順序のハックや、「失敗したら手動でロール
バックする」処理を足す)ではなく、**検証と適用を完全に分離する**のが責務として正しい形である。
`applyTargetAssembly` は現在「検証」と「書き込み」を1つの関数に混在させている
(`commitBaseAssembly`/`commitDockedAssembly` はどちらも「まだ確認していない拒否条件を確認しつつ、
確認できたその場で書き込む」という形をしている)。これを

1. 全ターゲットについて「適用できるか」を**副作用なしで**判定するフェーズ
2. 判定がすべて通ってから、初めてどれか1つでも実際に書き込むフェーズ

の2段に分ける。具体的には `commitBaseAssembly`/`commitDockedAssembly` それぞれから「書き込まずに
拒否理由だけを返す」検証部分(基地: モジュール同一性・ドックポート継続性のチェック、艦:
`state.dockedVessels.findIndex` によるターゲット存在チェック)を抜き出し、`commitAssembly` の本体を

```
for (const target of snapshot.targets) {
  const reason = this.checkTargetApplicable(entry.base, target.id, target.assembly);
  if (reason) { this.reportEditFailure(reason); return; }
}
for (const target of snapshot.targets) {
  this.applyTargetAssembly(entry.base, target.id, target.assembly); // ここでは失敗しない前提
}
```

という2段ループへ書き換える。`base.replaceAssembly`/`new Vessel(...)` のような重い構築処理自体は
そう易々とは失敗しない(失敗するのは主に「対象がもう存在しない」「モジュールIDが違う」といった
事前にわかる条件)ため、これらの前提条件だけを先に集めて確認するのは無理のない設計変更である。

**(b) 確定時限定チェックをライブ検証にも見せる。**
これは (a) を実装すれば自動的に解決する副産物でもある —— 「適用できるかを副作用なしで判定する」
関数を作れば、それを毎フレームの `targetValidator`(セッションの `blocking`)からも呼べるからである。
具体的には、`commitBaseAssembly` の 727-733行にある「モジュールIDが変わっていないか」
「収容中の艦のドック口が動いていないか」の2チェックを `baseInvariants`
(`base-assembly-validation.ts`)へ引っ越し、`targetValidation` から届く `blocking` にも常に含める。
ただし `baseInvariants` は現在 `VesselAssembly` と `occupiedDockCount`(数値)だけを受け取る純粋
関数であり、「元のモジュールID」「元のドックポート配置」を知らない。これらは**基地の現在の実機状態**
という B1 と同じ性質の入力であり、B1 の修正方針(セッション開始時の数値スナップショットではなく
`Vessel` 参照から都度導出する)と歩調を合わせ、`targetValidation` の呼び出し元(`Docking`)が
`base.parts`/`base.assembly` から都度導出して渡す形にする。

### 変更ファイルと手順
1. `src/game/vessel/base-assembly-validation.ts`: `baseInvariants` にモジュールID一致・ドックポート
   継続性チェックを追加する新しい引数(元のモジュールIDと元のドックポート配列、あるいは元の
   `VesselAssembly` そのもの)を足す。`sameDockPort`(`docking.ts:927-938`)はここへ移設する
   (現状 `docking.ts` の末尾にある汎用比較関数で、`Docking` 固有の処理ではない)。
2. `src/game/docking.ts`:
   - `commitBaseAssembly`(717-739行)から該当2チェックを削除し、上記の拡張された
     `baseInvariants` 呼び出しへ委譲する形にする。
   - `startAssembly` の `targetValidator` クロージャ(B1 の修正後の形)に、基地の元の
     モジュールID・ドックポート配列も渡すようにする。
   - `applyTargetAssembly`/`commitBaseAssembly`/`commitDockedAssembly` を「検証」と「書き込み」の
     2関数へ分割し、`commitAssembly` を2段ループへ書き換える。
3. `src/game/vessel/dock-workbench.ts`: 変更不要(`targetValidator` のシグネチャは変わらない)。

### 検証方法
- `npm run typecheck`。
- 手動: 基地モジュールを差し替える編集をした瞬間、パネルにエラーが表示されることを確認
  (従来は確定を押すまで無警告)。
- 手動: ドック中の艦がいる状態でそのドック口を動かす編集をした瞬間、同様にエラーが出ることを確認。
- ユニットテスト: `tests/unit/dock-workbench.test.ts` の隣に、`Docking` レベルの
  「検証と適用の分離」を確かめるテストを足すのは `Docking` が THREE/DOM 依存のため難しい
  (現状 `Docking` 自体のユニットテストは存在しない)。最低限、`base-assembly-validation.ts` に
  移設した新チェックの純粋関数としてのユニットテストは追加できる。

### リスク / 波及
`applyTargetAssembly`/`commitBaseAssembly`/`commitDockedAssembly` の分割は `docking.ts` 内で完結する
が、`sameDockPort` の移設は import 元の変更を伴う。`Docking` の責務分割を扱う別担当(R1)が
`commitBaseAssembly`/`commitDockedAssembly` 自体をどこか別モジュールへ切り出す計画を立てている場合、
本書の (a)(b) はその切り出し後の置き場所に合わせて検証/書き込みの分離を行えばよく、内容的な衝突は
ない(「検証と書き込みを分離する」という設計判断自体は、置き場所がどこであっても成り立つ)。
実施順序は「まず本書の (a)(b) で分離してから、R1 がその2つの関数をそれぞれ適切な場所へ移す」が
手戻りが少ない。

---

## B3 `AssemblyPanel.removeSelection` が `Docking` の選択状態を更新しない

### 検証結果
仮説はほぼ正しい。ただし「再度押すと `unknown-node`/`unknown-edge` エラーになる」という結末は、
例外(クラッシュ)ではなく**妥当性検証エラーとして画面に表示される**(スロー例外ではない)。

`AssemblyPanel.removeSelection`(`assembly-panel.ts:538-546`):

```538:546:src/game/hud/assembly-panel.ts
  private removeSelection(): void {
    const selection = this.currentSelection;
    if (!this.lastSession || this.currentTargetId === null || selection === null) return;
    const targetId = this.currentTargetId;
    const validation = selection.kind === 'node'
      ? this.workbench.removeNode(targetId, selection.nodeId)
      : this.workbench.removeEdge(targetId, selection.edgeId);
    this.setEditStatus(validation.valid ? null : (validation.errors[0] ?? '削除できません'));
  }
```

`this.workbench.removeNode`/`.removeEdge`(`dock-workbench-controller.ts:94-100`)は
`DockWorkbenchSession.applyAssemblyEdit` を通してセッションの `targets` からノード/エッジを消すだけで、
`Docking` へは一切通知しない。一方 `Docking.AssemblySession.selection`(`docking.ts:99`)は
`Docking.applyPick`(`docking.ts:458-468`)でしか書き換わらず、`removeSelection` の実行元である
パネル側からは触れない。

その結果、`Docking.syncAssembly`(`docking.ts:489-498`)が毎フレーム渡す `entry.selection` は
削除済みのノード/エッジ id を指したままになる。`AssemblyPanel.syncSelection`
(`assembly-panel.ts:354-363`)は

```354:362:src/game/hud/assembly-panel.ts
  private syncSelection(selection: AssemblySelection): void {
    if (!this.selectionEl) return;
    this.removeSelectionBtn?.setEnabled(selection !== null);
    const key = selection === null ? '' : `${selection.kind}:${selection.kind === 'node' ? selection.nodeId : selection.edgeId}`;
    if (key === this.lastSelectionKey) return;
    this.lastSelectionKey = key;
    this.selectionEl.textContent = selection === null ? '選択: なし'
      : selection.kind === 'node' ? `選択: ノード ${selection.nodeId}`
      : `選択: エッジ ${selection.edgeId}`;
```

のように **`selection !== null` だけ**を見てボタンを有効化し、ラベルもノード/エッジの実在を
確認せずそのまま表示する。つまり削除後もボタンは永久に有効なまま「選択: ノード ○○」と表示し続ける
(3D 側で何も選び直さない限り自然には治らない)。`syncSectionEditor`(`assembly-panel.ts:403-424`)
の方は 412-418行で `node` が見つからない場合に断面編集欄を空にする分岐を持っており、こちらは
実害がない。

もう一度ボタンを押すと `workbench.removeNode(targetId, staleId)` →
`assembly-editor.ts` の `removeNode`(212行〜)が `index < 0` を検出して

```218:src/game/vessel/assembly-editor.ts
    return rejected(assembly, editError('unknown-node', nodeId, `unknown node "${nodeId}"`));
```

を**返す**(スローしない)。`applyAssemblyEdit`(`dock-workbench.ts:183-206`)は `result.accepted`
が false のとき単に `{valid: false, errors: [...]}` を返すだけなので、実際に起きるのは
「`削除できません` の代わりに `unknown node "..."` という開発者向け英語メッセージが `setEditStatus`
経由でそのまま画面に出る」という**表示の不整合**であり、クラッシュや例外ではない。

### 影響
- ノード/エッジを1つ削除するたびに、選択がぶら下がったまま「選択を削除」ボタンが有効であり
  続ける。プレイヤーが誤って連打すると、意味不明な英語のエラーメッセージ(`unknown node "..."`)が
  日本語UIの中に表示される —— ローカライズ漏れのようにも見え、ユーザーを混乱させる。
- 実際のデータは壊れない(セッションの `applyAssemblyEdit` 自身が対象の実在チェックを持っている
  ため)が、UI の「今何が選ばれているか」という状態がプレイヤーの操作と食い違う。

### 修正案
場当たり的な対処(`AssemblyPanel` 側でノードの実在を自分でチェックしてボタンを無効化する、
`unknown-node` を握りつぶしてメッセージを差し替える等)は、**選択状態を誰が所有しているか**という
本質を見ないままの継ぎ足しになる。選択状態(`AssemblySelection`)は `Docking.AssemblySession` が
所有すると設計時点で決まっている(`docking.ts:79-84` のコメント「3D で拾ったノード・エッジの選択。
A4 の断面編集面はここを読む」)。したがって「選択していたものを削除した」という事実で選択を
クリアする責務も `Docking` 側にあるべきで、`AssemblyPanel` が `Docking` の内部状態を書き換える
経路を新設するのは筋が違う。

正しい形は、**削除操作自体を `AssemblyPanel` から `Docking` 経由で呼ばせる**ことである。現在
`AssemblyPanel.onConfirm`/`onCancel`/`onCreateDraft`/`onBuildDraft`/`onRemoveDraft` はすべて
`Docking` がコールバックとして注入している(`startAssembly` 320-335行)のに対し、`removeSelection`
だけは `AssemblyPanel` 自身が `this.workbench` を直接叩いて完結させている ——
これがこの1箇所だけ選択のクリアが漏れた理由である。したがって「選択を削除」ボタンの押下も
他のボタンと同じパターンに揃え、`Docking` に `removeSelection(): void` を追加してそこへ委譲する。

**「編集結果の状態文言を誰が決めるか」は `AssemblyPanel` 側に残す** —— `setEditStatus` を
`public` に開放すると、文言を DOM へ流し込む責務が `AssemblyPanel` と `Docking` の2箇所に
分かれてしまう。代わりに、コールバックの**戻り値**でエラー文言(または成功を示す `null`)を返す形にする:

```ts
// Docking: 選択のクリアと workbench 呼び出しだけを行い、失敗理由を文字列で返す。
// DOM へ文言を書き込む責務は持たない。
removeSelection(): string | null {
  const entry = this.assembly;
  if (!entry || entry.selection === null) return null;
  const { selection } = entry;
  const validation = selection.kind === 'node'
    ? entry.workbench.removeNode(entry.targetId, selection.nodeId)
    : entry.workbench.removeEdge(entry.targetId, selection.edgeId);
  if (validation.valid) entry.selection = null;
  return validation.valid ? null : (validation.errors[0] ?? '削除できません');
}
```

```ts
// AssemblyPanel: setEditStatus は private のまま。文言を DOM へ流し込む責務はここに残る。
onRemoveSelection: (() => string | null) | null = null;
// ボタンのハンドラ
this.removeSelectionBtn = new Button('選択を削除', () => {
  this.setEditStatus(this.onRemoveSelection?.() ?? null);
});
```

これにより「セッションの選択を書き換えてよいのは `Docking` だけ」「編集結果の文言を DOM へ
書くのは `AssemblyPanel` だけ」という既存の所有権(コメントが明言している設計)を実装が
裏切らなくなる。

### 変更ファイルと手順
1. `src/game/docking.ts`: `removeSelection(): string | null` メソッドを追加(上記)。
   `AssemblySession` 型は変更不要。
2. `src/game/hud/assembly-panel.ts`:
   - `onRemoveSelection: (() => string | null) | null = null` フィールドを追加。
   - `removeSelectionBtn` のクリックハンドラを `() => this.setEditStatus(this.onRemoveSelection?.() ?? null)`
     へ差し替える。
   - `private removeSelection()` メソッド自体を削除する。`setEditStatus` は `private` のまま
     変更しない。
3. `startAssembly`(`docking.ts:320-335` 付近)に `panel.onRemoveSelection = () => this.removeSelection();`
   を追加。

**注意**: この修正は別担当 U5(「選択を削除」ボタンの有効/無効判定の見直し)が触るのと**同じ
ボタン**である。U5 は「削除できないノードならボタン自体を無効化する」方向で書き直す予定なので、
`onRemoveSelection` コールバックの導入は U5 の変更とまとめて1回で行う方が手戻りが少ない
(詳細は「実施順序の提案」を参照)。

### 検証方法
- `npm run typecheck`。
- 手動: 3D でノードを選択 → 「選択を削除」→ ボタンが即座に無効化され、「選択: なし」に戻ることを
  確認。
- 手動: 削除直後にもう一度クリックしても何も起きない(以前は `unknown node "..."` が出ていた)
  ことを確認。

### リスク / 波及
`AssemblyPanel` から `DockWorkbenchController` への直接依存が1つ減り、`Docking` 経由のコールバック
注入という既存パターンに揃う。**U5(「選択を削除」ボタンの有効/無効判定)と同じボタン・同じ
コールバック配線を触るため、実施順序で U5 とまとめることを推奨する**(詳細は「実施順序の提案」)。

---

## B4 `validateTargetInternal` の重複除去が文字列一致に依存している

### 検証結果
仮説通りの実装であることを確認した。加えて、**衝突しうる具体的な文言のペア**も特定できた
(先行調査では「未検証」だったが、今回の調査で現実的なリスクであることまで確認した)。

`DockWorkbenchSession.validateTargetInternal`(`dock-workbench.ts:320-337`):

```322:337:src/game/vessel/dock-workbench.ts
  private validateTargetInternal(target: StoredTarget, snapshot: WorkbenchSnapshot): WorkbenchTargetValidation {
    const structural = validateAssembly(target.assembly, { validateBlueprint: false })
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message);
    const custom = this.targetValidator?.(target, snapshot) ?? { blocking: [], issues: [] };
    const blocking = [...structural, ...custom.blocking.filter((message) => !structural.includes(message))];
    return {
      targetId: target.id,
      kind: target.kind,
      valid: blocking.length === 0,
      blocking,
      issues: custom.issues.filter((issue) => !blocking.includes(issue.message)),
    };
  }
```

`custom.issues` は `Docking` の `designIssues`(`docking.ts:909-924`)経由で
`validateAssembly(assembly, {blueprintId, blueprintName, limits})`(`validateBlueprint` オプション
なし=フル検証)を呼んで得られる **`BlueprintIssue[]`** であり、各要素は `{severity, targetId, message}`
という構造を持つ。335行目の `custom.issues.filter((issue) => !blocking.includes(issue.message))` は
`issue.targetId` を一切見ず、**`message` 文字列だけ**で「もう `blocking` に含まれている指摘だから
表示しない」と判定している。

`blueprint-validation.ts` を確認したところ、パラメータを含まない汎用メッセージが実在する:

```380:src/game/vessel/blueprint-validation.ts
      issues.push(issue('error', part.id, 'どのエッジにも収められていません'));
```
```384:src/game/vessel/blueprint-validation.ts
      issues.push(issue('error', part.id, '存在しないエッジに収められています'));
```

これらは `part.id` ごとにループして push されるため、**構成上たまたま2つ以上の部品が同時に
「どのエッジにも収められていません」を踏むと、まったく同一の `message` 文字列を持つ複数の
`BlueprintIssue`(`targetId` は異なる)が生成される**。この状況で、たとえば部品Aの指摘が
`structural`(`validateBlueprint: false` の側)にも同一文言で現れていれば、`blocking` に
「どのエッジにも収められていません」という文字列が1つ入る。すると 335行目のフィルタは
`issue.message` の一致だけで判定するため、**部品Bについての同一文言の指摘まで巻き添えで
`issues` から消える** —— 部品Bの問題はプレイヤーに一切表示されなくなる。

### 影響
- 実害は「拒む理由(`blocking`)が減る」ことではなく「表示だけの指摘(`issues`、= 飛べるかどうかの
  ヒント)が本来あるべきなのに消える」ことに限られる。`blocking`(確定を拒む理由)は
  `structural` を無条件に含み、かつ `custom.blocking` の重複除去は「除いても情報が失われない」
  ケース(すでに同文言が `structural` に含まれている場合のみ除く)なので、**確定の可否には
  影響しない**。
- 影響を受けるのは「設計として飛べるかどうかの警告一覧」の完全性のみ。1つの機体に複数の同種の
  未接続部品があるとき、そのうち1つ分の警告だけが画面から欠落しうる —— プレイヤーが問題箇所を
  見落とす原因になる。地味だが、複雑な機体を組むほど踏みやすくなる種類のバグである。

### 修正案
実害は「表示だけの指摘が1件、巻き添えで消えることがある」に限られ、確定の可否には影響しない
(検証結果参照)。この小ささに対して、`TargetIssues.blocking` という公開型を変えて
`dock-workbench.ts`/`docking.ts`/`base-assembly-validation.ts` の3ファイルへ波及させるのは
釣り合わない — 早すぎる一般化にあたる。

根本原因は「`BlueprintIssue` の同一性を、識別子(`targetId`)ではなく表示用の `message` 文字列
だけで判定していること」であり、かつ巻き添えが起きるのは **`targetId` を持つ `BlueprintIssue`
同士を比較している箇所(335行目、`custom.issues` を `blocking` と突き合わせる部分)だけ**
である。`custom.blocking`(`baseInvariants` 由来、機体全体に対する指摘で元から `targetId` を
持たない)側の文字列比較(327行目の `custom.blocking.filter(... !structural.includes(message))`)
は、同一性判定に使える識別子がそもそも無いので今回のバグの対象外であり、直す必要がない。

**採用案(A案)**: `structural` を `message` の配列へ潰すタイミングを遅らせ、`issue.targetId` も
保持した比較用の `Set` を別に作る。`validateTargetInternal` の中だけで完結する変更で、公開型
(`TargetIssues.blocking` の型、`WorkbenchValidation` の形)は一切変えない:

```ts
private validateTargetInternal(target: StoredTarget, snapshot: WorkbenchSnapshot): WorkbenchTargetValidation {
  const structuralIssues = validateAssembly(target.assembly, { validateBlueprint: false })
    .filter((issue) => issue.severity === 'error');
  const structural = structuralIssues.map((issue) => issue.message);
  const structuralKeys = new Set(structuralIssues.map((issue) => `${issue.targetId} ${issue.message}`));
  const custom = this.targetValidator?.(target, snapshot) ?? { blocking: [], issues: [] };
  const blocking = [...structural, ...custom.blocking.filter((message) => !structural.includes(message))];
  return {
    targetId: target.id,
    kind: target.kind,
    valid: blocking.length === 0,
    blocking,
    // targetId を持つ指摘(custom.issues)は targetId+message の組で、
    // targetId を持たない指摘(custom.blocking 由来)は従来どおり message だけで判定する。
    issues: custom.issues.filter((issue) =>
      !structuralKeys.has(`${issue.targetId} ${issue.message}`) && !custom.blocking.includes(issue.message)),
  };
}
```

`custom.blocking.includes(issue.message)` の側(元の `blocking.includes` のうち `custom.blocking`
由来の部分)は文字列のままで問題ない — `baseInvariants` の指摘はもともと `targetId` を持たず、
機体全体に対する1件ずつの指摘なので、同一機体内で同じ文言が2件生成されて巻き添えが起きる状況が
構造的に存在しない。

**将来の選択肢として(採用しない)**: もし将来 `blocking` そのものを対象の識別子付きで扱う必要が
生じた場合(たとえば `blocking` の各項目をどの部品に対する拒否か UI 上で示したくなった場合)は、
`TargetIssues.blocking` を `readonly {targetId: string; message: string}[]` へ広げる案もある。
しかし今の実害の大きさではその変更を正当化できないため、今回は採用しない。

### 変更ファイルと手順
1. `src/game/vessel/dock-workbench.ts`: `validateTargetInternal`(320-337行付近)を上記の形へ
   書き換える。他ファイルへの変更は不要。

### 検証方法
- `npm run typecheck`。
- ユニットテスト: `tests/unit/dock-workbench.test.ts` へ、「同一メッセージを持つ2つの異なる部品の
  指摘が両方とも `issues` に残る」ことを確かめるケースを追加する(`crewedAssembly` を土台に、
  2つの部品を意図的に未接続状態へ加工する)。

### リスク / 波及
`dock-workbench.ts` の1メソッド内で完結し、公開型・他ファイルへの波及なし。優先度は低い
(表示の欠落のみで確定の可否に影響しないため)。

---

## B5 (対象外: 仮説は誤りだった) `commitDockedAssembly` の detach→attach 順序による `previous` のリーク

**この項目は修正不要と判断した。検証記録は再調査を防ぐために残す(削除しない)。**

### 検証結果
**仮説は誤り。** `attachDockedVesselMesh` が例外を投げる現実的な経路は見つからなかった。

```755:769:src/game/vessel/vessel.ts
  public attachDockedVesselMesh(vessel: Vessel, slotIndex: number): void {
    this.placeAtDockSlot(vessel.renderObject, slotIndex);
  }

  public placeAtDockSlot(obj: THREE.Object3D, slotIndex: number): void {
    const port = this.slotPort(slotIndex);
    if (!port) return;
    ...
```

`slotPort`(`vessel.ts:706-710`)は `slots.length === 0` のときだけ `null` を返し、`placeAtDockSlot`
はその場合**何もせず黙って return する**(例外を投げない)。`slotIndex` が範囲外でも
`slots[slotIndex] ?? slots[0]!` でフォールバックするため、`slots.length > 0` である限り必ず何らかの
ポートが得られる。`commitDockedAssembly` が呼ばれる時点で `base` は既にドック中の艦を1隻以上
持っている基地であり、`slotPort` が `null` を返す(=ドック口が0個の基地)状況とは矛盾する。
THREE 側の呼び出し(`position.set`/`quaternion.copy`/`renderObject.add`)も通常の使用範囲で例外を
投げるものではない。

`commitDockedAssembly` の前段、`new Vessel({blueprintShip: ...})`(`docking.ts:626-628`)は
機体の質量特性・外皮メッシュ生成など重い処理を行うため理論上は例外を投げうるが、この呼び出しは
`detachDockedVesselMesh`/`attachDockedVesselMesh`/`previous.dispose()` の**すべてより前**
(622-628行)に置かれている。したがってここで例外が起きても `previous` はまだ何も触られておらず、
リークは発生しない。

以上より、B5 が指摘する「`attachDockedVesselMesh` が例外を投げた場合に `previous` がリークする」
という経路は、現在のコードには存在しない。

### 影響
なし(仮説が誤りだったため、修正の必要はない)。ただし副次的に、`placeAtDockSlot` がポートを
見つけられない場合に**無警告で何もしない**という点は、デバッグ時に「メッシュが基地の口に置かれない」
という現象の原因を追いにくくする弱いコードスメルではある(が、これは組立ウィンドウ固有の問題では
なく、`placeAtDockSlot` 全体の設計であり、対象範囲外)。

### 修正案
対象外(バグではないため修正しない)。

### 変更ファイルと手順
なし。

### 検証方法
なし。

### リスク / 波及
なし。

---

## D1 `DockWorkbenchController.selectPart` / `.selected`

### 検証結果
確認した。`src/` 全体・`tests/` 全体を grep したが、`dock-workbench-controller.ts` 自身の定義
(`selectPart`: 50行目、`selected`: 49行目)以外に呼び出し箇所は0件。

```45:52:src/game/vessel/dock-workbench-controller.ts
export class DockWorkbenchController {
  private selectedPartRef: string | null = null;
  private drag: DragState | null = null;

  public constructor(private readonly session: DockWorkbenchSession) {}

  public get selected(): string | null { return this.selectedPartRef; }
  public get dragging(): DragState | null { return this.drag; }
  public selectPart(partRef: string | null): void { this.selectedPartRef = partRef; }
```

なお `selectedPartRef` フィールド自体は `beginDrag`/`remove`/`cancel` から書き換えられており、
内部の掴み上げ操作追跡には使われている(ドラッグ完了時に選択が外れる、等)。**公開 API としての
`selectPart`/`selected` だけが未使用**という状況である。

### 修正案
純粋な削除でよい。掴み上げ中の部品追跡(`selectedPartRef` 自体)は現行の 3D ドラッグ操作
(`AssemblyDragController`)から間接的に使われているため残すが、外部から任意の部品を選択状態に
できる公開メソッドは、それを呼ぶ UI がどこにも存在せず、意図(たとえば部品棚のクリックで
ハイライトする、といった将来機能への布石だったか)も確認できない。CLAUDE.md の方針
(「頼まれたことだけを、頼まれた形でそのまま書く」「デバッグしやすいように気を利かせる判断そのものが
要求の逸脱」)に照らしても、使われていない公開 API を保持し続ける理由はない。

### 変更ファイルと手順
1. `src/game/vessel/dock-workbench-controller.ts`: `selectPart` メソッドと `selected` ゲッターを
   削除する。

### 検証方法
- `npm run typecheck`(削除後もビルドが通ることを確認)。
- `grep -rn "\.selectPart(\|\.selected\b" src/ tests/` で新たな参照が生まれていないことを確認。

### リスク / 波及
なし。外部からの呼び出しが0件であることを確認済み。

---

## D2 `DockWorkbenchSession.addInventoryPart` / `.removeInventoryPart`

### 検証結果
確認した。`dock-workbench.ts` 自身の定義(270行目・278行目)以外に呼び出し箇所は0件
(`src/`・`tests/` とも)。

```269:286:src/game/vessel/dock-workbench.ts
  /** Explicit inventory API for non-drag UI controls. */
  public addInventoryPart(part: AnyPart): void {
    ...
  }

  public removeInventoryPart(partId: string): AnyPart {
    ...
  }
```

コメント「Explicit inventory API for non-drag UI controls」が示す通り、ドラッグ以外の手段(例:
ボタンクリックで倉庫へ部品を出し入れする UI)を見越して用意された API と見られるが、そのような
UI は `AssemblyPanel` に存在しない(部品の出し入れは常に `AssemblyDragController` 経由のドラッグ
操作で行われる)。

### 修正案
削除する。B4 と異なりこの2メソッドは `undo`/`redo` 履歴にも正しく乗る(`mutate` 経由)実装として
書かれており、機能としては完成しているが、呼び出し元が存在しない以上は仕様不明の死んだコードで
ある。D4 のように「UI へ繋ぐか削除するか」の価値判断が必要なわけではなく——将来ドラッグ以外の
入出庫手段を作る計画が `SPEC.md`「実装される可能性のある機能」節等に記録されていない限りは、
今は不要なコードとして削除するのが妥当(CLAUDE.md「共通化するかどうかは...今後も使う可能性が
あるかで決める」の裏返しで、使う予定のない一般化された口を残す理由はない)。

### 変更ファイルと手順
1. `src/game/vessel/dock-workbench.ts`: `addInventoryPart`/`removeInventoryPart` を削除する。

### 検証方法
- `npm run typecheck`。
- `grep -rn "addInventoryPart\|removeInventoryPart" src/ tests/` で参照が残っていないことを確認。

### リスク / 波及
なし。ただし念のため `DEVELOP/SPEC.md`「実装される可能性のある機能」節に「倉庫への直接出し入れ
UI」のような記述がないか確認してから削除するのが安全(質問事項参照)。

---

## D3 `DockWorkbenchSession.replaceTarget`

### 検証結果
確認した。定義(176-180行)以外に呼び出し箇所は0件。

```176:180:src/game/vessel/dock-workbench.ts
  public replaceTarget(targetId: string, assembly: VesselAssembly, label = 'アセンブリを置換'): void {
    this.mutate(label, () => {
      this.replaceTargetInternal(targetId, assembly);
    });
  }
```

`replaceTargetInternal`(352-357行、private)は `installPlacement`/`movePlacement`/`removePlacement`/
`applyAssemblyEdit` から内部的に呼ばれており生きているが、それを `mutate` でラップして公開する
`replaceTarget` 自体は外部から一度も呼ばれていない。「対象の構成を丸ごと差し替える」という粒度の
編集を行う UI は `AssemblyPanel` に存在しない(すべて `assembly-editor.ts` の個別編集関数
——`addNode`/`removeNode`/`editSection` 等——経由の `applyAssemblyEdit` で行われる)。

### 修正案
削除する。D2 と同じ理由(粒度の異なる代替 API がありながら誰にも使われていない公開メソッド)。

### 変更ファイルと手順
1. `src/game/vessel/dock-workbench.ts`: `replaceTarget` を削除する(`replaceTargetInternal` は
   他から使われているため残す)。

### 検証方法
- `npm run typecheck`。
- `grep -rn "\.replaceTarget(" src/ tests/` で参照が残っていないことを確認。

### リスク / 波及
なし。

---

## D4 `DockWorkbenchSession.undoHistory` / `.redoHistory` と `WorkbenchCommand.label`

### 検証結果
確認した。`undoHistory`/`redoHistory` は本体側 `src/` からの呼び出しは0件だが、
**`tests/unit/dock-workbench.test.ts` の中で `undoHistory` が1箇所使われている**(69行目
`session.undoHistory.at(-1)!.label`)——先行調査時点では確認されていなかった事実。

```136:142:src/game/vessel/dock-workbench.ts
  public get undoHistory(): readonly WorkbenchCommand[] {
    return this.past.map(cloneCommand);
  }

  public get redoHistory(): readonly WorkbenchCommand[] {
    return this.future.map(cloneCommand);
  }
```

`WorkbenchCommand.label`(`dock-workbench.ts:56-60`)自体は編集のたびに正しく記録されている
(`mutate`/`record` 経由、347-350行)。`AssemblyPanel` の「元に戻す」「やり直す」ボタン
(244-245行)は `session.canUndo`/`canRedo` の真偽だけを見て有効/無効を切り替えるのみで
(323-324行)、`label` を画面のどこにも表示していない(ツールチップ・履歴一覧のいずれも存在しない)。

### 影響
本番コードでは未使用。ユニットテストからのみ参照されている(テストがラベルの正しさを検証する
目的で使っている)。

### 修正案
先行調査の指示通り、これは価値判断が必要なので**両案を提示し、質問事項へ回す**。

**案A(削除)**: `undoHistory`/`redoHistory`/`WorkbenchCommand.label` を削除し、
`WorkbenchCommand` を `{before, after}` だけに簡略化する。`past`/`future` は依然として
`before`/`after` のスナップショットとして undo/redo の実体を担うため、削除しても undo/redo
機能自体は損なわれない。テスト(`dock-workbench.test.ts:69`)は `label` を検証する代わりに
別の方法(たとえば `before`/`after` の差分)でコマンドの区別を確かめるよう書き換える。

**案B(UI へ繋ぐ)**: `AssemblyPanel` の「元に戻す」「やり直す」ボタンに、次に取り消される/
やり直される編集の `label` をツールチップ(`title` 属性)や動的ラベル(例:
「元に戻す: ノードを削除」)として表示する。これは実装コストが小さく(`undoBtn.setLabel`/
`element.title` を1行足すだけ)、UI 上の価値も一定ある(何を取り消そうとしているか分かる)。
ただし別担当の U 系(パネル UI 改善)計画と対になりうる項目であり、本書の担当範囲(バグ・未使用
コード)を超える UI 判断を含む。

いずれの案でも「今のまま `label` を記録だけして誰も読まない」状態を放置しない、という点では
一致している。

### 変更ファイルと手順
(質問事項での決定待ち。決定後、案Aなら `dock-workbench.ts` から該当箇所を削除しテストを調整、
案Bなら `assembly-panel.ts` に表示処理を追加。)

### 検証方法
案Aの場合: `npm run typecheck` と `npm run test:unit`(`dock-workbench.test.ts` の該当行を
書き換えた上で)。
案Bの場合: 手動で「元に戻す」ボタンにカーソルを合わせ、直前の編集内容が分かることを確認。

### リスク / 波及
案Bを選ぶ場合、U 系(パネル UI)の計画と重複しうるため、実施前にその計画書の該当項目
(履歴表示関連があれば)と突き合わせる必要がある。

---

## D5 `DockWorkbenchSession.dirty`

### 検証結果
確認した。本体側 `src/` からの呼び出しは0件。**`tests/unit/dock-workbench.test.ts` から複数回
参照されている**(17・20・105・108行目)——D4 と同様、先行調査時点の「未使用」認定はテストを
含めれば不正確だった。

```92:src/game/vessel/dock-workbench.ts
  public get dirty(): boolean { return !sameSnapshot(this.original, this.snapshot()); }
```

本番コードのどこにも「セッションが編集済みかどうか」を表示・分岐に使う箇所がない
(`AssemblyPanel` は常に確定/取消ボタンを両方表示しており、「未編集なら確定を無効化する」
といった分岐は存在しない)。

### 影響
本番コードでは未使用。呼び出しコストは `sameSnapshot` の深い等価比較(`deepEqual`、
`dock-workbench.ts:429-444`)であり、フレームごとに呼ばれるものではない(呼ばれていないので
コスト自体は発生していない)。

### 修正案
D1〜D3 と異なり、これは「価値判断が必要」というより**用途が明確**である: 未編集のまま確定/取消
ボタンを押しても実害はない(取消は何もしないのと同じ、確定も同じ内容を書き戻すだけ)ため、
UI 側でこれを使って何かを無効化する積極的な理由が薄い。したがって**削除**を推す
(D2/D3 と同じ理由:粒度の異なる代替手段がなく、UI 側の需要も確認できない)。

ただし `dirty` はテストで実際に使われている(`session.dirty` が編集直後に `true`、
`discardChanges()`/`cancel()` 後に `false` に戻ることを確認する用途)。これは
`DockWorkbenchSession` 自体の内部整合性(`snapshotBeforeBuild`/`restore` の一貫性)を検証する
ための妥当なテストであり、`dirty` を削除するなら、テストは `snapshot()` を直接比較する形へ
書き換える(`assert.notDeepEqual(session.snapshot(), originalSnapshotValue)` 等)。

### 変更ファイルと手順
1. `src/game/vessel/dock-workbench.ts`: `dirty` ゲッターを削除する。
2. `tests/unit/dock-workbench.test.ts`: 17・20・105・108行目の `session.dirty` を、
   `session.snapshot()` と事前に取っておいたスナップショットの比較へ書き換える。

### 検証方法
- `npm run typecheck` と `npm run test:unit`。
- `grep -rn "\.dirty\b" src/` で参照が残っていないことを確認。

### リスク / 波及
テストの書き換えを伴う。D6(`originalSnapshot`)を削除する場合、テストが比較対象として使う
「元のスナップショット」を別途保持する必要がある(`new DockWorkbenchSession` に渡した引数
そのものを変数として保持しておけば足りる——`DockWorkbenchSession` はコンストラクタ引数を
クローンして持つ設計なので、渡した側の元オブジェクトは編集の影響を受けない)。

---

## D6 `DockWorkbenchSession.originalSnapshot`

### 検証結果
確認した。`src/`・`tests/` とも呼び出し箇所は0件(定義: `dock-workbench.ts:102`)。

```101:102:src/game/vessel/dock-workbench.ts
  /** State to restore when the transaction is cancelled. */
  public originalSnapshot(): WorkbenchSnapshot { return cloneSnapshot(this.original); }
```

コメントが示す用途(「取消時に復元する状態」)は、実際には `cancel()`/`discardChanges()`
(`dock-workbench.ts:311-318`)が内部で `this.original` を直接 `restore()` へ渡すことで実現して
おり、外部が `originalSnapshot()` を読んで何かに使う経路は存在しない。

### 修正案
削除する。D2/D3 と同じ理由。`this.original` フィールド自体は `cancel`/`discardChanges`/`dirty`
(削除するなら不要)の実装に必要なため残す。

### 変更ファイルと手順
1. `src/game/vessel/dock-workbench.ts`: `originalSnapshot()` メソッドを削除する。

### 検証方法
- `npm run typecheck`。
- `grep -rn "originalSnapshot(" src/ tests/` で参照が残っていないことを確認。

### リスク / 波及
なし。

---

## 質問事項

1. **D4**: `undoHistory`/`redoHistory`/`WorkbenchCommand.label` を削除する(案A)か、
   「元に戻す」ボタンに次の操作内容を表示する形で UI へ繋ぐ(案B)か。案Bは U 系の担当領域
   (パネル UI の使い勝手改善)と価値判断が重なるため、そちらの計画と合わせて決めるのが
   よいかもしれない。
2. **D2**(`addInventoryPart`/`removeInventoryPart`): `DEVELOP/SPEC.md`「実装される可能性のある
   機能」節に、ドラッグ以外の倉庫入出庫手段(ボタン操作等)についての記載があるか確認してほしい。
   なければ削除で問題ない。
3. **B2 の修正範囲**: 「検証と書き込みを分離する」という変更は `commitBaseAssembly`/
   `commitDockedAssembly`/`applyTargetAssembly` という、`Docking` の中でもまとまった一角に
   触れる。R1(`Docking` の責務分割)がこれらの関数自体をどこか別モジュールへ移す計画を
   既に立てているなら、実施順序を合わせたい(「質問事項」というより「実施順序の提案」で
   扱うが、念のためここにも記す)。
4. **B1 のユニットテスト**: `Docking` そのものは THREE/DOM 依存のためユニットテストの対象外
   だが、「セッション開始後に外部から状態が変わった場合に `targetValidator` が古い値を見て
   しまう」というクラス自体の脆弱性を、`DockWorkbenchSession` レベル(`targetValidator` に
   渡す `snapshot` 引数の鮮度)で追加テストする価値があるか判断してほしい
   (`DockWorkbenchSession.validate()` は毎回 `this.snapshot()` を取り直しており、これ自体は
   問題ない——問題は `Docking` が渡す `targetValidator` クロージャの中身だけなので、
   `DockWorkbenchSession` 側のテストでは再現しづらい)。

## 実施順序の提案

0. **B5 は作業なし** —— 検証の結果、仮説は誤りだったため修正対象から除外する。他の項目の
   順序には影響しない。
1. **B3(選択状態のクリア漏れ)** —— **U5(「選択を削除」ボタンの有効/無効判定の見直し)と
   同じボタン・同じコールバック配線を触るため、単独で先に着手せず U5 とまとめて1回で行う。**
   U5 の計画が固まるまで待つか、U5 担当と調整のうえ同時に着手するのが手戻りが少ない。
2. **B1(dockedCount の陳腐化)** —— 1行の修正で完結し、B2 の作業と依存しない。B3 と同時期に
   並行して進めてよい。
3. **B4(文字列一致の重複除去)** —— 採用案(A案)は `dock-workbench.ts` の
   `validateTargetInternal` 1メソッド内で完結し、公開型も他ファイルも変えない。B2 とは独立
   (B2 は `blocking` の**中身**ではなく「誰がいつ検証するか」の話)。B1 の後、B2 の前後
   どちらでもよい。
4. **B2(確定の非トランザクション性)** —— 本書の中で最も影響範囲が広い(`commitBaseAssembly`/
   `commitDockedAssembly`/`applyTargetAssembly` を触る)。B1 の修正(基地の live 判定を正しくする)
   を先に済ませておくと、B2 で「確定時限定チェックをライブ検証へ寄せる」際に同じパターン
   (`Vessel` 参照から都度導出する)を使い回せるため、**B1 の後に着手するのが自然**。
   また、この項目は **R1(`Docking` 938行の責務分割)と最も衝突しやすい** ——
   `commitBaseAssembly`/`commitDockedAssembly` を「検証」と「書き込み」に分割した直後に
   R1 がこれらの関数をまるごと別モジュールへ移動すると、分割の意図(検証だけを先に全対象へ
   回す)が移動先でも保たれているか再確認が必要になる。R1 の計画が先に固まっているなら、
   R1 が決めた新しい置き場所に合わせて分割を行う方が手戻りが少ない。**R1 の担当と実施順序を
   事前にすり合わせることを強く推奨する。**
5. **D1・D3・D6(明確に未使用な削除)** —— リスクなし、いつ着手してもよい。他の項目の
   diff と衝突しないよう、B1〜B4 の変更が一段落してから一括で削除するのが diff の見通しが
   よい。
6. **D2** —— 質問事項2の回答を待ってから着手。
7. **D5** —— テストの書き換えを伴うため、D4 の質問事項1への回答(削除/UI 化)と合わせて
   まとめて着手すると、`dock-workbench.test.ts` への変更を1回のコミットにまとめられる。
8. **D4** —— 質問事項1の回答を待ってから着手。案Bを選ぶ場合は U 系の担当と調整の上で
   最後に着手する。

## 付随して直すべき文書の誤り

本書の担当範囲外だが、調査の過程で見つけた `CLAUDE.md` の記述の誤りを記録する(実装時の
作業として扱う。ここでは指摘のみ)。

`CLAUDE.md`「### Commands」節の `npm run test:physics` の説明末尾に

> There is no other automated test suite wired into npm beyond `test:physics`.

とあるが、これは古い記述である。`package.json` には `test:unit`(`tsc -p tsconfig.test.json &&
node tests/dist/tests/unit/index.js`)が存在し、`ci` スクリプトにも
`test:physics && test:unit` として組み込まれている。`tests/unit/dock-workbench.test.ts` を
含む `tests/unit/` 配下のテスト群がこれで実行される。本書の B1・B4・D4・D5 の「検証方法」
「実施順序」は正しく `test:unit`/`tests/unit/dock-workbench.test.ts` を前提に書いているが、
`CLAUDE.md` 自体の記述はこの実態を反映していないため、別途の変更セットで直す必要がある。
