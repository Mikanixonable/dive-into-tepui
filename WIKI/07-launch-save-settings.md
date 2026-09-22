# 07. 起動・保存・設定

`src/launcher/` と `src/settings/` は、1ランの外側を担当します。ゲームモデルだけ読んでいると見落としやすいですが、**「どのランを始めるか」「どのセーブを使うか」「ランを跨いで何を残すか」**は別の寿命を持つ問題です。

## 1. launcher はランの外側

launcher の責務は、

- タイトル画面
- ステージ選択
- 開始時刻選択
- セーブスロット
- スナップショット
- 自動保存
- 結果画面
- 解放状況
- ランの開始・終了
- エラー画面

です。

Game が「一回のラン」なら、Launcher は「どのランをいつ起動するか」を扱います。

## 2. Launcher と Game の依存方向

Launcher は Game を作るため、game を import できます。

逆に Game が Launcher を import すると、ラン内部のロジックが、

- セーブスロット
- URL
- タイトル画面
- 次のラン

を知ることになり、寿命が混ざります。

そのため依存は launcher → game の向きです。

## 3. タイトル画面

`title-scene.ts` と `stage-select.ts` が、ゲーム開始前の画面を構成します。

ここでは、

- タイトル 3D 表現
- ステージ一覧
- セーブ状況
- 開始操作

などを扱います。

README の配色はこのタイトル画面のテーマを参照しています。

## 4. stage select

ステージ選択は単なるボタン一覧ではなく、

- 解放状態
- 再開可能状態
- CREATIVE
- 開始日時
- スロット

などと関係します。

選んだ結果を Run / Game の生成へ渡し、以後のステージ進行は Game 側へ移ります。

## 5. start epoch

`start-epoch-form.ts` は、開始時刻を指定する UI の入口です。

天体暦を使うゲームでは「いつ始めるか」が、

- 月位置
- 太陽方向
- 天体配置
- 影
- ラグランジュ点の ECI 状態

へ影響します。

そのため時刻は単なる演出パラメータではありません。

## 6. Run.create と Run.resume

Launcher からは、新規ランと復元ランで入口が分かれます。

### 新規

`Run.create()`

### 復元

`Run.resume()`

どちらも最終的には Game と GamePresentation を組み、同じフレームループへ入ります。

## 7. セーブの基本方針

セーブするのは**作り直せないモデル状態**です。

保存対象の例:

- シミュレーション時刻
- 動的エンティティ
- 船体状態
- 時間加速
- ステージ状態
- 操作対象
- 軌道計画
- セーブごとの Viewer

保存しないものの例:

- GPU texture
- Three.js Mesh
- DOM element
- 一時通知
- 一時ドラッグ状態
- 再生成可能な軌道線

## 8. save-store

`launcher/save/save-store.ts` は、保存先とのやり取りを扱います。

ブラウザ環境では localStorage 等が使われますが、上位層が保存媒体の細部へ依存しすぎないようにします。

## 9. save-slots

`save-slots.ts` は複数スロットを扱います。

スロットは単なる「ファイル名」ではなく、

- 現在アクティブ
- ステージ
- 最新スナップショット
- メタ情報

などの管理単位です。

## 10. slot-data

`slot-data.ts` は、スロットに保存されるメタデータや版を扱う入口です。

セーブ形式は将来変わるため、保存形式の版と復元側の後方互換が重要になります。

## 11. snapshot-service

`snapshot-service.ts` は、その瞬間の Run を保存可能な記録へ変換します。

Run が `SnapshotSource` を実装しているため、保存側は Game の内部フィールドを一つずつ読みに行かずに済みます。

## 12. autosave

`autosave.ts` は、一定条件で自動保存を行います。

自動保存で重要なのは、

- 毎フレーム保存しない
- 進行中の半端な状態を取らない
- 保存処理が描画を長時間止めない
- ラン切替時に古い保存を書き戻さない

ことです。

## 13. save-transfer

`save-transfer.ts` は、セーブデータのエクスポート / インポートを扱います。

localStorage はブラウザデータ削除で消える可能性があるため、外部へ持ち出せることが重要です。

## 14. 復元

復元では、

