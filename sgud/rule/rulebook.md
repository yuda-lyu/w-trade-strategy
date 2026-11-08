# 規則帳本(w-trade-strategy)

> **藍圖**:以規則為單位記程式碼須長成什麼樣(附盤點指令與判準);與現況比對看 `../state/state.md`。規則 ID(TS-*)為穩定編號,不重編。路徑為套件根相對路徑;盤點指令於套件根執行(測試以 `npm test`)。

## 1. 套件邊界與發布面

- **TS-01 邊界**:`src/` 只 import 套件內相對路徑、node 內建模組(無 `node:` 前綴)、`package.json` 之 dependencies 所列套件(以 `src/` 深層路徑:`w-data-trade/src/WDataTrade.mjs`、`w-data-tdprovide/src/WDataTdprovide.mjs`、`w-data-csv/src/WDataCsv.mjs`、`w-dwdata-binance/src/saveData.mjs`、`w-trade-backtest/src/*.mjs`、`w-trade-solve/src/*.mjs`)與 wsemi 帶入之 `lodash-es/<函數>.js`、`wsemi/src/<函數>.mjs`、`dayjs`;不得引用任何使用端專案之程式與資料。
  - 盤點:`git grep -nE "from '(w-[a-z-]+|wsemi|lodash-es)'" -- src` 應為空(皆須深層路徑);`git grep -nE "from 'node:" -- src` 應為空。
  - 測試:`test/unit-package.test.mjs` ②。
- **TS-02 發布面**:`main` 指 `dist/w-trade-strategy.umd.js`(發布流程產製),**不設 `exports`、`files`、`type`**(下游以 `w-trade-strategy/src/…`、`w-trade-strategy/test/tools/…` 深層路徑取用);不提供 `.npmignore`(npm 包＝git 版控內容);`.gitignore` 列 `node_modules`、`tmp`、`test/_tmp`、`CLAUDE*.md`,不排除 `sgud`、`src`、`dist`、`test/tools`;scripts 只有 `test` 與 `deploy`;套件根有 `.editorconfig`、`.eslintignore`、`.eslintrc.js`、`.jsdoc`、`babel.config.js`、`SECURITY.md`、`LICENSE`(MIT)、`g.mjs`、`script.txt`、`toolg/` 六支。
  - 測試:`unit-package` ①③。
- **TS-03 無使用端痕跡(公開庫)**:`src/`、`test/`、`README.md`、`g.mjs`、`sgud/`、`toolg/`、`package.json` 不含使用端之專案名、目錄名、腳本名、本機路徑與規模數據;需求出處一律寫「使用端」與 Gitea 編號,來源管線稱「使用端既有管線」,實測稱「某實測」;公開之交易對代號(如 ETHUSDT)與公開 API 端點可保留;量化交易之業務詞為本套件之領域本身,不在此限。
  - 守門分工:`unit-package` ⑥ 只守**通用機敏樣式**(磁碟機絕對路徑、IPv4 位址、權杖／私鑰樣式),**不列任何使用端名稱**(列了即把名稱公開);使用端名稱之偵測由發布前之私有檢查負責,不在本庫。
  - 盤點(於套件根;命中僅應為 `test/unit-package.test.mjs` 之自檢字串〔中性假值〕):`git grep --untracked -nP "(?<![A-Za-z0-9_])[A-Za-z]:[\\\\/]" -- src test README.md g.mjs sgud toolg package.json` 與 `git grep --untracked -nP "(?<![0-9.])(\d{1,3}\.){3}\d{1,3}(?![0-9.])" -- <同上>`。
  - 測試:`unit-package` ⑥。
- **TS-04 JSDoc**:`src/` 每個匯出之函數須有說明、`@param`(有參數者)、`@returns`、`@example`;匯出之常數須有說明;可離線執行之 `@example` 其 `// =>` 須與實跑相符,需檔案系統或網路者首行寫 `need test in nodejs.`。
  - 測試:`unit-package` ⑤。
- **TS-05 範例 `g.mjs` 離線可跑**:以合成 K 線走完整條管線(外部數據來源、不連網、結束刪工作目錄),輸出與檔末 `// =>` 逐行相符;`README.md` 之 Example 含其全文。
  - 測試:`unit-package` ④。

