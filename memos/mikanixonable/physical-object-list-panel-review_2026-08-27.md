# 軌道物体一覧パネル(PhysicalObjectListPanel)の点検(2026-08-27)

## この文書について

`src/game/hud/panels/physical-object-list-panel.ts` を中心に、`physical-object-list-order.ts`・
供給側(`map-picking.ts` / `object-pickables.ts` / `focus-markers.ts`)・スタイル
(`panel-content-style.ts` / `map-view-style.ts`)まで広げて点検した結果の**指摘一覧**。
実装は行っていない。

- 基準コミット: `8e8524d0`(点検中に別セッションが `9101ad73` の上へ積んだもの。作業ツリーは clean)
- 対象規模: `physical-object-list-panel.ts` 525行 / `physical-object-list-order.ts` 194行
- 天体は `BODY_CLASSES` に約99件。ラグランジュ点を含めると全展開時の行数は数百に達しうる。

なお点検中、**別セッションが同じリポジトリで作業していた**(`8e8524d0` はこの点検の最中に
積まれたもの)。対象2ファイルへの変更は `SectionOrder` の移設だけで、以下の指摘には影響しない。

CSS は `.css` ファイルではなく `src/game/hud/style/*.ts` のテンプレート文字列で持たれている。
本パネルに効くのは `panel-content-style.ts:93-125`(基調)と `map-view-style.ts:84-192`
(マップビュー専用の上書き)の2箇所。

指摘には確信度を添える。**[確認]** はコードを読んで断定できたもの、**[推測]** は挙動の理屈から
そうなるはずだが実機で再現を取っていないもの。

---

## 1. バグ

### 1.1 [確認] 行レベルの「絞り込み時の自動展開 → 解除時の復元」機構が、原理的に空振りする

`RowNode.savedExpanded` / `matchAncestors` / `restoreSavedExpanded()` は、絞り込みが一致行の
祖先を強制展開したぶんを、解除時にプレイヤーの元の畳み状態へ戻すための機構。**この機構は
どの経路でも意味のある仕事をしていない。**

理由は、絞り込みを変えると**行ツリーが丸ごと作り直される**ため。

- `rebuildOrder()`(`physical-object-list-order.ts:141-148`)は、親が同じ区画の表示対象に
  居ない行を根として扱う。
- 絞り込み無しの天体区画では、太陽以外の全天体が親を持つので `rootIds = ['太陽']` 付近になり、
  行ツリーは `section.rows = { sun }` の1本。
- `filter='satellite'` にすると一致するのは衛星だけで、`withClusterParents()` が親の惑星を
  補う。惑星の親(太陽)は表示対象に居ないので**惑星が根**になり、`rootIds` は惑星の列。
- `sync()` の `pruneRows(section.rows, seen)`(`physical-object-list-panel.ts:305-311`)は
  `seen` を `rootIds` からしか作らないので、**旧ルートの太陽ノードとその全子孫が破棄される。**
- 検索語でも同じ。一致した衛星の親は一致しないので、衛星が根になり、上位ノードは消える。

さらに `filteringJustDeactivated` の復元(`physical-object-list-panel.ts:282-287`)は、区画
ループ(290行〜)より**先**に走る。つまり `restoreSavedExpanded()` が `expanded` を書き戻す
相手は、**その直後に prune される運命のノード**。書き戻した値は DOM にも反映されない
(`restoreSavedExpanded()` は `applyRowExpanded()` を呼ばない。呼ばれるはずの `syncRow()` は
そのノードに対して呼ばれない)。

→ **`RowNode.savedExpanded` と `matchAncestors` は削除できる。** 区画レベルの
`Section.savedExpanded`(区画は永続オブジェクトなので生き残る)だけが実際に効いている。

### 1.2 [確認] 絞り込みを変えるたびに、手動で開いた枝がすべて畳まれる

1.1 の副作用。フィルタや検索語を変えて戻すと、根の顔ぶれが変わって全ノードが再生成され、
`createRowNode()` の既定 `expanded: false`(`physical-object-list-panel.ts:484`)に戻る。

**検索欄をクリアした直後、天体区画は「太陽」1行が畳まれた状態だけになる。** 一覧を開き直す
操作が毎回要る。`focusAncestors` はフォーカスが変化した回にしか効かないので、ここでは救えない。

[推測] 同じことは絞り込みと無関係にも起こりうる。`items` は可視性で絞られた
`ObjectPickables.visibleItems` なので、ある惑星が可視性規則から外れたフレームでは、その衛星が
根に昇格して親ノードが prune される。可視性が戻った次のフレームには全部作り直しになり、
**開いていた枝が勝手に畳まれる。** 再現条件は詰めていない。

### 1.3 [確認] 「全展開 / 全折りたたむ」ボタンが、区画を畳んでも・区画が空でも残る

DOM 上、ツリー操作ボタンは区画見出しと区画本体の**兄弟**として置かれている
(`physical-object-list-panel.ts:207-210`)。

```
body.appendChild(header);
if (kind === 'body') body.appendChild(this.buildTreeControls(section));  // ← sectionBody の外
body.appendChild(sectionBody);
```

`applyExpanded()` は `sectionBody` にしか `collapsed` を付けず、`syncHeader()` は `header` にしか
`hidden` を付けない。CSS 側にもボタンを隠す規則が無い
(`panel-content-style.ts:114` は `display: flex` のみ)。