1. セーブ記録を読む
2. 版・構造を検証
3. StageClass を解決
4. Game.deserialize
5. Viewer を復元
6. 表示資源を新規構築
7. Run を開始

という考え方になります。

描画オブジェクトを「凍結して保存」する方式ではありません。

## 15. 復元時の元期

保存された `simTime` は、ある元期からの経過秒です。

別の元期で同じ simTime を使うと、月・太陽などの絶対配置が変わります。

そのためセーブは、天体暦の文脈も保持する必要があります。

## 16. UserSettings

`src/settings/user-settings.ts` はアプリ寿命の設定正本です。

代表的には、

- graphics
- renderStyle
- BGM volume
- mute
- theme palette
- map display toggles
- celestial grid visibility
- HUD panel collapsed
- selected UI tabs

などを持ちます。

## 17. SettingValue

`setting-value.ts` は「現在値を持ち、変更を通知できる設定」の抽象です。

上位は localStorage の詳細ではなく SettingValue を読むことで、設定の保存先と利用側を分離できます。

## 18. StoredSetting

`stored-setting.ts` は、値を文字列へ変換して保存媒体へ保持する実装です。

各設定には、

- parse
- format
- storage key

があります。

### parse / format を分ける理由

保存形式が文字列でも、ゲーム内では boolean、number、構造体などとして扱いたいためです。

## 19. 設定キーは互換性

localStorage のキーを変更すると、既存ユーザーの設定が読めなくなります。

そのためキー文字列は単なる内部実装ではなく、事実上の永続化契約です。

## 20. 旧設定の移行

UserSettings には legacy key からの読み込みがあるものがあります。

これは、保存形式を更新しても既存環境を壊さないための移行処理です。

## 21. Viewer と Settings の境界

よく混乱する部分です。

### Viewer

そのセーブで何を見ているか。

- カメラ
- 注視対象
- ビュー
- 軌道基準
- 予測表示の時間範囲

### Settings

どのセーブでも共通にどう見せたいか。

- テーマ
- 描画品質
- BGM 音量
- HUD パネルの共通選択
- 表示トグル

## 22. 結果画面

`result-screen.ts` はラン終了後の UI です。

勝敗判定そのものは Stage / Game 側ですが、結果をどう見せ、次のランへどう遷移するかは launcher 側の責務です。

## 23. unlock manager

`unlock-manager.ts` は、ランを跨いだ解放状況を扱います。

これは一回の戦闘中のモデル状態ではないため、Game ではなく launcher 寿命に属します。

## 24. スロット切替

スロットを切り替えるときは、現在 Run を畳んでから次の起動先を決めます。

一つの Run を使い回して内部だけ差し替えるより、

- dispose
- 新規 / resume
- warm up

を通す方が、表示資源や所有関係をきれいに再構築できます。

## 25. failure path

起動・復元に失敗した場合は `fatal-error.ts` などを使ってエラーをユーザーへ示します。

ゲーム開始前の障害を Game 内の通知機構へ無理に通す必要はありません。

## 26. 保存変更で壊しやすい点

### 新しい正本を serialize し忘れる

プレイ中は動くが、ロードすると初期値へ戻ります。

### 導出値を保存する

古いキャッシュが復元され、現在の正本と不整合になります。

### storage key を変更

既存ユーザーの設定が消えたように見えます。

### Viewer と Settings を間違える

セーブを切り替えたのにカメラが残る、逆にテーマがセーブごとに変わる、といった挙動になります。

## 27. コードを読む順番

### ライフサイクル

1. `launcher.ts`
2. `stage-select.ts`
3. `../run/run.ts`
4. `result-screen.ts`

### セーブ

1. `save/slot-data.ts`
2. `save/save-store.ts`
3. `save/save-slots.ts`
4. `save/snapshot-service.ts`
5. `save/autosave.ts`
6. `save/save-transfer.ts`

### 設定

1. `../settings/setting-value.ts`
2. `../settings/stored-setting.ts`
3. `../settings/user-settings.ts`

---

<p align="center">
  <a href="06-spacecraft-combat.md"><strong>← 06. 船体・戦闘</strong></a>
  ·
  <a href="README.md"><strong>WIKI 目次</strong></a>
  ·
  <a href="08-development-workflow.md"><strong>08. 開発方針 →</strong></a>
</p>
