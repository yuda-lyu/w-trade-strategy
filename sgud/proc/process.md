# 處理要點(w-trade-strategy)

> 本檔記使用與維護本套件之要點(規則見 `../rule/rulebook.md`,現況見 `../state/state.md`)。

## 1. 使用

- 一個標的一個工作根:`createPipeline({ root, name, symbol, interval, train, … })`;ETH 與 BTC 等不同標的分開工作根(nm 凍結值、index 校正值、meta 皆綁工作根)。
- 順序:`fetchData`(幣安)→ `buildOhlc` → `buildParams` → `buildCache` → `sweepSingle`／`sweepPairs`(可選)→ `solve`。前四步可一次 `prepare()`。
- 數據延長時只需重跑 `fetchData` → `buildOhlc` → `buildParams` → `buildCache`:nm 沿用凍結值;先觸快取之區間終點改變即重建。
- 外部數據(股價):`source: { price: arr | async fn }`;欄位名與幣安現貨一致(`Open/High/Low/Close/Volumn/QuoteAssetVolume/NumberOfTrades/TakerBuyBaseAssetVolume/…`),缺欄位之定義會被剔除(看 `buildParams` 回傳之 `dropped`)。
- 求解之常駐擴庫:`solve({ workers: n, maxStrategies, onRound })`;長跑者以脫離式行程執行並把 `status()` 寫檔供巡檢;`stop()` 可中止。
- 其他週期:`interval` 給 `'1hr'` 等內建週期,或另給 `intervalSec`(每根 K 線秒數;60 之正整數倍且至多 31536000,數字字串轉為數值,給了而無效即拋);需 w-data-trade ≥ 1.0.50(根數為本:根數不變、期別標籤 = 根數 × 每根秒數)。非 4hr 之因子鍵與值與舊版不同,舊因子庫須重建(新版對無口徑標記之非 4hr 工作根即拋,須另建工作根);最長期別約需 360 根暖機,`timeBegin` 宜早於訓練起點至少 360 根(見 README〈限制與注意〉)。
- 日線之新工作根(研究用):`interval: '1day'`、`aggregateFrom: '4hr'`(由下載套件依 `timeZone` 之日界合併,與 4hr 資料同源)、`timeBasis: 'span'`(持倉天數與回測天數依實際時點);同一工作根之 `timeZone`、`dayStart`、`aggregateFrom`、`timeBasis` 與求解之 `thsCond`／`levelNumTradeBounds` 皆不可再改(口徑標記 `meta/basis.json`;改即拋)。日線之止盈止損候選與普測之 `numTradeFinMin` 宜依週期另給(套件不依週期改預設)。期間內之洞:幣安來源之非 4hr 預設放行並記入 `meta/ohlc.json` 之 `gaps`,以 `console.warn` 提示一則(只含序列名與洞數);要嚴格(遇洞即拋)者給 `buildOhlc` 之 `opt.allowGaps: false`,管線為 `prepare({ ohlcOpt: { allowGaps: false } })`;4hr 不判定(缺根不會被攔下,使用者裁定)。`1week` 須明給落在週界線上之 `timeBegin`。`solve` 之 `oml` 不得含口徑鍵與保留鍵(TS-25)。
- 改 `intervalSec` 之處理(`src/cfg.mjs`、`buildKp`)前後:以 `git archive HEAD` 解出改前之 `src` 於套件根下之暫存夾,對**每根 4hr** 之合成數據(含溢價指數與僅 OHLC 兩組)各跑 `buildOhlc` → `buildParams`(內建目錄全部定義),逐項比對 `keys`(含順序)、`defs`、`dropped`、`calibrated`、`meta`(nm 與 optMethod 之鍵序與值)與全部序列檔之位元組雜湊,須全同;並以每根 1hr 之數據證明比對抓得到差異(靈敏度)。對拍工具為一次性腳本,未入庫。
- 改用基礎單位(`settings.unit`):先 `recomputeStrategies` 依序 `verify` → `dry` → `write`(寫至另一夾,驗收後再換夾)把既有策略庫改為同一口徑,之後才以 `unit` 求解或普測(同 tkid 之覆寫以等效年化比較,新舊口徑不可混在同一庫;`w-trade-solve` ≥ 2.0.40 於同 tkid 新舊口徑不同時以本次覆寫並於 `useShowLog` 時警告);交易規則或緩衝改變即重算。
  - `unit` 之 `rule` 三欄、`buffer`、`units` 與 `uIni`、`thEqYr`、`takeLimit`、`limit` 皆可給數字字串(檢測通過即轉為數值,策略檔與 journal 落地皆為數值);`asOf`、`source` 須為非空字串且原樣保留。無門檻之舊檔(遷移檔)之跨門檻判定取決於 `thEqYr`(套件不給預設門檻),使用端須明給並於 `write` 前定案(journal 之 header 記之,中斷後改變即無法續跑)。
  - 重算只寫 `fdOut`(另一夾)與 `fdReport`;不要把 `fdReport` 設在策略庫或輸出夾之內。鎖檔 `recompute.lock` 與接手保護檔 `recompute.lock.takeover` 於當機後可能遺留,確認無其他重算行程後方可手動刪除(訊息已附處置)。
  - 單檔重放無逾時、不做 fsync 等已知限制見 `rulebook.md` TS-19。

