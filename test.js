const { JSDOM } = require("jsdom");
const fs = require("fs");

const html = fs.readFileSync("spoon_teiki_studio.html", "utf-8")
  // 外部リソースはテストでは読まない
  .replace(/<link[^>]*>/g, "").replace(/<script src[^>]*><\/script>/g, "");

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;

// canvas 2d コンテキストのスタブ(jsdomにcanvas実装がないため)
const ctxStub = new Proxy({}, { get: (t, p) => {
  if (p === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
  return () => {};
}});
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.HTMLCanvasElement.prototype.toDataURL = () => "data:,";

// エラー収集
const errors = [];
w.addEventListener("error", e => errors.push(e.message));

// 読み込み完了を待たず即時実行されるので、この時点でグローバルにアクセス
const S = w.eval("state");
S.widthLock = 0; // 合成テストはロック無しの素の挙動を検証(ロックの効果は専用テストで)
const compose = w.eval("compose");
const chW = w.eval("chW");
const strW = w.eval("strW");

let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`✗ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}
function show(s){ return s.replace(/\u3000/g,"[全]").replace(/ /g,"[半]").replace(/\u2800/g,"[点]").replace(/\uFFA0/g,"[フ]"); }

console.log("=== 文字幅 ===");
eq("全角かな=2", chW("あ".codePointAt(0)), 2);
eq("半角英字=1", chW("a".codePointAt(0)), 1);
eq("点字=brailleW(1)", chW(0x2801), 1);
eq("点字空白=1", chW(0x2800), 1);
eq("全角スペース=2", chW(0x3000), 2);
eq("半角フィラー=1", chW(0xFFA0), 1);
eq("全角フィラー=2", chW(0x3164), 2);
eq("絵文字🦋=2", chW("🦋".codePointAt(0)), 2);
eq("結合文字=0", chW(0x0301), 0);
eq("strW 混在", strW("あa⠿ "), 2+1+1+1);

console.log("=== compose: Spoon仕様 ===");
// ケース1: 2行目に全角4文字分空けてテキスト、1行目は空
S.elements = [{id:1,type:"text",row:1,col:8,text:"わたし"}];
let c = compose();
eq("1行目(空)→半角フィラー", c.lines[0].text, "\uFFA0");
eq("2行目 行頭ギャップ8=全角SP×4", show(c.lines[1].text), "[全][全][全][全]わたし");
eq("行幅=8+6", c.lines[1].w, 14);

// ケース2: 1行目の行頭スペース無効 → 点字空白アンカー
S.elements = [{id:1,type:"text",row:0,col:8,text:"歌"}];
c = compose();
eq("1行目行頭→点字空白+残り(8-1=7→全角3+半角1)", show(c.lines[0].text), "[点][全][全][全][半]歌");
eq("半角使用でwarnHalf", c.lines[0].warnHalf, true);

// ケース3: 奇数ギャップで半角スペース
S.elements = [{id:1,type:"text",row:1,col:5,text:"声"}];
c = compose();
eq("ギャップ5=全角2+半角1", show(c.lines[1].text), "[全][全][半]声");

// ケース4: 同一行に2要素
S.elements = [
  {id:1,type:"text",row:1,col:0,text:"あい"},
  {id:2,type:"text",row:1,col:8,text:"うえ"},
];
c = compose();
eq("要素間ギャップ(8-4=4)=全角2", show(c.lines[1].text), "あい[全][全]うえ");

// ケース5: アート要素(2x1文字、右端の列は空白→トリム)
// bits: 4x4 (cols=2, rows=1)。左の文字だけ全ドットON
const bits = new Uint8Array(2*2*1*4);
for (let y=0;y<4;y++) for (let x=0;x<2;x++) bits[y*4+x]=1;
S.elements = [{id:1,type:"art",row:1,col:0,cols:2,rows:1,bits}];
c = compose();
eq("アート行: ⣿ + 末尾空白トリム", c.lines[1].text, "\u28FF");
eq("アート行幅=1", c.lines[1].w, 1);

// ケース6(v3.3で仕様変更): アート先頭列の空白は点字空白のまま残す
// (行ごとに空白の内訳が変わると、実機フォントで行ごとにズレて形が崩れるため)
const bits2 = new Uint8Array(2*2*1*4);
for (let y=0;y<4;y++) for (let x=2;x<4;x++) bits2[y*4+x]=1; // 右の文字だけON
S.elements = [{id:1,type:"art",row:1,col:0,cols:2,rows:1,bits:bits2}];
c = compose();
eq("アート左端は点字空白のまま(スペース化しない)", c.lines[1].text, "\u2800\u28FF");

// ケース7: 全部空のアート行 → フィラー行
const bits3 = new Uint8Array(2*2*2*8); // cols=2, rows=2, 全部0...上の行だけON
const W3 = 4;
for (let y=0;y<4;y++) bits3[y*W3+0]=1; // row0 の左文字の左列のみ
S.elements = [{id:1,type:"art",row:1,col:0,cols:2,rows:2,bits:bits3}];
c = compose();
eq("アート2行目(全空白)→フィラー行", c.lines[2].text, "\uFFA0");

// ケース8: 文字数カウント(サロゲート)
S.elements = [{id:1,type:"text",row:0,col:0,text:"𝟷𝟸"}];
c = compose();
eq("コードポイント数", c.cp, 2);
eq("UTF-16数(安全側)", c.u16, 4);

// ケース9: 改行を含む全文
S.elements = [
  {id:1,type:"text",row:0,col:0,text:"a"},
  {id:2,type:"text",row:2,col:0,text:"b"},
];
c = compose();
eq("3行(空行フィラー込み)", c.full, "a\n\uFFA0\nb");
eq("全文字数=5(改行2含む)", c.cp, 5);

console.log("=== 取り込みパーサー ===");
const ta = w.document.getElementById("importTa");
ta.value = "ㅤ\n　　わ た し\nあい　　　うえ\n";
w.document.getElementById("importOk").click();
const els = S.elements.map(e => ({row:e.row, col:e.col, text:e.text}));
eq("取り込み結果", els, [
  {row:1, col:4, text:"わ た し"},   // 全角SP2個=4unit、半角SP1個は字間として保持
  {row:2, col:0, text:"あい"},        // 全角SP3個=6unit≧3で分割
  {row:2, col:10, text:"うえ"},
]);
// 取り込み後の再合成が元のレイアウトを保つか
c = compose();
eq("再合成1行目", c.lines[0].text, "\uFFA0");
eq("再合成2行目", show(c.lines[1].text), "[全][全]わ[半]た[半]し");
eq("再合成3行目", show(c.lines[2].text), "あい[全][全][全]うえ");

console.log("=== フル曲: 取り込み分割 ===");
const song = w.eval("song");
const importSong = w.eval("importSong");
const seqText = w.eval("seqText");
const visCount = w.eval("visCount");
const allPages = w.eval("allPages");
const setMode = w.eval("setMode");
const moveBoundary = w.eval("moveBoundary");
const mergePages = w.eval("mergePages");
const splitPageAt = w.eval("splitPageAt");
const addWall = w.eval("addWall");
const removeWall = w.eval("removeWall");
const lineGlyphs = w.eval("lineGlyphs");
const switchPage = w.eval("switchPage");
const copyPrevLayout = w.eval("copyPrevLayout");
const placeAllTray = w.eval("placeAllTray");
const buildAllText = w.eval("buildAllText");
const buildSaveData = w.eval("buildSaveData");
const loadProjectData = w.eval("loadProjectData");
const curPage = w.eval("curPage");

importSong("あいうえおかきくけこ\nさしすせそ\n\nたちつてと", 7);
eq("ブロック数=2(空行で分割)", song.blocks.length, 2);
eq("ブロック1のページ数=3", song.blocks[0].pages.length, 3);
eq("P1=長行を7文字で途中切り", seqText(song.blocks[0].pages[0].seq), "あいうえおかき");
eq("P2=残り+行境界の改行付き", seqText(song.blocks[0].pages[1].seq), "くけこ\n");
eq("P3=次の行", seqText(song.blocks[0].pages[2].seq), "さしすせそ");
eq("P4=別ブロック", seqText(song.blocks[1].pages[0].seq), "たちつてと");
eq("歌詞数 [7,3,5,5]", allPages().map(p=>visCount(p.seq)), [7,3,5,5]);
{
  const g=song.blocks[0].pages[1].seq.filter(e=>!e.nl);
  eq("自動レイアウト行1 col=0,2,4", g.map(x=>[x.row,x.col]), [[1,0],[1,2],[1,4]]);
}

console.log("=== フル曲: モード起動と合成 ===");
setMode("song");
eq("songMode有効", song.active, true);
c = compose();
eq("現ページ合成: 行0=フィラー", c.lines[0].text, "\uFFA0");
eq("現ページ合成: 行1=歌詞", c.lines[1].text, "あいうえおかき");

console.log("=== フル曲: 境界の◀▶移動 ===");
moveBoundary(0,0,3); // ◀3 だがP2は最低1文字残す→2文字だけ移動
eq("P1へ2文字戻る(クランプ)", seqText(song.blocks[0].pages[0].seq), "あいうえおかきくけ");
eq("P2は1文字残る", visCount(song.blocks[0].pages[1].seq), 1);
moveBoundary(0,1,-3); // P2(1文字)から送るのは不可
eq("最低1文字ガード(送り)", visCount(song.blocks[0].pages[1].seq), 1);
moveBoundary(0,1,2); // P3の先頭2文字をP2へ
eq("P2=こ+改行+さし", seqText(song.blocks[0].pages[1].seq), "こ\nさし");
{
  const g=song.blocks[0].pages[1].seq.filter(e=>!e.nl);
  eq("改行またぎ再レイアウト(こ=行1/さし=行2)", g.map(x=>[x.row,x.col]), [[1,0],[2,0],[2,2]]);
}
eq("P3=すせそ", seqText(song.blocks[0].pages[2].seq), "すせそ");

console.log("=== フル曲: ロックガード ===");
song.blocks[0].pages[2].locked=true;
moveBoundary(0,1,1);
eq("ロック隣接境界は不変", seqText(song.blocks[0].pages[1].seq), "こ\nさし");
song.blocks[0].pages[2].locked=false;

console.log("=== フル曲: 統合・改ページ・壁 ===");
mergePages(0,1);
eq("統合後ブロック1=2ページ", song.blocks[0].pages.length, 2);
eq("統合テキスト(改行保持)", seqText(song.blocks[0].pages[1].seq), "こ\nさしすせそ");
{
  const p=song.blocks[0].pages[1];
  const nlIdx=p.seq.findIndex(e=>e.nl);
  w.eval("pushUndo")(); splitPageAt(0,1,nlIdx); w.eval("fixCur")();
}
eq("再分割後ブロック1=3ページ", song.blocks[0].pages.length, 3);
eq("再分割P2", seqText(song.blocks[0].pages[1].seq), "こ\n");
eq("再分割P3", seqText(song.blocks[0].pages[2].seq), "さしすせそ");
addWall(0,1,null);
eq("壁追加でブロック数=3", song.blocks.length, 3);
eq("新ブロックのページ", seqText(song.blocks[1].pages[0].seq), "さしすせそ");
removeWall(1);
eq("壁削除でブロック数=2", song.blocks.length, 2);
eq("壁跡は改行として残る", seqText(song.blocks[0].pages[1].seq), "こ\n\n");
eq("全ページ数=4のまま", allPages().length, 4);

console.log("=== フル曲: 行操作(縦書き/横書き) ===");
switchPage(2); // "さしすせそ" のページ
{
  const p=curPage();
  const lid=p.lineDefs[0].id;
  w.eval("selLine="+lid);
  w.document.getElementById("lnV").click();
  eq("縦書き: 全て同col・行が+1ずつ", lineGlyphs(p,lid).map(g=>[g.row,g.col]), [[1,0],[2,0],[3,0],[4,0],[5,0]]);
  eq("orient=v", p.lineDefs[0].orient, "v");
  w.document.getElementById("lnH").click();
  eq("横書きに戻す", lineGlyphs(p,lid).map(g=>[g.row,g.col]), [[1,0],[1,2],[1,4],[1,6],[1,8]]);
  w.document.getElementById("lnStair").click();
  eq("階段", lineGlyphs(p,lid).map(g=>[g.row,g.col]), [[1,0],[2,2],[3,4],[4,6],[5,8]]);
}

console.log("=== フル曲: 前ページの型をコピー ===");
{
  // P3(さしすせそ)を縦書きにして、P4(たちつてと)に型を写す
  const p3=allPages()[2];
  const lid=p3.lineDefs[0].id;
  w.eval("selLine="+lid);
  w.document.getElementById("lnV").click();
  switchPage(3);
  copyPrevLayout();
  const p4=curPage();
  const lid4=p4.lineDefs[0].id;
  eq("型コピー: orient=v", p4.lineDefs[0].orient, "v");
  eq("型コピー: 位置が前ページと同じ", lineGlyphs(p4,lid4).map(g=>[g.row,g.col]),
     lineGlyphs(p3,lid).map(g=>[g.row,g.col]));
}

console.log("=== フル曲: 待機トレイ(手を付けたページ) ===");
{
  eq("型コピー後のP4はtouched", allPages()[3].touched, true);
  switchPage(1); // "こ\n\n"
  const p2=curPage(); p2.touched=true;
  moveBoundary(0,0,-2); // P1末尾2文字をP2先頭へ
  const un=p2.seq.filter(g=>!g.nl&&!g.placed);
  eq("流入文字は未配置(待機)", un.map(g=>g.ch), ["く","け"]);
  eq("トレイ表示中", w.document.getElementById("trayBar").classList.contains("show"), true);
  placeAllTray();
  eq("まとめて配置で待機ゼロ", p2.seq.filter(g=>!g.nl&&!g.placed).length, 0);
}

console.log("=== フル曲: 一括テキストと保存往復 ===");
{
  const t=buildAllText();
  eq("一括テキストに①区切り", t.includes("━━━ ①/④ ━━━"), true);
  const before=allPages().map(p=>seqText(p.seq));
  const beforeFull=allPages().map(p=>w.eval("composeOf")(p.elements,p.seq).full);
  const {data,fname}=buildSaveData();
  eq("保存ファイル名は.song.json", fname.endsWith(".song.json"), true);
  loadProjectData(JSON.parse(JSON.stringify(data)));
  eq("読込後テキスト一致", allPages().map(p=>seqText(p.seq)), before);
  eq("読込後の合成一致", allPages().map(p=>w.eval("composeOf")(p.elements,p.seq).full), beforeFull);
}

console.log("=== フル曲: コピーで次ページへ自動送り ===");
let copiedText=null;
Object.defineProperty(w.navigator,"clipboard",{value:{writeText:t=>{copiedText=t;return Promise.resolve();}},configurable:true});
switchPage(0);
w.document.getElementById("btnCopy").click();

setTimeout(()=>{
eq("コピー内容=P1の合成", copiedText, w.eval("composeOf")(allPages()[0].elements, allPages()[0].seq).full);
eq("コピー後にP2へ自動送り", song.cur, 1);

console.log("=== フル曲: 1枚ものへ復帰 ===");
setMode("single");
eq("singleへ戻る", song.active, false);
eq("bodyクラス解除", w.document.body.classList.contains("songMode"), false);


console.log("=== v3: ものさしと横幅ロックバー ===");
w.eval("renderAll")();
{
  const ru=w.document.getElementById("ruler");
  eq("ものさしのマスが描画される", ru.children.length>0, true);
  w.eval("setWidthLock")(12);
  w.eval("renderAll")();
  eq("入力欄と連動", w.document.getElementById("setLock").value, "12");
  const h=w.document.getElementById("lockHandle");
  eq("バーのラベル=12", h.textContent, "12");
  eq("バーはoffでない", h.classList.contains("off"), false);
  eq("12マス目より先のものさしは薄色", ru.children[12].classList.contains("ov"), true);
  w.eval("setWidthLock")(0);
  w.eval("renderAll")();
  eq("解除でバーはoff表示", h.classList.contains("off"), true);
}

console.log("=== v3: 1文字ずつにばらす ===");
{
  S.elements=[]; S.halfRows=new Set(); S.selId=null; S.selIds=new Set();
  const e={id:S.nextId++,type:"text",row:2,col:4,text:"あい　う"};
  S.elements.push(e); S.selId=e.id;
  w.eval("renderAll")();
  eq("ばらすボタンが出る", w.document.getElementById("selSplit").hidden, false);
  w.document.getElementById("selSplit").click();
  const els=S.elements.filter(x=>x.type==="text");
  eq("空白は要素にならず3文字", els.map(x=>x.text), ["あ","い","う"]);
  eq("位置は元の並びを保持", els.map(x=>[x.row,x.col]), [[2,4],[2,6],[2,10]]);
  eq("ばらした文字が複数選択される", S.selIds.size, 3);
}

console.log("=== v3: まとめる/解除と矢印キー ===");
{
  w.document.getElementById("selGroup").click();
  const g=S.elements[0].grp;
  eq("全員に同じまとまり番号", S.elements.every(x=>x.grp===g), true);
  eq("groupIdsOfで一員から全員引ける", w.eval("groupIdsOf")(S.elements[1]).length, 3);
  // 矢印キー(複数選択のまま)
  const before=S.elements.map(x=>x.col);
  w.document.body.dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
  eq("→キーで全員+2", S.elements.map(x=>x.col), before.map(c=>c+2));
  w.document.body.dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));
  eq("↓キーで全員 行+1", S.elements.every(x=>x.row===3), true);
  // 半角許可行なら1刻み
  S.elements.forEach(x=>S.halfRows.add(x.row));
  const b2=S.elements.map(x=>x.col);
  w.document.body.dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));
  eq("半角許可行では1刻み", S.elements.map(x=>x.col), b2.map(c=>c-1));
  S.halfRows=new Set();
  // 解除
  w.document.getElementById("selUngroup").click();
  eq("まとまり解除", S.elements.every(x=>!x.grp), true);
}

console.log("=== v3: 中央寄せ ===");
{
  S.elements=[]; S.selIds=new Set(); S.selId=null;
  const e={id:S.nextId++,type:"text",row:0,col:0,text:"やあ"}; // 幅4
  S.elements.push(e); S.selId=e.id;
  w.eval("setWidthLock")(10); // 幅20unit
  w.eval("renderAll")();
  w.document.getElementById("selCenter").click();
  eq("幅ロック10の中央=col8", e.col, 8);
  w.eval("setWidthLock")(0);
}

console.log("=== v3: 記号一覧と最近使った20個 ===");
{
  w.document.getElementById("sideSymBtn").click();
  eq("モーダルが開く", w.document.getElementById("symModal").classList.contains("open"), true);
  const chips=w.document.querySelectorAll("#symBody .chip");
  eq("チップが100個以上ある", chips.length>100, true);
  const heads=[...w.document.querySelectorAll("#symBody h4")].map(h=>h.textContent);
  eq("実績あり枠が先頭側にある", heads[1].includes("実績あり"), true);
  // 入力小窓が開いているときはそこへ挿入
  w.eval("openPopover")(0,0,null);
  const star=[...chips].find(c=>c.textContent==="★");
  star.click();
  eq("チップクリックで入力欄へ挿入", w.document.getElementById("popText").value, "★");
  eq("最近使ったに入る", S.recent[0], "★");
  w.eval("closePopover")();
  w.document.getElementById("symClose").click();
  eq("閉じるで閉じる", w.document.getElementById("symModal").classList.contains("open"), false);
  // recent 20個上限
  for(let i=0;i<25;i++) w.eval("addRecent")(String.fromCharCode(0x2460+i));
  eq("最近使ったは20個まで", S.recent.length, 20);
}

console.log("=== v3: まとまりの保存往復 ===");
{
  S.elements=[
    {id:S.nextId++,type:"text",row:0,col:0,text:"A",grp:7},
    {id:S.nextId++,type:"text",row:0,col:2,text:"B",grp:7},
  ];
  S.nextGrp=8; S.selId=null; S.selIds=new Set();
  const {data}=w.eval("buildSaveData")();
  w.eval("loadProjectData")(JSON.parse(JSON.stringify(data)));
  eq("grpが保存往復で残る", S.elements.map(x=>x.grp), [7,7]);
  eq("nextGrpも復元", S.nextGrp, 8);
}


console.log("=== v3.1: アートの反転・90°回転(ドット演算) ===");
{
  S.elements=[]; S.selIds=new Set(); S.selId=null;
  // 2文字×1行 = 4×4ドット、左上に1点
  const bits=new (w.eval("Uint8Array"))(16); bits[0]=1;
  const a={id:S.nextId++,type:"art",row:0,col:0,cols:2,rows:1,bits};
  S.elements.push(a); S.selId=a.id;
  w.eval("openDotEditor")(a);
  eq("元画像なし → 自由回転スライダーは非表示", w.document.getElementById("dotAngleWrap").style.display, "none");
  w.document.getElementById("dotFlipH").click();
  eq("左右反転で右上へ", [a.bits[0],a.bits[3]], [0,1]);
  w.document.getElementById("dotFlipV").click();
  eq("上下反転で右下へ", [a.bits[3],a.bits[3*4+3]], [0,1]);
  const before={cols:a.cols,rows:a.rows};
  w.document.getElementById("dotRotR").click();
  eq("右90°で寸法が密度補正つきで変わる", [a.cols,a.rows], [3,1]);
  eq("回転後もドットが残る", [...a.bits].some(v=>v===1), true);
  // 反転は2回で元に戻る(可逆)
  const snap=[...a.bits];
  w.document.getElementById("dotFlipH").click();
  w.document.getElementById("dotFlipH").click();
  eq("左右反転2回=元どおり", [...a.bits], snap);
  w.document.getElementById("dotClose").click();
}

console.log("=== v3.1: 回転パラメータの保存往復 ===");
{
  S.elements=[{id:S.nextId++,type:"art",row:0,col:0,cols:2,rows:1,
    bits:new (w.eval("Uint8Array"))(16),underlay:"data:image/jpeg;base64,x",
    thr:180,rot:45,flipH:true,flipV:false,baseCols:2}];
  S.selId=null; S.selIds=new Set();
  const {data}=w.eval("buildSaveData")();
  w.eval("loadProjectData")(JSON.parse(JSON.stringify(data)));
  const a=S.elements[0];
  eq("thr/rot/flipが保存往復で残る", [a.thr,a.rot,a.flipH,a.flipV,a.baseCols], [180,45,true,false,2]);
}


console.log("=== v3.2: 不具合修正の検証 ===");
{
  // 幅ロックは最初から13で、つまみが見える
  eq("初期の幅ロック=13", w.document.getElementById("setLock").getAttribute("value"), "13");
  // アートは半角許可行でも全角位置に吸着
  S.halfRows=new Set([2]);
  eq("アートのスナップは常に偶数", w.eval("snapCol")(3,2,true)%2, 0);
  eq("テキストは半角許可行なら奇数OK", w.eval("snapCol")(3,2,false), 3);
  S.halfRows=new Set();
  // クランプ: ロック5(=10unit)で幅4のテキストはcol6まで
  S.elements=[{id:S.nextId++,type:"text",row:0,col:4,text:"ああ"}];
  S.selId=S.elements[0].id; S.selIds=new Set([S.selId]);
  w.eval("setWidthLock")(5); w.eval("renderAll")();
  w.document.body.dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
  eq("矢印キーでバー内に収まる(col6)", S.elements[0].col, 6);
  w.document.body.dispatchEvent(new w.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
  eq("バーを超えられない(col6のまま)", S.elements[0].col, 6);
  // ロックより広い要素は例外的に動かせる
  const wide={id:S.nextId++,type:"art",row:3,col:4,cols:12,rows:1,bits:new (w.eval("Uint8Array"))(96)};
  eq("ロック幅より広い要素はクランプ免除", w.eval("clampLock")(wide,4), 4);
  w.eval("setWidthLock")(0);
  // サイドバーの反転・回転ボタン
  S.elements=[]; 
  const bits=new (w.eval("Uint8Array"))(16); bits[0]=1;
  const a={id:S.nextId++,type:"art",row:0,col:0,cols:2,rows:1,bits};
  S.elements.push(a); S.selId=a.id; S.selIds=new Set([a.id]);
  w.eval("renderAll")();
  eq("アート選択でサイドバーに反転ボタン", w.document.getElementById("selFlipH").hidden, false);
  eq("アート選択でサイドバーに90°ボタン", w.document.getElementById("selRotR").hidden, false);
  w.document.getElementById("selFlipH").click();
  eq("サイドバーから反転できる", [a.bits[0],a.bits[3]], [0,1]);
  w.document.getElementById("selRotR").click();
  eq("サイドバーから90°回転できる", [a.cols,a.rows], [3,1]);
  // プレビュー既定: Macでない環境ではMS Gothic(index4)
  eq("非Mac環境の既定フォントはMS Gothic", w.document.getElementById("pvFont1").value, "4");
}


console.log("=== v3.3: 実機ズレ対策と幅ロックの本実装 ===");
{
  // 1) 長方形アートは全行が同じ空白構成(=どのフォントでも形が保たれる)
  S.widthLock=0; S.halfRows=new Set(); S.selId=null; S.selIds=new Set();
  const cols=4, rows=3, W=cols*2, H=rows*4;
  const bits=new (w.eval("Uint8Array"))(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){ if(x>=(H-1-y)*0.5) bits[y*W+x]=1; } // 左上が空く三角
  S.elements=[{id:1,type:"art",row:0,col:6,cols,rows,bits}];
  let c=w.eval("compose")();
  const prefix=l=>{ let f=0,h=0; for(const ch of l){ if(ch==="\u3000")f++; else if(ch===" ")h++; else break; } return f+"f"+h+"h"; };
  const ps=c.lines.map(l=>prefix(l.text));
  eq("アート全行のスペース内訳が同一", ps.every(p=>p===ps[0]), true);
  eq("行内の左詰めは点字空白", c.lines[0].text.includes("\u2800"), true);

  // 2) 幅ロック: 1行目だけ右端まで埋める
  S.elements=[
    {id:1,type:"text",row:0,col:0,text:"あ"},
    {id:2,type:"text",row:1,col:0,text:"い"},
  ];
  w.eval("setWidthLock")(13);
  c=w.eval("compose")();
  eq("1行目の幅=ロック幅(26unit)", c.lines[0].w, 26);
  eq("1行目の末尾は見えないアンカー", c.lines[0].text.endsWith("\uFFA0"), true);
  eq("2行目は埋めない", c.lines[1].text, "い");
  // 空の1行目でも幅が出る
  S.elements=[{id:2,type:"text",row:1,col:0,text:"い"}];
  c=w.eval("compose")();
  eq("空の1行目もアンカー始まりで幅26", [c.lines[0].w, c.lines[0].text.startsWith("\uFFA0"), c.lines[0].text.endsWith("\uFFA0")], [26,true,true]);
  // ロック解除なら従来どおり
  w.eval("setWidthLock")(0);
  c=w.eval("compose")();
  eq("ロック無しは埋めない", c.lines[0].text, "\uFFA0");

  // 3) 行グリップ・行操作のはみ出しを形を保って押し戻す
  const gs=[{col:24,ch:"あ",row:0},{col:26,ch:"い",row:1}];
  w.eval("setWidthLock")(13); // 26unitまで
  w.eval("clampLineToLock")(gs);
  eq("はみ出し行は形を保ったまま左へ", gs.map(g=>g.col), [22,24]);
  w.eval("setWidthLock")(0);

  // 4) 90°回転のピッチが点字幅設定に追従
  const b2=new (w.eval("Uint8Array"))(16); b2[0]=1;
  const r1=w.eval("rotBits")(b2,4,4,true);
  S.brailleW=2;
  const r2=w.eval("rotBits")(b2,4,4,true);
  S.brailleW=1;
  eq("点字幅=2では回転後の寸法が変わる", [r1.cols,r1.rows]+"|"+[r2.cols,r2.rows] !== [r1.cols,r1.rows]+"|"+[r1.cols,r1.rows], true);

  // 5) 中央寄せ: 基準がなければ動かさない
  S.elements=[{id:1,type:"text",row:0,col:4,text:"ひとりだけ"}];
  S.selId=1; S.selIds=new Set([1]);
  w.eval("renderAll")();
  w.document.getElementById("selCenter").click();
  eq("基準なし(ロック0+他に行なし)では動かない", S.elements[0].col, 4);
}

  // 6) 1行目にかかるアートも点字空白で統一(アンカー+スペース混在を排除)
  {
    S.widthLock=0;
    const b=new (w.eval("Uint8Array"))(2*4); for(let y=0;y<4;y++) b[y*2+1]=1;
    S.elements=[{id:9,type:"art",row:0,col:6,cols:1,rows:1,bits:b}];
    const cc=w.eval("compose")();
    eq("1行目アートの左詰めも点字空白のみ", /^\u2800+/.test(cc.lines[0].text) && !cc.lines[0].text.includes("\u3000"), true);
  }

console.log("=== v3.4: タッチ操作(スプリント1) ===");
{
  // CSSガード: ドラッグ対象がスクロールに奪われない指定を落としていないか
  const css=[...w.document.querySelectorAll("style")].map(s=>s.textContent).join("");
  eq(".elemにtouch-action:none", /\.elem\{[^}]*touch-action:none/s.test(css), true);
  eq(".elemに-webkit-touch-callout:none", /\.elem\{[^}]*-webkit-touch-callout:none/s.test(css), true);
  eq(".gripにtouch-action:none", /\.grip\{[^}]*touch-action:none/s.test(css), true);

  // toggleMultiSelect 単体(Shift+クリックと長押しの共通ロジック)
  S.elements=[
    {id:101,type:"text",row:0,col:0,text:"あ"},
    {id:102,type:"text",row:0,col:4,text:"い"},
    {id:103,type:"text",row:1,col:0,text:"う",grp:5},
    {id:104,type:"text",row:1,col:4,text:"え",grp:5},
  ];
  S.selId=101; S.selIds=new Set([101]);
  w.eval("renderAll")();
  const toggle=w.eval("toggleMultiSelect");
  toggle(S.elements[1]); // 102を追加
  eq("トグルで追加", [...S.selIds].sort(), [101,102]);
  toggle(S.elements[2]); // グループ(103,104)ごと追加
  eq("グループの一員でグループ全員入る", [...S.selIds].sort(), [101,102,103,104]);
  toggle(S.elements[3]); // グループごと解除
  eq("グループごと解除", [...S.selIds].sort(), [101,102]);
}
// 長押し0.5秒で複数選択に追加(DOMイベント経由・実タイマー)
{
  S.selId=101; S.selIds=new Set([101]);
  w.eval("renderAll")();
  const node=w.document.querySelector('.elem[data-id="102"]');
  eq("対象ノードが描画されている", !!node, true);
  node.dispatchEvent(new w.MouseEvent("pointerdown",{bubbles:true,clientX:10,clientY:10}));
}
setTimeout(()=>{
  eq("長押しで選択に追加", [...S.selIds].sort(), [101,102]);
  const node=w.document.querySelector('.elem[data-id="102"]');
  node.dispatchEvent(new w.MouseEvent("pointerup",{bubbles:true,clientX:10,clientY:10}));
  eq("長押し後のpointerupは単選択に戻さない", [...S.selIds].sort(), [101,102]);

  // タップ(長押しに満たない押下)は従来どおり単選択
  const n1=w.document.querySelector('.elem[data-id="101"]');
  n1.dispatchEvent(new w.MouseEvent("pointerdown",{bubbles:true,clientX:5,clientY:5}));
  n1.dispatchEvent(new w.MouseEvent("pointerup",{bubbles:true,clientX:5,clientY:5}));
  eq("タップは単選択", [...S.selIds], [101]);

  // ドラッグを始めたら長押しは発火しない
  S.selId=null; S.selIds=new Set();
  w.eval("renderAll")();
  const n2=w.document.querySelector('.elem[data-id="102"]');
  n2.dispatchEvent(new w.MouseEvent("pointerdown",{bubbles:true,clientX:0,clientY:0}));
  n2.dispatchEvent(new w.MouseEvent("pointermove",{bubbles:true,clientX:40,clientY:0}));
  setTimeout(()=>{
    eq("ドラッグ中は長押し発火なし(選択に追加されない)", S.selIds.has(102), false);
    n2.dispatchEvent(new w.MouseEvent("pointerup",{bubbles:true,clientX:40,clientY:0}));

console.log("=== v3.5: ボトムシートと微調整ボタン ===");
{
  const css=[...w.document.querySelectorAll("style")].map(s=>s.textContent).join("");
  eq("狭幅メディアクエリでサイドバーを固定シート化", /@media \(max-width:640px\)\{[\s\S]*?#sidebar\{position:fixed/.test(css), true);
  const sh=w.document.getElementById("sheetHandle");
  eq("シートの取っ手が存在", !!sh, true);
  sh.click();
  eq("取っ手クリックでシートが開く", w.document.getElementById("sidebar").classList.contains("open"), true);
  eq("矢印が▼に変わる", w.document.getElementById("sheetArrow").textContent, "▼");
  sh.click();
  eq("再クリックで閉じる", w.document.getElementById("sidebar").classList.contains("open"), false);

  // 微調整ボタン(矢印キーと同じ挙動)
  S.elements=[{id:201,type:"text",row:2,col:4,text:"うた"}];
  S.selId=201; S.selIds=new Set([201]); S.halfRows=new Set(); S.widthLock=0;
  w.eval("renderAll")();
  eq("選択中は微調整ボタンが出る", w.document.getElementById("nudgeBtns").hidden, false);
  w.document.getElementById("nudgeR").click();
  eq("▶で右へ2(全角1マス)", S.elements[0].col, 6);
  w.document.getElementById("nudgeD").click();
  eq("▼で行+1", S.elements[0].row, 3);
  S.halfRows.add(3);
  w.document.getElementById("nudgeL").click();
  eq("半角許可行では1刻み", S.elements[0].col, 5);
  S.halfRows=new Set();
  S.selId=null; S.selIds=new Set();
  w.eval("renderAll")();
  eq("非選択では微調整ボタンは出ない", w.document.getElementById("nudgeBtns").hidden, true);
}

console.log("=== v3.5: コピー失敗時の手動コピー退避 ===");
{
  Object.defineProperty(w.navigator,"clipboard",{value:undefined,configurable:true});
  w.eval("copyText")("テスト⠿ㅤ");
  eq("clipboard無しで退避モーダルが開く", w.document.getElementById("copyFbModal").classList.contains("open"), true);
  eq("見えない文字もそのまま入る", w.document.getElementById("copyFbTa").value, "テスト⠿ㅤ");
  w.document.getElementById("copyFbClose").click();
  eq("閉じるで閉じる", w.document.getElementById("copyFbModal").classList.contains("open"), false);
  Object.defineProperty(w.navigator,"clipboard",{value:{writeText:()=>Promise.reject(new Error("denied"))},configurable:true});
}
w.eval("copyText")("だめなとき").then(ok=>{
  eq("書き込み拒否時はfalseを返す", ok, false);
  eq("拒否時も退避モーダルが開く", w.document.getElementById("copyFbModal").classList.contains("open"), true);
  w.document.getElementById("copyFbClose").click();

console.log("=== ランタイムエラー ===");
eq("ページ読み込みエラーなし", errors, []);

console.log(fail ? `\n${fail}件 失敗` : "\n全テスト合格 ✅");
process.exit(fail ? 1 : 0);
});
  }, 700);
}, 700);
}, 0);
