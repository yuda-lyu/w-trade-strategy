# 處理要點(w-trade-strategy)

> 本檔記使用與維護本套件之要點(規則見 `../rule/rulebook.md`,現況見 `../state/state.md`)。

## 1. 使用

- 一個標的一個工作根:`createPipeline({ root, name, symbol, interval, train, … })`;ETH 與 BTC 等不同標的分開工作根(nm 凍結值、index 校正值、meta 皆綁工作根)。
- 順序:`fetchData`(幣安)→ `buildOhlc` → `buildParams` → `buildCache` → `sweepSingle`／`sweepPairs`(可選)→ `solve`。前四步可一次 `prepare()`。
- 數據延長時只需重跑 `fetchData` → `buildOhlc` → `buildParams` → `buildCache`:nm 沿用凍結值;先觸快取之區間終點改變即重建。
- 外部數據(股價):`source: { price: arr | async fn }`;欄位名與幣安現貨一致(`Open/High/Low/Close/Volumn/QuoteAssetVolume/NumberOfTrades/TakerBuyBaseAssetVolume/…`),缺欄位之定義會被剔除(看 `buildParams` 回傳之 `dropped`)。
- 求解之常駐擴庫:`solve({ workers: n, maxStrategies, onRound })`;長跑者以脫離式行程執行並把 `status()` 寫檔供巡檢;`stop()` 可中止。
- 其他週期:`interval` 給 `'1hr'` 等內建週期,或另給 `intervalSec`;需 w-data-trade 支援 `opt.barsPerDay`(見 state.md 之待辦)。

## 2. 維護

- 改 `src/` 任何匯出:同步 JSDoc(含 `@example`)、`README.md` 相應節、`sgud/state/state.md`。
- 改 `g.mjs`:實跑一次把輸出貼回檔末 `// =>`,並把全文貼回 `README.md` 之 Example。
- 改 cfg／opt 之讀取:同步 `CFG_KEYS`／`SOLVE_OPT_KEYS`。
- 改 worker entry(`sweep*_worker.mjs`、`solveWorker.mjs`)之訊息協定:同步主程序端(`sweepSingle.mjs`／`sweepPairs.mjs`／`solve.mjs`)與 `rulebook.md` TS-15。
- 新增依賴:列入 `package.json`、以 `src/` 深層路徑引用、重盤 `toolg/gDistRollup.mjs` 之 external。
- 測試:`npm test`(mocha `--no-parallel --timeout 180000`,約 40 秒;會起 worker_threads,測試中 `takeLimit` 固定 2、`workers` 固定 1~2,**新增測試不得用預設 `takeLimit`**〔預設為 `os.availableParallelism() - 1`,會隨核數放大〕);暫存只落 `test/_tmp/`(各案自刪)。
- 編譯與驗 dist:依 `script.txt` 列序(`modifyReadme` → `cleanFolder` → `jsdoc` → `gDocsExams` → `gDistRollup` → `genDocsDist`);`gDistRollup` 後以 `require` 載入 dist,與 ESM 入口比對匯出鍵與 `typeof`,並實跑 `buildOhlc` → `buildParams` → `buildCache`(不開 worker)核對產物與 ESM 逐位元組相同。**自有套件不可列為 external**(見規則 TS-06)。
