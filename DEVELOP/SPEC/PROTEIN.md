# タンパク質型の敵

タンパク質型の敵は、実在する立体構造をもとにした表示と、機能部位を個別に破壊できる戦闘状態を持つ。
構造の微細な揺らぎは表示上の生命感を与えるが、ゲームの軌道・衝突・命中判定を変更しない。

## 表示

- リボンは Cα 主鎖を N 末端から C 末端へ辿る。鎖の境界と構造データの欠損だけを切断し、二次構造の
  境界では中心線を連続させる。
- αヘリックスは幅 2.0 Å、厚さ 0.4 Å の扁平な oval、βストランドは幅 2.0 Å、厚さ 0.4 Å の
  rectangle とする。βストランドの C 末端側は最後の2残基で最大2倍へ広がって矢印へ収束する。
- coil は直径 0.4 Å の円形 rope とする。oval と rope の断面は12分割し、中心線は1残基あたり12分割する。
- リボン断面の幅方向はカルボニル酸素の方向を優先して定め、退化した箇所では鎖に沿って平行移動する。
  隣接断面が反転してはならない。
- リボンは金属的でないマットな陰影とし、表面の色は鎖別、B-factor、entity、rainbow、二次構造、
  構成要素、論文調から選べる。分子模型は元素色、シルエットは表面の電荷または疎水性を使う。
- 表示形態を変えても、衝突形状は静止したリボン形状を使い続ける。表示用の表面、原子、リボンの微細な
  変位は衝突・命中判定へ反映しない。

## 構造の揺らぎ

- 揺らぎは構造データから求めた低周波の集団運動と残基単位の局所運動を重ね合わせる。
- 残基単位の変位は Cα の弾性ネットワークと B-factor 由来の RMSF を根拠にする。ヘリックス・シートの
  剛性の高い領域より、ループ・末端の変位が大きく見える。
- 揺らぎは敵ごとに決定的な seed を持ち、表示時刻から再現できる。距離に応じて使うモード数と更新頻度を
  減らしても、近距離での構造の読み取りを損なわない。
- 同じ残基の変位は原子、結合、リボン、表面、部位マーカー、修飾マーカーへ対応付ける。部位の発射位置も
  対応する残基の平均変位に追従する。
- 敵の integrity、軌道、衝突形状、弾の命中判定は揺らぎから独立している。
- integrity が critical フェーズへ入ったときは、表示上の揺らぎだけを増幅する。物理的な振幅や衝突形状を
  増幅してはならない。

## 戦闘状態

- タンパク質敵は、構造全体の integrity と、複数の機能部位の HP を持つ。
- 機能部位は独立して損傷・無効化できる。無効化した攻撃部位は発射元の候補から外れ、残った機能部位が
  順番に攻撃を担当する。
- 部位への命中は部位の HP と構造全体の integrity の双方へ影響する。部位に依存しない命中と接触は
  integrity だけへ影響する。
- 構造全体の integrity が尽きたら撃破する。部位の破壊だけでは撃破としない。
- phase は `intact`、`exposed`、`dissociated`、`critical` のいずれかである。結合界面の無効化で
  exposed、結合界面と全攻撃部位の無効化で dissociated、核心部の無効化または integrity 25% 以下で
  critical へ遷移する。critical は表示揺らぎの増幅と構造状態の表示へ反映する。
- integrity が 65% 未満になった場合、修飾スロットは空状態になる。修飾状態は攻撃ダメージなどの効果へ
  反映される。
- integrity、部位 HP、phase、修飾状態はセーブ／ロードで保持する。旧形式の全体 health しかないデータは
  integrity の初期値へ変換する。

## タンパク質の追加手順

1. `assets-src/proteins/<id>/protein.config.json` と `protein.definition.json` を追加し、PDB ID、構造・
   backbone・motion・semantic の出力先、coordinate scale、機能部位、構成要素を定義する。
2. `node tools/protein-builder/fetch-pdb-backbone.mjs assets-src/proteins/<id>/protein.config.json` で
   PDB の Cα、カルボニル酸素、二次構造、B-factor を取り込む。
3. `npm run protein:generate-structure -- --network` で構造資産を生成する。Blender/Molecular Nodes の
   論文調 GLB が必要な場合は config の外部 exporter を実行する。
4. `npm run protein:generate` で semantic asset と残基 motion asset を生成し、
   `npm run protein:catalog` で登録カタログを更新する。
5. `npm run protein:validate`、`npm run protein:validate-structure`、`npm run protein:validate-motion`、
   `npm run typecheck`、`npm run render-lab:shot` を通す。生成された asset は Creative Stage のタンパク質
   一覧へ自動的に現れる。

## 未確定の案

- ATP合成酵素型の120°ステップ回転、キネシン型の歩行、ヘモグロビン型のアロステリック開閉を攻撃機構へ
  使う。実在の周期はゲームの秒スケールへ圧縮する。
- B-factor から求めた RMSF の大きいループを被弾しやすくし、ダメージ倍率を高くする。
- 部位命中時の integrity への部分ダメージを廃止し、部位破壊の順序戦略を強める。維持する場合は、部位と
  integrity の二層を併用する理由を別途確定する。
