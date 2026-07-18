# iOS Safari 技術検証レポート(スプリント1 / 担当: レン)

対象: spoon_teiki_studio.html v3.3 の I/O 層。現行コードの該当箇所を読み、iOS Safari(iOS 15以降を想定)での可否と対処方針をまとめる。
記号: ✅=現行コードのままで動く見込み / ⚠️=修正または条件あり / 📱=実機確認が必須(机上では確定できない)

## 1. クリップボード(コピー→Spoonへ貼り付け)

現行実装: `navigator.clipboard.writeText(...)` をボタンの click ハンドラ内で同期的に呼んでいる(btnCopy: 1901行 ほか)。

- ✅ iOS Safari 13.1+ で `clipboard.writeText` は利用可能。**ユーザー操作(タップ)起点で同期的に呼ぶ**という制約を現行コードは既に満たしている。
- ⚠️ **HTTPSが必須**(secure context)。`file://` や平文HTTPでは `navigator.clipboard` が undefined になる。GitHub Pages は HTTPS なので本番は問題なし。ローカル検証は `localhost` 扱いになる開発サーバーを使うこと。
- ⚠️ 失敗時のフォールバックが現状ない。`writeText` の Promise 拒否時に「長押しでコピーしてください」と全文を選択状態で表示するテキストエリアを出す保険を次スプリントで追加したい。
- 📱 点字空白(U+2800)・ハングルフィラー(U+FFA0)が**クリップボード経由で欠落しないか**、実機で Spoon アプリに貼って確認(ユズのチェックリスト項目)。

## 2. プロジェクト保存(.song.json / .json のダウンロード)

現行実装: Blob + `a.download` + `a.click()`(1879行〜)。

- ✅ iOS 13+ の Safari は `a[download]` に対応。タップするとダウンロードされ、ファイルApp の「ダウンロード」に保存される。
- ⚠️ iOS はダウンロード時に確認ダイアログ(「"◯◯"をダウンロードしますか?」)を出す。ユーザー操作起点の同期呼び出しなら出るが、**非同期処理の後に a.click() するとブロックされることがある**。現行は同期なのでOK。この構造を今後も崩さないこと。
- 代替案: `navigator.share({files: [...]})`(iOS 15+)なら共有シートから「ファイルに保存」を選べて体験が良い。次スプリントで「保存」ボタンに share 優先+download フォールバックの二段構えを提案。
- 📱 `.song.json` という二重拡張子のファイルが、後述の読込 input(accept=".json")で選択可能かを実機で確認。

## 3. プロジェクト読込

現行実装: `<input type="file" accept=".json">`(240行)+ FileReader。

- ✅ input[type=file] はファイルApp のピッカーを開く。FileReader.readAsText も問題なし。
- ⚠️ iOS はカスタム拡張子の accept 指定に弱い。`accept=".json"` で `.song.json` がグレーアウトされる場合に備え、`accept="application/json,.json"` への変更、それでもダメなら accept 撤廃を検討。📱 実機で要確認。

## 4. 画像→点字アートの取り込み

現行実装: `<input type="file" accept="image/*">`(436行)+ canvas で画素読み取り。

- ✅ `accept="image/*"` のタップで「フォトライブラリ / 写真を撮る / ファイルを選択」が出る。写真ライブラリ連携は追加実装なしで得られる。
- ✅ HEIC写真は input 経由で渡される時点で iOS が JPEG に変換するのが既定挙動。📱 念のため実機の実写真で1回確認。
- ✅ アートのマス目は小さく(数十×数十ドット)、iOS Safari の canvas 面積上限(約16Mピクセル)には遠く及ばない。
- ⚠️ 巨大画像(48MP等)を読み込んだ場合の縮小処理が現行にあるか未確認 → 次スプリントでコード確認し、必要なら読み込み時に最大辺を制限。

## 5. Service Worker / ホーム画面追加(PWA)

- ✅ iOS 11.3+ で Service Worker 対応。ホーム画面に追加した Web アプリでもオフラインキャッシュが効く。
- ⚠️ manifest の `display: "standalone"` の完全対応は iOS 15.4 以降。それ以前も `apple-mobile-web-app-capable` メタタグで代替可能 → 両方入れる(コトハのPWA骨組みで対応済みにする)。
- ⚠️ Safariの「7日間未使用でサイトデータ削除」(ITP)は、**ホーム画面に追加したPWAには適用されない**が、Safariタブで使い続けた場合は適用されうる。プロジェクトはlocalStorage任せにせず「保存ボタンでファイル保存」を正とする現行設計を維持する。
- 📱 「ホーム画面に追加」→アイコン起動→機内モードで起動、の一連を実機で確認。

## 6. その他の注意(サクラのタッチ実装と共有)

- 本体は既に Pointer Events で統一されており、iOS のタッチは pointerdown/move/up として届く。ただし **`touch-action: none` を指定していない要素はドラッグ中にページスクロールが横取りする**。ドラッグ対象(.elem)への指定が必須(サクラが対応)。
- 長押し時に iOS 標準のコンテキストメニュー/テキスト選択が出るのを防ぐため `-webkit-touch-callout: none` と `-webkit-user-select: none` が必要(サクラ)。
- `navigator.vibrate` は iOS Safari 非対応。長押しのフィードバックはビジュアル(トースト等)で行う。

## 結論

**フェーズ1(PWA)を妨げる致命的な非対応は無い。** 現行コードはクリップボード・保存・読込とも「ユーザー操作起点の同期呼び出し」という iOS の作法を偶然にもほぼ満たしている。要修正は (a) touch-action 等のCSS(サクラ)、(b) accept属性の実機確認、(c) コピー失敗時フォールバック(次スプリント)。📱印5件は実機検証チェックリスト(ユズ)に登録する。