結果:
- 天体区画を畳むと、**見出しの下にボタン2つだけが浮いて残る。**
- 絞り込みで天体が0件になると、**見出しごと消えた場所にボタン2つだけが残る。**

ボタンを `sectionBody` の中(先頭)へ移すか、区画の可視性と連動させる必要がある。

### 1.4 [確認] `F` キーが行のフォーカス移動と**自機のプログレードリセットを同時に発火する**

```ts
row.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); this.onFocus?.(id); }
  if (e.key.toLowerCase() === 't') { e.preventDefault(); this.onNavTarget?.(id); }
});
```
(`physical-object-list-panel.ts:467-470`)

**`stopPropagation()` を呼んでいない。** `Input` は `window` に `keydown` を張り
(`input/input.ts:112`)、`handleKeyDown` は `e.target` を一切見ずに全打鍵を `pendingPresses` へ
積む(同 120-130行)。`KeyF` はグローバル操作キー `progradeReset` に割り当て済み
(`input/key-mapping.ts:31`)。

その先を辿ると:
- `game.ts:399-401` → `entities.updatePlayers(player, playerInput, canShipAct, ...)`
- `canShipAct` は `simSpeedManager.canShipAct` (`game.ts:394`)。**ワープ倍率だけで決まり、
  マップ視点かどうかは見ていない。**
- `player/player.ts:481` `case K.progradeReset.code: this.throttle.enableProgradeReset();`

→ **マップ視点で一覧の行にフォーカスを当てて `F` を押すと、視点が移ると同時に自機が黙って
プログレード方向へ姿勢を戻し始める。** 通常倍率なら常に起こる。

`T`(`targetSelect`)のほうは `targeter.ts:61` の `handleTargetSelectKey` が
`if (overviewMode) return;` で早期に抜けるため、たまたま実害が出ない。**`F` は危険、`T` は安全**
という非対称が偶然でできている。

修正は行の keydown で `e.stopPropagation()` を呼ぶこと。`ValueInput` は同じ理由で
必ず `stopPropagation()` している(`widgets/value-input.ts:45-47`)し、`UI-DESIGN.md:149` も
即時フィルタ入力について「**キー入力の伝播だけは必ず自分で止める**」と要求している。**行にも
同じ要求が当たる。**

併せて修飾キーの防御も無い。行にフォーカスがある状態で **Cmd+F / Ctrl+F(ブラウザの検索)を
押すと `preventDefault()` されてフォーカス移動が走る。** `e.isComposing` も見ていない
(`help-panel.ts:507` に前例あり)。

```ts
if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
e.stopPropagation();
```

### 1.5 [確認] 一覧からの操作が `pickable` を無視する — マップ上の操作との挙動差

`ObjectPickable.pickable` は「表示上のラベル衝突で隠された対象は、ダブルクリックのフォーカス候補
からも外す」ためのフラグ(`object-pickable.ts:24-26`)。

マップ上の直接操作は必ずこれを通す:
- 右クリック `map-picking.ts:167`
- 左クリック `map-picking.ts:392`
- ダブルクリック `map-picking.ts:407`

一覧パネルの3経路は**どれも通さない**(`map-picking.ts:137-150` はいずれも
`pickables.find((i) => i.id === id)` だけ)。`physical-object-list-panel.ts` /
`physical-object-list-order.ts` に `pickable` の文字列は現れない。

「一覧からは隠れていても操作できるべき」という意図的な仕様の可能性はあるが、**コードにその判断を
示すコメントが無い。** 意図なら一言書く、意図でないなら揃える。どちらにせよ現状は宙に浮いている。

### 1.6 [確認] 一覧から自艦をダブルクリックしても操作対象が切り替わらない

`DEVELOP/SPEC/MAP.md` §10 は「ダブルクリックはその対象へマップ視点のフォーカスを移す
(**対象が自艦なら操作対象にもなる**)」と書いている。

- マップ上のダブルクリック `map-picking.ts:412-419` は `activePlayers.set(ship)` を持つ。
- 一覧パネルの `onFocus` `map-picking.ts:137-140` は `setFocus()` と `hint()` だけ。

同じ「ダブルクリック=フォーカス」の入口が2つあって、片方だけ自艦の分岐を持っている。

### 1.7 [確認] `tgt` と `related-orbit` が完全に同一条件・同一見た目

```ts
node.row.classList.toggle('tgt', item.id === focusId);
node.row.classList.toggle('related-orbit', item.id === focusId);
```
(`physical-object-list-panel.ts:405-406`)

条件が1文字も違わない。CSS 側も同一:

- `panel-content-style.ts:117-119` `.erow.tgt { color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, transparent); }`
- `map-view-style.ts:176-178` `.erow.related-orbit { color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, transparent); }`

`related-orbit` は `grep` した限りこのパネル以外では使われていない。片方が旧実装の残骸。
**どちらかを消す。**

なお `tgt` という名前は「ターゲット」を連想させるが、実際に表しているのは**フォーカス**
(`focusId`)。ナビ対象(`onNavTarget` / `NavTarget`)とは別物なので、名前が意味を裏切っている。

### 1.8 [確認] `withClusterParents()` がクラスタ親を末尾へ積むため、親の並びが整列順にならない

```ts
for (const id of ids) result.push(id);          // 一致した衛星(整列済み)
for (const id of ids) { ...; result.push(parentId); }  // 親を後ろへ足す
```
(`physical-object-list-order.ts:183-191`)