## 2. 維護

- 改 `src/` 任何匯出:同步 JSDoc(含 `@example`)、`README.md` 相應節、`sgud/state/state.md`。
- 改 `g.mjs`:實跑一次把輸出貼回檔末 `// =>`,並把全文貼回 `README.md` 之 Example。
- 改 cfg／opt 之讀取:同步 `CFG_KEYS`／`SOLVE_OPT_KEYS`。
- 改 worker entry(`sweep*_worker.mjs`、`solveWorker.mjs`、`recomputeStrategies_worker.mjs`)之訊息協定:同步主程序端(`sweepSingle.mjs`／`sweepPairs.mjs`／`solve.mjs`／`recomputeStrategies.mjs`)與 `rulebook.md` TS-15、TS-19。
- 改管線各階段(`src/cfg.mjs`、`src/data/`、`src/params/`、`src/sweep/`、`src/solve/`、`src/createPipeline.mjs`)前後,**4hr 未給新選項、未給 `settings.unit` 時須逐位不變**(TS-17、TS-24):先以 `git archive HEAD` 解出改前之 `src` 放於套件根下之暫存夾(`./tmp/<工作夾>/base`;相依經上層 `node_modules` 解析),再以 `node test/tools/abPipeline.mjs <src資料夾> <標籤> [--tz <時區>] [--raw]` 各跑一次(輸出於 `test/_tmp/abPipeline/<標籤>/`;雜湊各階段之回傳與整個工作根之輸出樹〔檔名清單與每檔之內容〕,新增或消失之檔皆抓到;同一份 src 連跑兩次應相同),`node test/tools/abPipeline.mjs --diff <標籤A> <標籤B>` 全同(離開碼 0)才算不變。**須跑四組**:預設(外部數據)× `--tz UTC`、`--tz Asia/Taipei`,`--raw`(幣安來源,本機假交易所 `test/tools/fakeExchange.mjs`;既有六鍵之 `fetchData` raw 全部 csv 與請求、`buildOhlc` 之 K 線序列,4hr 另跑其後各階段)× 同二時區;1m～1hr 之標記檔與 `gaps` 欄依設計新增,工具已排除。工具之鑑別力:新碼之 UTC 對台北(raw 之分段起點不同)應判出差異。跑完刪 `test/_tmp/abPipeline` 與暫存夾。經測試鎖執行(外部數據族每組約 3 分鐘、`--raw` 約 1 分鐘)。
- 改 `src/recompute/recomputeLock.mjs` 之取鎖或接手:除 `unit-recompute`〈C11 鎖檔〉外,以 `node test/tools/lockRaceProbe.mjs 60`(多個子行程同時接手同一殘留鎖,量「持有者數 ≠ 1」與取得者 `staleLock` 之分布;子行程為 `test/tools/lockChild.mjs`;經測試鎖執行,約 6 分鐘)重複數十次,期望 `winnersNot1` 與 `staleFalse` 皆為 0(離開碼 0),因單次綠不能證互斥。
- 新增依賴:列入 `package.json`、以 `src/` 深層路徑引用、重盤 `toolg/gDistRollup.mjs` 之 external。
- 測試:`npm test`(mocha `--no-parallel --timeout 180000`,約 6 分鐘;會起 worker_threads,測試中 `takeLimit` 固定 2、`workers` 固定 1~2,**新增測試不得用預設 `takeLimit`**〔預設為 `os.availableParallelism() - 1`,會隨核數放大〕);暫存只落 `test/_tmp/`(各案自刪)。
- 編譯與驗 dist:依 `script.txt` 列序(`modifyReadme` → `cleanFolder` → `jsdoc` → `gDocsExams` → `gDistRollup` → `genDocsDist`);`gDistRollup` 後以 `require` 載入 dist,與 ESM 入口比對匯出鍵與 `typeof`,並實跑 `buildOhlc` → `buildParams` → `buildCache`(不開 worker)核對產物與 ESM 逐位元組相同。**自有套件不可列為 external**(見規則 TS-06)。
