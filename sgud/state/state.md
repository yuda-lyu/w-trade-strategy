# 現況(w-trade-strategy)— 2026-11-08

> 只記現況,不寫過程(過程在 `../exp/`)。接續工作先讀本檔;完成一項功能或結束一輪工作即更新。路徑為套件根相對路徑。

## 身分與位置

- 套件名 `w-trade-strategy` 1.0.0(**尚未發布**;由使用端於 2026-11-08 抽提〔Gitea #105〕,同日完成整理與核對〔依賴、按需引入、JSDoc、編譯、打包、去識別〕,待發布流程升版首發)。入口 `src/WTradeStrategy.mjs`(預設匯出聚合物件;各模組可深層匯入)、總組裝 `createPipeline`(別名 `createTradeStrategy`);`main` 指 `dist/w-trade-strategy.umd.js`(發布流程產製;本機已實編並以 `require` 載入驗證,見〈最近驗證〉)。
- 依賴:`wsemi` ^1.9.52、`w-data-csv` ^1.0.48、`w-data-tdprovide` ^1.0.32、`w-data-trade` ^1.0.34(週期換算 `opt.barsPerDay`)、`w-dwdata-binance` ^1.0.44、`w-trade-backtest` ^1.1.27、`w-trade-solve` ^2.0.26;devDependencies `w-package-tools` ^1.1.23(以上皆為 Verdaccio 現行最新)。`dayjs`、`lodash-es` 由 wsemi 帶入。
- 佈局(依自有套件範本):`src/`(根層 3 檔 + `cache/ data/ params/ solve/ sweep/ util/`,共 27 檔,含 3 個 worker entry)、`test/`(`unit-*.test.mjs` 6 檔 45 案 + `tools/` 3 檔)、`toolg/` 六支、`g.mjs`(離線範例)、`sgud/` 四檔、根目錄範本檔(`.editorconfig`、`.eslintignore`、`.eslintrc.js`、`.jsdoc`、`babel.config.js`、`SECURITY.md`、`LICENSE`、`script.txt`、`.gitignore`)。`dist/`、`docs/` 為發布流程之產製物(`script.txt` 列序)。
- 深層路徑穩定契約(使用端以此取用,不得改名搬動):`src/WTradeStrategy.mjs`、`src/createPipeline.mjs`、`src/cfg.mjs`、`src/params/catalog.mjs`、`src/params/keysCloseOnly.mjs`、三個 worker entry(`src/sweep/sweepSingle_worker.mjs`、`src/sweep/sweepPairs_worker.mjs`、`src/solve/solveWorker.mjs`)、`test/tools/synthKit.mjs`。

## 最近驗證

| 日期 | 項 | 結果 |
|---|---|---|
| 2026-11-08 | 全套 `npm test`(`--no-parallel`,經測試鎖) | 45 案全綠(約 35 秒);測試所用 worker 數固定(`takeLimit: 2`、`workers: 0／1／2`) |
| 2026-11-08 | 編譯鏈(`script.txt` 列序:`modifyReadme` → `cleanFolder` → `jsdoc` → `gDocsExams` → `gDistRollup` → `genDocsDist`) | 皆成功;jsdoc 0 error／0 warning;`gDistRollup` 僅一條固有警告(browser bundle 提示) |
| 2026-11-08 | dist 以 `require` 載入 | 匯出鍵 52＝ESM 入口 52、`typeof` 全同;`buildOhlc` → `buildParams` → `buildCache` 實跑,因子序列檔雜湊與 ESM 路徑相同 |
| 2026-11-08 | 安裝後驗收(`npm pack` 本地 tarball〔116 檔〕→ 全新最小專案安裝) | `typeof m.default.createPipeline` 為 `function`;28 條 `src/` 與 `test/tools/synthKit.mjs` 深層路徑:25 條 `import` 成功、3 個 worker entry 核對存在;`require('w-trade-strategy')` 鍵與 `typeof` 同 ESM;安裝後 ESM 與 dist 實跑因子序列雜湊相同;包內 `g.mjs` 輸出與檔末 `// =>` 逐行相符;包內無 `CLAUDE*.md`、`tmp`、`test/_tmp` |
| 2026-11-08 | 某實測(真實 4hr ETHUSDT 數據)以使用端既有管線之參數定義(含其 nm)跑 `buildParams` | 序列檔與使用端既有管線之產物逐值一致(最大差 0);內建目錄自算 nm 得同名同數量之序列檔;`sweepSingle`、`solve` 一輪(fast)皆可跑完並落地策略 |
| 2026-11-08 | 1hr 合成 K 線(`interval: '1hr'`)於 w-data-trade 1.0.34 | `'1day'` 均線 24 根、單根型態標籤 `1hr`(`unit-buildParams`〈1hr K線〉) |

## 功能現況(對應規則帳本)

| 功能 | 狀態 | 規則/測試 |
|---|---|---|
| 設定正規化(`CFG_KEYS` 嚴格、可重入、`barsPerDay`) | 落地 | TS-10/11;`unit-cfg` |
| 幣安抓取 + K 線整理(外部來源、未收棒剔除、index 截齊) | 落地(幣安抓取未在本套件測試中連網驗證) | `unit-buildOhlc` |
| 參數計算(34 定義、nm 凍結、index 校正、過濾、`extraDefs`/`calcs`/`series`) | 落地 | TS-12/13;`unit-buildParams` |
| 其他 K 線週期(`barsPerDay` 併入 calc 呼叫) | 落地(w-data-trade 1.0.34 已提供 `opt.barsPerDay`／`opt.kp`;1hr 之 `'1day'` 為 24 根、單根型態標籤 `1hr`;4hr 預設輸出與舊版逐位相同) | TS-11;`unit-buildParams`〈1hr K線〉 |
| 先觸快取、單因子/雙因子普測(parfor worker、dedup、穩定度 gate 依週期換算) | 落地 | TS-14;`unit-sweep` |
| 最佳化求解(fast/full、事件、停止條件、workers 放行握手、`SOLVE_OPT_KEYS`) | 落地(`workers > 0` 起跑前檢查見待辦) | TS-15;`unit-solve` |
| 發布面守門(package.json、依賴對帳、dist 打包寫法、打包清單、g.mjs、JSDoc 範例實跑、通用機敏樣式) | 落地 | TS-01~06;`unit-package` |

## 待辦與已知限制

- w-data-trade 之週期換算已於 1.0.34 發布(2026-11-08;換算先乘後除、無效 `barsPerDay` 靜默採預設、`dataCalibrate` 之 `optMethodInit` 不可含 `barsPerDay`——本套件以呼叫時注入迴避),`package.json` 最低版已改 ^1.0.34;使用端回歸(逐值比對)與本套件全套測試皆綠。
- `w-dwdata-binance` 之 `saveData` 只支援 6 種 interval;日 K 等週期須另案擴充其表。
- dist/docs 由發布流程以 `toolg/` 產製(`script.txt` 列序)。`gDistRollup.mjs` 之 external 只留 node 內建模組與 dayjs 三項,**自有套件、wsemi、lodash-es 一律打包進 dist**(規則 TS-06;列為 external 則 dist 執行失敗);新增依賴或自有套件升版後須重盤,並以 `require` 載入 dist 實跑驗證。
- worker entry 不隨 dist 打包(見 `toolg/gDistRollup.mjs` 檔頭第 6 點與 README);需 workers 之功能以 ESM 深層路徑取用。
- **已知落差(依程式碼閱讀,未實測;行為未改)**:`solve` 於 `workers > 0` 時,起跑前不檢查停止條件,各 worker 至少完成首輪(`workers: 0` 則起跑前檢查,庫已達 `maxStrategies` 即不起跑);規則 TS-15 與 README 已如實註明。若要補,於 `src/solve/solve.mjs` 之 `runWorkers` 起跑前呼叫 `checkStop()`(行為改動,須使用端同意)。
- `src/util/parfor.mjs` 抽自 w-package-tools 之 `src/parfor.mjs`(開發工具套件不可作為執行期依賴);若日後有自有套件提供執行期可用之 `parfor`,改為引用並移除本檔(須另案請自有套件主控評估)。
- `onRound` 事件之 `elapsedMs` 為求解器累計耗時(`status()` 覆寫該輪耗時);JSDoc 與 README 已註明,行為未改。