親は「最初に現れた子の順」で末尾に積まれる。`rebuildOrder()` はこの `displayIds` の順で
`rootIds` を作る(`physical-object-list-order.ts:141-148`)ので、**衛星フィルタ時の親惑星の
並びは、選んだ並び順(太陽系順/近さ/名前)ではなく、子の登場順で決まる。**

子が整列済みなので結果的に近い順になることが多いが、`compare()` を通っていないので保証は無い。
「名前」順を選んだときに親惑星が名前順に並ばないのが分かりやすい破れ。

### 1.9 [確認] 検索欄が `ValueInput` を使いながらその契約を外から迂回し、確定値の正本を二重化している

`UI-DESIGN.md:147-149` は、打鍵ごとの反映それ自体は認めている:

> **唯一の例外は絞り込み入力**(打鍵ごとに一覧を再描画する必要がある検索欄)——確定でしか通知
> しない値入力の契約とは別の要求のため、**生の入力欄を使ってよい**。…(ただしキー入力の伝播
> だけは必ず自分で止める、次項)

問題は「打鍵ごとに反映すること」ではなく、**仕様が「生の入力欄を使え」と書いている場所で
`ValueInput`(確定契約のウィジェット)を使い、その上に `input` リスナーを外から張って
迂回していること。**

```ts
const search = new ValueInput({...}, updateQuery, () => { this.order.query = ''; });
search.element.addEventListener('input', () => updateQuery(search.element.value));
```
(`physical-object-list-panel.ts:144-151`)

結果、**確定値の正本が2つになる**:
- `ValueInput.committedValue` — Enter / blur でしか動かない、生の文字列
- `PhysicalObjectListOrder.query` — 打鍵ごとに動く、`trim().toLocaleLowerCase()` 済み

CODING-RULE 1.6「正データが複数箇所に分散、重複しているデータ」。同じ値の2表現が並存し、
片方だけが更新されている時間帯が常にある。

**生の `<input>`(+ `stopPropagation`)に置き換えるのが仕様どおり。** `type: 'search'` の
`ValueInput` はコードベース中この1箇所だけなので、`ValueInput` から `'search'` 型ごと落とせる
可能性もある(要確認)。

副次的に: `escapeBehavior: 'clear'` は仕様上正しい(`UI-DESIGN.md:144`「空にするを選べるのは
検索欄に限る」)が、`ValueInput.cancel()` は `this.element.blur()` も呼ぶ
(`widgets/value-input.ts:99`)。**Escape で文字が消えるだけでなくフォーカスも外れる。**
一般的な検索欄は1回目の Escape ではクリアだけしてフォーカスを残す。生の入力欄へ移すなら
ここも直せる。

### 1.10 [確認] 行の展開トグルの表示/非表示をインライン `style` で書いている

```ts
node.toggle.style.visibility = children.length > 0 ? 'visible' : 'hidden';
```
(`physical-object-list-panel.ts:417`)

`UI-DESIGN.md` §1 の原則「状態は見た目の有無でなくクラスの付け外しで持つ」に対する逸脱。
`visibility` を使って 10px の占有幅を保つ意図自体は妥当なので、
`.physical-object-list-toggle.no-children { visibility: hidden }` へ移すだけでよい。

同種の直書きは `windows/property-window.ts:390` にも残っており、このパネル固有の逸脱ではない。

## 2. 設計・規約

### 2.1 [確認] scratch 群が CODING-RULE 1.7 の例外要件を満たしていない

パネルは7本、Order は4本の scratch を持つ(`physical-object-list-panel.ts:106-113`、
`physical-object-list-order.ts:55-60`)。冒頭コメントは「Map/Set/配列の器だけを保持して GC を
抑える」と書く。

CODING-RULE 1.7 は同一参照の中身を書き換えての転用を禁じ、例外を「**可読性を犠牲にするに足る
相当のパフォーマンス上の理由がある場合のみ**」に限っている。

供給側を調べると、その理由が薄い:
- `ObjectPickables.visibleItems` は配列を使い回し、`itemRecords` で `ObjectPickable` レコード自体も
  id ごとに使い回している(`object-pickables.ts:157-198, 211-239`)。天体側も
  `FocusMarkers.bodyPickableRecords` で同じ(`focus-markers.ts:180, 302-314`)。
- つまり**定常状態で GC 圧を作っているのは候補列ではない。** パネルの scratch はその上に
  重ねられているだけで、削減量は小さい。

一方で、パネル自身がもっと大きな割り当てを毎フレーム行っている(→ 3節)。**「GC を抑える」と
書きながら、抑えていない箇所のほうが大きい**という内部矛盾がある。

判断: scratch を全廃するか、残すなら**実測を根拠として添える**。今の状態は規約の例外条項を
根拠なく使っている。

### 2.2 [確認] `withClusterParents()` が共有バッファを返す — 整合性責務の漏洩

```ts
private withClusterParents(...): string[] {
  const result = this.displayIdsScratch;
  ...
  return result;   // ← インスタンスが持つ可変バッファをそのまま返す
}
```
(`physical-object-list-order.ts:177-193`)

呼び出し側は返り値が「次に `rebuildOrder()` が呼ばれるまでしか有効でない」ことを知らないと
使えない。CODING-RULE 1.6「複数箇所が一定の整合性を保つことが要求されるデータ。…**整合性保持
責務の漏洩は重大な違反**」。

しかも同じ関数の三項式の反対側は `order.ids`(呼び出し側が所有する配列)を返すので、
**返り値の所有者が条件によって変わる。** 使う側からは見分けがつかない。