- **TS-06 dist 打包寫法**:`toolg/gDistRollup.mjs` 以 `'./src'`、`'./dist'`、`fns: 'WTradeStrategy.mjs'`、`runin: 'nodejs'`;`external` 與 `globals` 同組且只含字串(node 內建模組:`src/` 與打包範圍內第三方套件所引用者;`dayjs` 與其 `plugin/utc.js`、`plugin/timezone.js`);**自有套件、`wsemi`、`lodash-es` 一律不列 external,由 rollup 沿引用打包進 dist**。
  - 為何:UMD 的 `require` 路徑對 ESM 外部模組取得命名空間物件(`{ default }`)而非預設匯出;自有套件(皆 ESM)列為 external 時,實測 `require` 載入 dist 後 `buildParams` 拋 `dataConvert is not a function`,且 `dist.readStrategies` 之 `typeof` 與 ESM 入口不同。ESM 專用之第三方套件(`strip-bom-stream` 等)同理須打包。
  - 盤點:自 `src/WTradeStrategy.mjs` 靜態追蹤 import 圖(含 `node_modules` 內之自有套件與第三方套件),取全部裸 import 歸類;新增依賴或自有套件升版後重盤。
  - 驗證:`node toolg/gDistRollup.mjs` 後,以 `require` 載入 dist,匯出鍵與 `typeof` 須與 `src/WTradeStrategy.mjs` 預設匯出一致,且實跑 `buildOhlc` → `buildParams` → `buildCache` 之產物與 ESM 逐位元組相同。
  - 限制:三個 worker entry 不在 import 圖內,不隨 dist 打包(`toolg/gDistRollup.mjs` 檔頭第 6 點與 README 皆已註明)。
  - 測試:`unit-package` ②(external 寫法靜態守門;dist 本身為發布產製物,不入測試前提)。

## 2. 設定與契約

- **TS-10 設定鍵嚴格**:`normalizeCfg` 只認 `CFG_KEYS`(`src/cfg.mjs`),不認得之鍵拋錯並列可用鍵;已正規化之 cfg 可重入(衍生鍵 `DERIVED_KEYS` 略過);`createSolver` 之 opt 只認 `SOLVE_OPT_KEYS`(`src/solve/solve.mjs`;含 `EVENT_KEYS`,其中 `gate` 見 TS-16)。新增讀取 `cfg.<鍵>`／`opt.<鍵>` 處須同步列入。
  - 測試:`unit-cfg`、`unit-solve`。
- **TS-11 時間與週期**:時間字串一律 `'YYYY-MM-DDTHH:mm:ss'`(wsemi `istime`),時區由 `cfg.timeZone` 決定(預設 Asia/Taipei);`interval` 為內建週期(`INTERVALS`)或另給 `intervalSec`;`barsPerDay = 86400 / intervalSec` 併入每次 w-data-trade calc 之呼叫(`buildKp`;w-data-trade ≥ 1.0.34),使週期表之時間語意跨週期不變;`barsPerDay` 只在呼叫時注入,不放進定義之 `optMethod`(否則 `dataCalibrate` 會把它當搜尋參數)。
  - 測試:`unit-cfg`、`unit-buildParams`〈1hr K線〉。
- **TS-12 nm 凍結**:z-score 之 avg／std 首次由 `nmPeriod`(預設訓練期)自算,寫入 `meta/params.json`,之後沿用;只有 `recalibrate: true` 才重算;定義自帶 `nm` 者直接採用。index 側 `optMethod` 之校正值同樣凍結於 meta。
  - 為何:數據延長時門檻不漂移;與使用端既有管線把 nm 寫死之效果等價而不綁幣種。
  - 測試:`unit-buildParams`。
- **TS-13 定義過濾**:參數定義依 `useIndex`(剔 index)、數據欄位(`fields` 缺任一欄即剔)、`only`／`exclude` 三道過濾,剔除者列於 `dropped` 附原因,不得算出 NaN 序列。
  - 測試:`unit-buildParams`。
- **TS-14 策略檔格式**:求解與普測之產物皆為 w-trade-solve `estimKeys`／`readStrategies` 可讀之策略檔(`${mode}_${levelNumTrade}_${hash16}.json`;含 tid／sid／name／symbol／interval／keyOhlc／mode／conds／settings／summary);不另立格式。
  - 測試:`unit-sweep`、`unit-solve`。