### 2.3 [確認] `prev*` 5本の平行配列 — 配列への外部対応付け

```ts
private readonly prevIds: string[] = [];
private readonly prevNames: string[] = [];
private readonly prevKinds: MapPickKind[] = [];
private readonly prevParents: (string | undefined)[] = [];
private readonly prevMatches: boolean[] = [];
```
(`physical-object-list-order.ts:48-52`)

添字で `items` に対応付ける5本の配列を、`refreshInputs()` が5箇所同時に更新し、5箇所同時に
長さを切り詰める(`physical-object-list-order.ts:97-101`)。CODING-RULE 1.6「配列に対して外部
から対応付けを行う設計を避ける」がそのまま当たる。1本増やすたびに更新箇所が5箇所→6箇所に増える。

今のところ機能的な破れは無い(不一致を検出したら丸ごと組み直す設計なので自己修復する)が、
形として脆い。`{ id, name, kind, parent, matched }` の配列1本、あるいは差分検出をハッシュに
置き換えるほうが素直。

### 2.4 [確認] 表示文字列を意味解釈に使っている

```ts
const HEADER_SUMMARY = {
  ship: { needle: '接近', label: '接近' },
  ammo: { needle: '回収可能', label: '回収可' },
  fuel: { needle: '回収可能', label: '回収可' },
};
...
if (this.itemsByIdScratch.get(id)?.detail?.includes(summary.needle)) count++;
```
(`physical-object-list-panel.ts:39-43, 356`)

`detail` は表示用の文章(`object-pickables.ts` が組み立てる)。その**日本語の部分文字列**を
数え上げの判定に使っている。`detail` の文言を1文字変えた瞬間に、警告なしにカウントが 0 になる。

`ObjectPickable` に真偽のフィールド(例: `approaching?: boolean` / `collectable?: boolean`)を
足して、表示と判定の正本を分けるべき。

### 2.5 [確認] `MapPickKind → グリフ` の写像が2箇所に独立実装されている

- `physical-object-list-panel.ts:57-74`(`OBJECT_GLYPHS` / `OBJECT_GLYPH_SVGS`)+ `bodyGlyph()`(364-366)
- `object-windows.ts:1006-1020`(`iconFor()`、プロパティウィンドウのタイトルアイコン)

body 分岐は**文字通り同じ式**:
`LAGRANGE_ID.test(id) ? ENTITY_GLYPH.lagrange : bodyEntityGlyph(bodyClassOf(registry, id))`
(`physical-object-list-panel.ts:365` と `object-windows.ts:1008-1009`)。
apsis/relnode/eqnode の対応も同一。

`marker-glyphs.ts` / `marker-shapes.ts` は「族ごとの記号」の正本として既に切り出されている。
**欠けているのは「種別 → どの記号/SVG を使うか」の1段上の関数**で、それが2箇所にある。
`DEVELOP/SPEC/UI-DESIGN.md` は一覧の字形とマップマーカーの字形を揃えることを要求しているので、
CODING-RULE 1.5 の決め手(「共通化した側が変更されたとき参照側の挙動も変更されるべきか」)は
**Yes** に倒れる。種別が増えたら両方で同じ記号を出したいはず。

差異: 一覧側は必ず文字列を返す、`iconFor()` は `empty-space` で `undefined` を返す。吸収が要る。

### 2.6 [確認] ラグランジュ点 id の解析が2つの正規表現に分かれている

- `object-groups.ts:12,15-17` — `LAGRANGE_ID = /-l[1-5]$/` と `lagrangeParentId(id)`
- `physical-object-list-order.ts:37-40` — `lagrangeSortKey()` が `/^(.+)-l([1-5])$/` を別に持つ

同じ命名規則を2つの正規表現が知っている。`object-groups.ts` に点番号も返す形へ寄せるのが自然。

### 2.7 [確認] 到達しないコード: `OBJECT_GLYPHS` の 4 エントリ

`SECTIONS`(`physical-object-list-panel.ts:18-25`)は `body/player/ship/ammo/fuel/base` の6種
だけを持ち、`rebuildOrder()` もこの6種でしか回らない。`apsis` / `relnode` / `eqnode` /
`empty-space` の行は**一覧に一切現れない**が、`OBJECT_GLYPHS` にはこの4種の字形が定義されて
いる(57-67行)。

`object-groups.ts` の `groupPickables()` は同じ除外を空 `case` + コメントで明示している。
一覧側にはその説明が無く、除外が意図なのか書き漏れなのかコードから判別できない。

`namesScratch` / `itemsByIdScratch` も表示しないこの4種を毎フレーム格納している
(`physical-object-list-panel.ts:243-248`)。

### 2.8 [確認] 責務過多 — 525行に少なくとも5つの関心事

1. ヘッダー UI(検索欄・分類・並び順)の組み立てと配線
2. 行ツリーの DOM 差分同期(`syncRow` / `pruneRows` / `createRowNode`)
3. 展開状態のポリシー(フォーカス自動展開 / 絞り込み自動展開 / 復元 / 一括開閉)
4. 区画見出しの集計表示(`HEADER_SUMMARY`)
5. パンくず・空状態・フォーカスへのスクロール

`785f7190` で 3(並べ替え・絞り込み・親子構築)は `PhysicalObjectListOrder` へ出た。残りも
同じ理屈で切れる。CODING-RULE 1.5 は「1箇所からしか参照されていなくても、**巨大な責務を分割する
ためなら分割する**」と明示している。

分割案:
- `PhysicalObjectListRowTree` — `RowNode` の生成・差分同期・prune・開閉の適用。DOM だけを知る。
- `PhysicalObjectListHead` — 検索・分類・並び順の3コントロールと `PhysicalObjectListOrder` への配線。
- `PhysicalObjectListPanel` — 上記の組み立てと `sync()` の段取りだけ。

1.1 の指摘を先に適用すれば、展開ポリシーは「フォーカス祖先を開く」だけに縮むので、この分割は
かなり軽くなる。

### 2.9 [確認] `Section` と `RowNode` が同じ開閉概念を二重に持つ

`Section { expanded, savedExpanded }` と `RowNode { expanded, savedExpanded }`、
`applyExpanded()` と `applyRowExpanded()`。やっていることは同じ(真偽を持ち、`collapsed` を
付け外しし、グリフを切り替える)なのに、区画はグリフを**見出しの `textContent` に埋め込み**、
行は**専用の `<span>` に書く**。統一されていない。

1.1 を適用して `savedExpanded` を落とせば、共通の小さな型1つにまとまる。

### 2.10 [確認] 呼び名が3種類ある

同じものが `物体`(見出し `physical-object-list-panel.ts:137`)/ `軌道物体一覧`
(`COLLAPSE_LABELS` 51-52行、`aria-label` 149行)/ `physical-object-list`(クラス名)/
`hud-physical-object-list`(id)と呼ばれている。`DEVELOP/SPEC/MAP.md` §10 の見出しは
「軌道物体一覧パネル」。

`memos/mikanixonable/プラスチックワード命名調査・改善案_2026-08-14.md` の系統の指摘。
**日本語表示名を1つに決める**(SPEC に合わせるなら「軌道物体一覧」)。

### 2.11 [確認] 使われていないクラス名と、意味の違う共有クラス名

- `physical-object-list-name`(`physical-object-list-panel.ts:449`)に対応する CSS 規則が
  両スタイルファイルとも0件。名前ラベルだけを truncate する等の要求が来たときの受け皿が
  無い状態で、クラス名だけが浮いている。
- `erow` は `#hud-enemies .erow`(戦闘ビューの敵一覧、`panel-content-style.ts:81-82`)とも
  共有されている。ID スコープ配下なので実行時の衝突は無いが、**構造も意味も違う2つの行が
  同じクラス名**を名乗っているのは紛らわしい。
- 一方 `tgt` の共有(`draggable-window.ts:63`、`#hud-enemies .erow.tgt`、本パネル)は
  `UI-DESIGN.md:207-209` が要求する意図的な語彙共有なので**これは正しい** — ただし本パネルでは
  `tgt` が実際にはターゲットではなくフォーカスを表しており(1.7 参照)、その語彙共有を裏切って
  いる。

---

## 3. 性能

前提として、天体は約99件。ラグランジュ点を含めて全展開すると数百行が DOM に載り、その全部が
毎フレーム `syncRow()` を通る。以下はすべて**毎フレーム**の話。

### 3.1 [確認] パネルを畳んでいても全同期が走る

`wirePanelCollapse` は本体 `body` に `collapsed` を付けるだけで(`panel-shell.ts:127-139`)、
CSS は `display: none !important`(`panel-content-style.ts:105`)。**完全に不可視でも、
`sync()` は行ツリーの差分同期を丸ごと実行し続ける。**

`sync()` の先頭に「畳まれていれば何もしない」の早期 return を置ける。判定は
`body.classList.contains('collapsed')` で足りる(現状 `body` はコンストラクタのローカル変数
なので、フィールドに保持する必要がある)。左右レールごと畳んだ場合
(`.hud-rail.collapsed > .panel { display: none }`)も同様。

`setVisible()` 側は問題ない — `map-picking.ts:545,550` が `overviewMode` で
`setVisible` と `sync` の両方を切っている。

### 3.2 [確認] `orderStillSorted()` が毎フレーム数百回の正規表現を実行する

`sync()` は区画ごとに `orderStillSorted(section.order.ids, ...)` を呼ぶ
(`physical-object-list-panel.ts:294`)。これは `ids` を舐めて隣接ペアに `compare()` を掛ける
(`physical-object-list-order.ts:108-117`)。

`compare()` は毎回 `lagrangeSortKey(a.id)` と `lagrangeSortKey(b.id)` を無条件に呼び、
`/^(.+)-l([1-5])$/.exec()` を実行して**マッチすればオブジェクトを新規割り当てする**
(`physical-object-list-order.ts:37-40, 159-160`)。

天体区画の ids が 300 件なら、**毎フレーム 600 回の `exec` と、ラグランジュ点の数だけの
オブジェクト割り当て。** 2.1 の「GC を抑える」という主張と正面から矛盾する。

id は不変なので、`lagrangeSortKey` の結果は id をキーにキャッシュできる(あるいは
`ObjectPickable` 側に持たせる)。

### 3.3 [確認] `syncRow()` が行ごとに `new Set` を作る

```ts
const seen = new Set<string>();
```
(`physical-object-list-panel.ts:420`)

再帰する行ごと・毎フレーム。scratch を7本も並べているファイルの中で、ここだけ素朴に確保して
いる。再帰なので単純な単一 scratch では置けない(スタックが要る)が、子 id の配列を舐めるだけ
なら Set を使わず `children.includes(id)`(子は通常1桁〜十数件)でも足りる。

### 3.4 [確認] `syncHeader()` が無条件に `textContent` を書き換える