- **TS-15 求解停止與平行**:停止條件(`maxStrategies`／`maxRounds`／`maxTimeMs`／`shouldStop`／`stop()`)於**起跑前**、每輪結束與每個閘 resolve 後檢查;起跑前已成立者不起任何輪次(`workers: 0` 與 `workers > 0` 同:`workers > 0` 時不起 worker,`runWorkers` 起跑前 `checkStop()`);`workers > 0` 時 worker 於 `ready` 與每輪結束後皆等主程序回 `continue`(或 `stop`)才起下一輪,總輪數至多超出 `workers - 1`;`requestStop` 對**所有** worker 送 `stop`(含尚未放行、仍在閘內等待者);worker 之 `done`／`error` 由主程序 `terminate()`;`workers > 0` 時 opt 不可含非事件之函數(`EVENT_KEYS` 所列除外)。
  - 為何:`workers > 0` 起跑前不查停止條件時,庫已達上限仍起 worker 載入數據、至少跑完首輪;`ready` 後不等放行則無處插入閘。
  - 盤點:`git grep -nE "checkStop\(\)" -- src/solve/solve.mjs`(站點 5:`runInProcess` 起跑前、閘後與每輪結束,`runWorkers` 起跑前,`maybeStop`〔worker 每輪結束與閘後共用〕);`git grep -n "type: 'continue'" -- src/solve`(放行僅經 `proceed`);`git grep -nE "waitGo\(\)" -- src/solve/solveWorker.mjs`(`ready` 後一處、每輪後一處)。
  - 測試:`unit-solve`(各停止條件、`workers 2`、`gate` 群組之〈起跑前已達停止條件〉)。
- **TS-16 求解資源閘(`opt.gate`)**:`async ({ workerId, ...status }) => {}`,列入 `EVENT_KEYS`(`workers > 0` 時允許為函數、僅於主程序執行、不序列化給 worker);**每輪起跑前**(`workers: 0` 之每輪;`workers > 0` 各 worker 之第 1 輪與其後每輪)由主程序 `await` 後才放行;閘 resolve 後再查停止條件,成立即不放行(`workers > 0` 時 `maybeStop` → `requestStop` 對全體 worker 送 `stop`,不致懸置);閘拋錯(含 rejection)記入 `status().errors`、觸發 `onError`(`onError` 本身拋錯亦忽略)、照常放行(非致命);已要求停止(`stopReason` 已設)後不再呼叫閘;`maxRoundsPerWorker` 達上限之 worker 末輪後不再過閘(放行後即結束);無 `gate` 時行為與無此鉤子相同(僅多一次 `ready → continue` 往返)。`stop()` 直送 `stop` 給所有 worker、不等閘;`shouldStop`／`maxTimeMs`／`maxStrategies` 僅在輪次結束與閘 resolve 後判定(**限制**:閘不 resolve 者不被判定,見 `../state/state.md`)。
  - 為何:使用端長跑需依整機 CPU／RAM 暫停與續跑,通知類事件與整體停止無法在「放行前」節流。
  - 盤點:`git grep -nE "waitGate\(" -- src/solve/solve.mjs`(站點:`runInProcess` 一處、`release` 一處,皆在放行前);`git grep -n "gate" -- src/solve/solve.mjs`(`EVENT_KEYS`、`waitGate`、JSDoc)。
  - 測試:`unit-solve` 之 `gate` 群組 11 案(常數、in-process 序列與延遲、閘內 `stop()`／`shouldStop`、閘拋錯、`workers 2` 首輪前閘內 `stop()`、`workers 2 + maxRounds` 閘與輪次交替及次數界、`maxRoundsPerWorker`、起跑前停止條件、不懸置三案)。同步點為事件與呼叫序列(不以固定延時判定先後;閘內 `sleep` 只製造「閘等待中」之狀態,防懸置上限用計時器、逾時判紅)。

## 3. 盤點指令與判準

| 項 | 指令 | 判準 |
|---|---|---|
| 全套測試 | `npm test` | 0 失敗 |
| 結構與發布面 | `unit-package` | 皆綠 |
| 按需引入 | `git grep -nE "from '(w-[a-z-]+|wsemi|lodash-es)'" -- src`、`git grep -nE "from 'node:" -- src` | 皆無命中 |
| 編譯 | `node toolg/gDistRollup.mjs` 後 `require('./dist/w-trade-strategy.umd.js')`(TS-06) | 載入不拋、匯出鍵集合與 `typeof` 同 `src/WTradeStrategy.mjs` 預設匯出、`buildOhlc` → `buildParams` → `buildCache` 實跑產物與 ESM 相同 |
| 文件 | `node node_modules/jsdoc/jsdoc.js -c .jsdoc`、`node toolg/gDocsExams.mjs` | exit 0 |

## 4. 測試清單(`test/`;前綴＝層級:`unit-` 單元、不連網)

`unit-cfg`、`unit-buildOhlc`、`unit-buildParams`、`unit-sweep`、`unit-solve`、`unit-package`;共用件 `test/tools/synthKit.mjs`(合成 K 線與設定)、`test/tools/tmpdir.mjs`、`test/tools/jsdocExamples.mjs`。