```ts
section.header.textContent = `${label} (${ids.length})${state} ${section.expanded ? ... : ...}`;
```
(`physical-object-list-panel.ts:359`)

同ファイルの行側は `if (node.label.textContent !== item.name)` と比較してから書いている
(401, 403行)のに、見出しだけ比較なし。区画6つ × 毎フレームのテンプレート文字列生成 + 代入。

### 3.5 [確認] 検索中は `matches()` が毎フレーム大量に文字列を割り当てる

```ts
if (this.query && !`${item.name} ${item.detail ?? ''}`.toLocaleLowerCase().includes(this.query)) return false;
```
(`physical-object-list-order.ts:69`)

テンプレート文字列 + `toLocaleLowerCase()` で毎回2つの文字列を作る。`matches()` が1フレームに
呼ばれる回数:

- `refreshInputs()` — 全 `items` に1回ずつ(`physical-object-list-order.ts:86`)
- `rebuildOrder()` — 組み直した区画の全 `items` に1回ずつ(126行)
- `syncRow()` — **表示中の全行に1回ずつ**(`physical-object-list-panel.ts:408`、`cluster` クラスの判定)

検索語が空のときは短絡するので割り当ては起きない。**検索中だけ、行数の2〜3倍の文字列が毎フレーム
生成される。** 小文字化した検索対象を `ObjectPickable` 側かキャッシュに持つのが素直。

なお `syncRow()` の `cluster` 判定は、`filter === 'satellite'` のとき以外は常に `matches()` が
真になる行しか描かれない(`rebuildOrder` が一致行しか `ids` に積まないため)。**クラスタ親を
補う経路でしか意味が無い判定を、全行に毎フレーム掛けている。**

### 3.6 [確認] `body` の `detail` が作られて捨てられる

`object-pickables.ts:174` は body ごとに
`` `${fmtDist(d)} · ${celestialBodyName(strongestAttractor(...).id)}` `` を毎フレーム組み立てる。
一覧側は `item.kind === 'body' ? '' : (item.detail ?? '')`(`physical-object-list-panel.ts:402`)
で無条件に捨て、`detail` 要素自体も `hidden` にする(404行)。

`detail` に他の消費者が居るかは未確認なので、**一覧のためだけに作られているなら無駄**という
条件付きの指摘。ただし 3.5 のとおり `matches()` は `detail` を検索対象に含めるので、天体の
`detail` は「表示はしないが検索には効く」状態にある。**これは仕様として意図されたものか要確認**
— 距離文字列 `1.2 au` が検索に引っかかるのは、たぶん意図ではない。

---

## 4. 操作・見た目

### 4.1 [確認] 行の展開トグルがキーボードから操作できない

```ts
const toggle = document.createElement('span');
toggle.className = 'physical-object-list-toggle';
...
toggle.addEventListener('click', ...);
```
(`physical-object-list-panel.ts:443-444, 487-491`)

`<span>` に `click` リスナーだけ。`tabIndex` も `role` も `aria-expanded` も無い。
**キーボードだけの利用者は個別の行を開閉できない**(「全展開 / 全折りたたむ」の一括操作しか
手が無い)。行本体は `tabIndex=0` / `role="button"` を持っているのに、その中のトグルだけが
到達不能。

`aria-expanded` は区画見出しには付いているが(`applyExpanded()` 523行)、行トグルには無い。

### 4.2 [確認] 区画見出しに `aria-controls` が無い

`header.setAttribute('aria-expanded', ...)` はあるが、どの要素を制御しているかの関連付けが無い
(`physical-object-list-panel.ts:190-191, 523`)。`sectionBody` に id を振って `aria-controls` を
足す。**このパネルだけが欠いている** — `hud-root.ts:129`・`view-options-panel.ts:378`・
`orbit-guide-tab.ts:184`・`base-view.ts:345` はいずれもトグルと対象を `aria-controls` で
結んでいる。

行トグルの `aria-expanded` についても `windows/property-window.ts:334, 385` に前例がある。

また見出しは `textContent` に折りたたみグリフ(`▾`/`▸`)を含めているので、読み上げに記号が
混ざる。グリフを別 `<span aria-hidden>` に出すか、`aria-label` で上書きする。

### 4.3 [確認] 単クリックで何も起きない — 仕様どおりだが、選ばれている行が見えない

`DEVELOP/SPEC/MAP.md:527-529` は「行クリックは何もしない(選択状態は持たない)。ダブルクリックは
その対象へマップ視点のフォーカスを移す。右クリックはその対象のプロパティウィンドウを開く。」と
明記しており、`edd17a0f`(選択機能の削除)で意図的にそうなった。**仕様違反ではない。**

ただし行は `tabIndex=0` を持つので、実際にはクリックでキーボードフォーカスが当たり、そこから
`F` / `T` が効く。**その「いま効く行」が視覚的に分からない** — `:focus-visible` のアウトライン
(`map-view-style.ts:179`)はマウスクリックでは出ないため。`title` に
`'ダブルクリック / F: フォーカス · T: ナビ対象'` と書いてあっても、どの行に効くのかが見えない。

`:focus` にも弱い表示を足すか、選択状態を復活させるか。後者は一度捨てた設計なので**ユーザーの
判断が要る。**

### 4.4 [確認] `T`(ナビ対象)のマウス経路は右クリック2段階でしかない

`onNavTarget` はキーボードの `T` からしか呼ばれない(`physical-object-list-panel.ts:469`)。

マウス経路が皆無なわけではない — 行を右クリック → プロパティウィンドウ → 「対象」項目、で
`navTarget.toggleTarget` に届く(`map-picking.ts:1308, 1317`、`targeter.ts:57-58` の
コメントがこの経路を正本として説明している)。ただし**2段階**で、一覧の上には手掛かりが無い。

`title` 属性(`physical-object-list-panel.ts:462`)は `T: ナビ対象` と書いているのに、
マウスだけでその1操作に相当するものが一覧上に無い。行のホバー時に小さなボタンを出すか、
`title` の書き方を実態に合わせるか。

### 4.5 [確認] フィルタはトグル、並び順はトグルしない — 同じ見た目で挙動が違う

```ts
const filterControl = new SegmentedControl(..., (key) => {
  this.order.filter = this.order.filter === key ? null : key;   // 同じキーで解除
  ...
});
const sortControl = new SegmentedControl(..., (key) => {
  this.order.sort = key;                                        // 解除できない
  ...
});
```
(`physical-object-list-panel.ts:155-167`)

同じ `SegmentedControl` が並んでいるのに、上段だけ「もう一度押すと解除」。並び順は常に1つ選ぶ
ものなので挙動自体は妥当だが、**見た目から区別できない。** フィルタ側に「すべて」の選択肢を
明示的に置くほうが素直。

### 4.6 [確認] 高さ制御は入っている。足りないのは区画見出しの固定と内側のスクロール連鎖対策

パネルは高さ上限と独立スクロールを持つ:
- `#hud-physical-object-list { max-height: min(544px, 60dvh); display:flex; flex-direction:column; overflow:hidden; }`(`panel-content-style.ts:93`)
- `.physical-object-list-head { flex:0 0 auto; max-height:50%; overflow-y:auto; }`(同 95行)
- `.physical-object-list-body { flex:1 1 auto; overflow-y:auto; }`(同 96行)
- マップスキンでは `min(576px, 64dvh)`(`map-view-style.ts:115`)、狭い画面では
  `--rail-panel-max-h`(`map-view-style.ts:55-62`)

残る不足は2点:

1. **区画見出しが `position: sticky` でない。** 全展開して数百行をスクロールすると、いま
   どの区画を見ているか分からなくなる。
2. **内側のスクロール要素に `overscroll-behavior` が無い。** 外側の `.hud-rail` にだけ
   `overscroll-behavior: contain` が付いている(`hud-layout-style.ts:91`)。一覧本体の
   上端/下端に達した状態でさらにスクロールすると、**レール全体が動き出す**(スクロール
   チェイニング)。同じ対策が外側にある以上、内側にも要る。

### 4.7 [確認] タップターゲットが44pxに満たない

`UI-DESIGN.md` §6「タップターゲットは最小44px。タッチ環境でだけ、要素自身の寸法でこの最小寸法を
確保する」に対し:

- `.erow` は基調スキンで `min-height` 指定なし(`panel-content-style.ts:115`)。マップスキンでも
  `min-height: var(--row-min-h-s)` = 28px(`map-view-style.ts:170`、`layout-tokens.ts:15`)。
- `.physical-object-list-toggle { width: 10px; }`(`panel-content-style.ts:122`)。
  **展開トグルの当たり判定が10px幅。**
- `@media ${MQ_COARSE}` で `--hit-target-min` を足している箇所がこのパネルには無い。
  他パネルは足している(`panel-content-style.ts:140-143` の `body-class-icon-btn`、
  同 355-357 の `#hud-help .help-close-button`)。

### 4.8 [確認] 区画・行の開閉がリロードで失われる

パネル全体の折りたたみは `wirePanelCollapse(storageId: 'hud-physical-object-list')` で
localStorage へ永続する(`panel-shell.ts:127-139`)のに、**区画6つの開閉と行の開閉は毎回リセット
される。** 同じパネルの中で永続する層としない層が混ざっている。

区画の開閉くらいは永続してよいはず(行は数百あるので全部持つのは筋が悪い)。

### 4.9 [確認] 絞り込み無しで0件のときは何も出ない

```ts
this.emptyState.classList.toggle('hidden', !(filteringActive && totalMatched === 0));
```
(`physical-object-list-panel.ts:313`)

絞り込みをしていない状態で候補が0件だと、見出しも空状態も出ない**完全に空のパネル**になる。
起動直後や、可視性規則で全部隠れているときに起こりうる。

---

## 5. 追加を検討したい機能

いずれも仕様(`DEVELOP/SPEC/MAP.md` §10)には無い。**足すなら先に `/modify-feature` で SPEC を
書く。** ここでは案として並べるだけ。

- **矢印キーでのツリー移動。** `role="button"` の行を並べる代わりに `role="tree"` /
  `role="treeitem"` / `role="group"` / `aria-level` にし、↑↓ で移動、→ で開く、← で閉じる、
  という WAI-ARIA の標準操作を入れる。現状は Tab で全行を1つずつ辿るしかない(全展開時は数百回)。
  なお `role="tree"` はコードベース全体で1件も使われていないので、**このプロジェクトに前例の
  無いパターンを持ち込むことになる。** 4.1(トグルがキーボードから触れない)だけなら、
  行の Enter/Space で開閉する小さな対応でも埋まる。
- **ナビ対象の視覚表示。** `T` で設定できるのに、一覧上でどれがナビ対象かが分からない。
  `UI-DESIGN.md` はターゲットに第二アクセント色を割り当てているので、`tgt`(実際はフォーカス)
  とは別のクラスが要る(1.7 と併せて整理する)。
- **検索の一致箇所ハイライトと件数表示。** 現状は一致しない行が消えるだけで、何件出ているかは
  区画見出しの `(N)` を足し算しないと分からない。
- **距離を独立した列にする。** 現状は `detail` の文字列に距離が埋め込まれ、天体では捨てられて
  いる。「近さ」で並べているのに距離が見えないのは不便。
- **行の仮想化。** 数百行を常時 DOM に置き、毎フレーム全部を `syncRow()` に通す必要はない
  (3節)。ただし 1.1 / 1.2 を直して行の再生成を減らすほうが先で、それだけで足りる可能性が高い。

---

## 6. 廃止・削除の候補

| 対象 | 位置 | 理由 |
| --- | --- | --- |
| `RowNode.savedExpanded` / `matchAncestors` / `restoreSavedExpanded()` | panel 88-90, 274-287, 341-346, 413-416 | 1.1 — 動作しない機構 |
| `related-orbit` クラス(TS + CSS) | panel 406 / `map-view-style.ts:176-178` | 1.7 — `tgt` と完全重複 |
| `OBJECT_GLYPHS` の `apsis`/`relnode`/`eqnode`/`empty-space` | panel 63-66 | 2.7 — 到達しない |
| `lagrangeSortKey()` の独自正規表現 | order 37-40 | 2.6 — `object-groups.ts` へ寄せる |
| `physical-object-list-name` クラス | panel 449 | 2.11 — 対応する CSS 規則が無い |
| `compare()` の `priority` 分岐 | order 154-155 | [推測] 区画ごとに分けて整列するので、`priority` に差がつくのは同一区画内だけ。`player` 区画は通常1件なので効いていない可能性が高い。要確認 |

---

## 7. 仕様(`DEVELOP/SPEC/MAP.md` §10)との差

`MAP.md` にも `UI-DESIGN.md` にも「未確定の案」節は無い。

- **食い違い**: 1.6(自艦ダブルクリックで操作対象が切り替わらない)。
- **実装が仕様の記述を超えている**(未実装ではなく逆方向):
  - 「RCS燃料」区画。`MAP.md` §10 は「天体/自艦/敵/弾薬/基地の**5区画**」と書くが実装は6区画
    (`physical-object-list-panel.ts:18-25`)。`861c5564`(RCS 燃料の回収)で足されたときに
    SPEC が更新されていない。`filter === 'artifact'` の対象種別も、仕様の3種に対し実装は
    `player/ammo/fuel/base` の4種(`physical-object-list-order.ts:71-73`)。
  - 行のキーボードショートカット `F` / `T`。`MAP.md` §10 は行の操作をクリック/ダブルクリック/
    右クリックの3つしか列挙していない。`SPEC/` 全体に「ナビ対象」「NavTarget」の語が無い。

どちらも SPEC 側を実装に合わせて更新するのが妥当に見えるが、**SPEC は `/modify-feature` で
ユーザーと合意して書くもの**なので、この点検では触っていない。

---

## 8. 着手順の提案

**最優先(実害があり、修正が小さい)**

1. **1.4** — `F` キーの二重発火。行の keydown で `stopPropagation()` + 修飾キーの防御。数行。
2. **1.3** — ツリー操作ボタンを `sectionBody` の中へ移す。1行の移動。
3. **1.7** — `related-orbit` を消して `tgt` に寄せる(名前が意味を裏切っている件は別途)。
4. **3.1** — 畳んでいるときの早期 return。効果が大きい。

**次(構造を軽くする)**

5. **1.1 → 1.2** — 死んだ展開ポリシーを落とし、行ツリーの同一性を `rootIds` ではなく
   「今フレームの全表示 id」で保つ prune へ変える。ここを直すと 2.8 の分割が一気に楽になる。
6. **2.8** — `PhysicalObjectListRowTree` / `PhysicalObjectListHead` への分割。
   同時に 2.1〜2.3 の規約違反(scratch・共有バッファ返却・平行配列)を片付ける。

**独立して進められる**

7. **2.5** — `MapPickKind → グリフ` の共通化。CODING-RULE 1.5 の決め手が Yes に倒れる。
8. **1.9 / 1.10 / 4.1 / 4.2 / 4.7** — 生の入力欄への置き換え、インライン style のクラス化、
   行トグルのキーボード到達性、`aria-controls`、44px。いずれも `/ui-design` を通す。

**仕様判断が要る(先に `/modify-feature`)**

9. **1.5**(`pickable` を一覧でも見るか)/ **1.6**(自艦の分岐を揃えるか)
10. **4.3 / 4.4 / 4.5 / 4.8 / 4.9** と **5節** の全部。

## 9. まだ確認していないこと

- 3.6 の `body.detail` に一覧以外の消費者が居るか。
- 1.2 後半([推測])の「可視性の変化で枝が畳まれる」の実機再現。
- タッチ環境での右クリック相当。行の `contextmenu`(`physical-object-list-panel.ts:471-474`)は
  ブラウザネイティブの長押し合成に依存している。ゲーム独自の長押し合成
  (`input/input.ts:87-92, 327-339`)は 3D キャンバスにしか張られておらず HUD には効かない。
  これは HUD 全体で一貫した設計(`windows/property-window.ts:359-363` も同じ)なので本パネル
  固有の欠陥ではないが、iOS Safari での実機挙動は確認していない。
- 4.1 の `role="tree"` 化を実際に採るかどうか(前例が無い)。
