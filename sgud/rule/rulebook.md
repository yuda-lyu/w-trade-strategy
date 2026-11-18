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
  - 限制:四個 worker entry(含 `src/recompute/recomputeStrategies_worker.mjs`,TS-19)不在 import 圖內,不隨 dist 打包(`toolg/gDistRollup.mjs` 檔頭第 6 點與 README 皆已註明)。
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

- **TS-17 基礎單位設定**:`cfg.settings.unit` 為 `{ rule, buffer, units }`(下單之基礎單位 = 交易所之最小可下單數量;介面同 `w-trade-backtest` ≥ 1.1.40 之 `settings.unit`);`normalizeUnit`(`src/cfg.mjs`)要求 `rule.asOf` 與 `rule.source` 為非空字串(記錄查得之時刻與來源;原樣保留,不轉型、不去空白)、有效性以回測套件之 `buildBaseUnitNotional(unit, name)` 判定(與回測各路徑檢測 `settings.unit` 者同一函數;須為一般物件;**不另加型別限制**,與回測套件之收值一致)。**數字字串於檢測通過後轉為數值落地**(跨套件規格 K4、K7;與 `w-trade-solve` 之 `estimKeys`、`w-trade-adaptivess` 一致):`rule` 三欄與 `buffer` 為 Number、`units` 為整數,`buffer`／`units` 為 `null` 或未給時補 0.1／1(不寫入 `null`);先 `cloneDeep` 取一次各欄,檢測與轉換皆用此副本(檢測之值即使用之值),轉換前後 `buildBaseUnitNotional(...).key` 與各價位之每單名義相同。給 `unit` 時 `settings.uIni`(研究用本金)須為有效正數(數字或數字字串,通過即轉為數值;無效即 `invalid cfg.settings.uIni: must be a positive number`);`unit: null` 視同未給(原樣保留,各階段以是否為物件判定);**未給 `unit` 時 `settings` 與各階段之行為、回傳、事件與策略檔逐位不變**(含 `uIni` 不轉型、不檢測)。錯誤訊息依跨套件規格 V19／V20:`invalid <名稱>…: must be …`,不含輸入值。不得在 `src/` 寫死任何標的之交易規則數值。
  - 盤點:`git grep -n "normalizeUnit(" -- src`(站點 2:`normalizeCfg` 之 `settings.unit`、`recomputeStrategies` 之目標口徑〔`opt.unit` 優先,否則 `cfg.settings.unit`〕);`git grep -n "toNumericUnit(" -- src`(站點 2:`normalizeUnit` 內、`recomputeStrategies_core.mjs` 之 `numericSettingsOf`〔檔內口徑轉數值後與目標比較〕)。數字字串之解析只在 `toNumericUnit`,他處不得另寫解析。
  - 測試:`unit-baseUnit`〈設定〉(轉換前後 `key` 與每單名義相同之 37 種寫法、各欄只讀取一次、訊息不含輸入值、`uIni` 數字字串)。
- **TS-18 普測與求解依基礎單位**:給 `cfg.settings.unit` 時,`sweepCfgOf` 帶 `unit`;`sweepSingle`／`sweepPairs` 之 `ordersFromBars` 帶 `opt.unit`、策略之 `settings` 於既有五鍵後接 `unit`;`solve` 之每輪把 `settings.uIni` 與 `unit` 交給 `estimKeys`(`opt.uIni`／`opt.unit`;`w-trade-solve` ≥ 2.0.40,其數字字串於其檢測後轉為數值落地)。**單一策略不設持倉門檻**:最大持倉名義(`summary.uTradeAllMax`)是否超過 `uIni` 不檢、不剔除、不中止,只隨摘要落地;普測之挑選與求解之入庫不因 `uIni` 而變;回傳、事件與 `status` 之形狀不變。未給 `unit` 時策略檔不變(求解照舊不讀 `cfg.settings`)。
  - 為何:入庫資格不得隨幣價與標的而異;持倉組合是否超過本金由挑選端判定。
  - 盤點:`git grep -n "sc.unit" -- src/sweep`(站點 4:兩個普測核心各一處訂單、一處策略 `settings`)、`git grep -nE "o\.(uIni|unit) =" -- src/solve`(站點 2:`runRound`)、`git grep -n "unit" -- src/sweep/common.mjs`(站點 1:`sweepCfgOf`);加速核心 `src/solve/fastEngine.mjs` 本即把 `settings` 傳入 `evaluate`(不改)。
  - 測試:`unit-baseUnit`〈普測〉〈求解〉(含 `workers: 1`、加速核心與 `runStrategy` 之對應欄逐欄相同、研究用本金小於最大持倉名義時不剔除、cfg 給數字字串時策略檔與給數值者逐位相同)。
- **TS-19 策略庫重算**:`recomputeStrategies(cfg, opt)`(`src/recompute/`;管線 `pl.recomputeStrategies`;入聚合入口)不重新求解;逐檔先忠實重放(檔內 `settings` 於 `solve` 時間窗重跑官方 `runStrategy`,摘要逐欄相同〔`timeTest` 除外〕;`fitness` 與現行 `calcFitness` 不同者記 `fitnessStale`,不擋),通過者才以目標口徑重算(`settings.uIni` 換為目標、`unit` 設為目標、`summary` 與 `fitness` 換新,其餘欄與鍵序不變);斷言交易筆數、已平倉筆數、勝率與檔名不變(`checkInvariant`;否則 `r8`);檔內 `settings` 已等於目標(`uIni` 相同,`unit` 轉數值後與目標相同〔`buildBaseUnitNotional` 之 `key` 相同,且記錄欄 `asOf`、`source` 與其他欄亦相同〕;**檔內數字字串與同值之數字視為相同**)且 `fitness` 為現行算法者為 `already`(`write` 時逐位複製);最大持倉名義不設門檻(超過目標 `uIni` 者照常重算寫出,統計另列其隻數、最大者、最大單位數與清單,只列不處置);模式 `verify`／`dry`／`write`(`write` 遇不合格〔`mismatch`、`r8`、`unsupported`、`error`〕即中止,不可關閉);`journal_<mode>.jsonl` 續跑(header 記模式、資料夾、目標口徑〔數值〕、數據夾、時區、門檻〔數值〕與三個套件之版本,不符即拋錯;末行半截者丟棄;各列另記來源檔之位元組數與修改時刻,來源已變者重做;`write` 之略過另核對輸出檔之位元組數與雜湊,不符即重做);例外中止時寫部分報告(`crashed`);統計含等效年化前後分布(同一母體)、跨入庫門檻清單(套件不給預設門檻:檔內無門檻者給 `opt.thEqYr` 才計入並記 `nThFallback`,否則列 `noThreshold`)、檔名與內容不一致者(只列);不新增、不刪除、不改名策略檔。
  - **選項**(數字類收數字字串並轉為數值,檢測之值即使用之值;訊息 `invalid opt.<名稱>: must be <種類>`、不含輸入值):`uIni` 有效正數(未給取 `cfg.settings.uIni`)、`unit` 經 `normalizeUnit`、`thEqYr` 有效數字、`takeLimit` 正整數(預設 2;傳給 `parfor` 者為數值)、`limit` 非負整數(0 為全部;`null` 不收)、`files` 非空之檔名字串陣列且須在 `fdIn` 內;`'200x'`、`'1.5'`〔整數類〕、負數、空字串、布林一律拒。第三參數 `deps`(`pathDeps`、`hooks`、`parfor`)只供測試注入。
  - **寫出之安全**:不提供原地寫回;`fdOut` 與 `fdIn` 為同一夾或互為上下層即拋錯(`src/recompute/pathRelation.mjs`:`realpathSync.native` 正規化、win32 不分大小寫、另以 `dev` + `ino` 比對目錄本體 ⇒ 大小寫、8.3 短名、目錄連結之別名皆拒;識別為 0 者不以識別比對;實體路徑取不到即拒絕執行,訊息只帶錯誤碼);建立 `fdOut` 之後再核一次;`fdReport` 不得等於或位於 `fdIn`／`fdOut` 之內(各模式皆檢);無可續之 journal 時 `fdOut` 須不存在或不含 `*.json`;暫存檔寫完再改名(目標被短暫開啟時重試);`write` 之 `ok` 須含 `namesSame === true`(輸出夾之檔皆屬 journal 已記為寫出者、且涵蓋本次所選;全庫時檔數等於 `fdIn`)。相對路徑皆相對於呼叫時之工作目錄。
  - **鎖檔**(`src/recompute/recomputeLock.mjs`):`recompute.lock`(記 PID 與 token)防同一 `fdReport` 兩個重算同時使用;內容先寫暫存檔再 `linkSync` 原子建立;鎖檔之行程仍在即拒(含本行程);鎖檔無法讀取、或內容無法讀出而修改時刻在 60 秒內者視為使用中;其餘殘留者接手:**鎖檔全程存在**(不先移走再放回——該寫法於取走與放回之間鎖檔缺席,第三個行程可建立新鎖而同時有兩個持有者,實測 60 次同時接手有 1 次),先以保護檔 `recompute.lock.takeover`(原子建立)使同時接手者只有一個進入、其餘即拒,持有者核對鎖檔仍為所判定之殘留鎖後以暫存檔改名覆蓋為新鎖;只釋放 token 相同之鎖與自己之保護檔。訊息只帶鎖檔名與 PID,不帶路徑。
  - 為何:下單單位改為基礎單位後既有策略庫須同口徑;重放路徑須先證明能重現現存摘要,重算之數字才可信;重算於任何情況下不得毀損或覆寫原策略庫。
  - 盤點:`git grep -n "recomputeStrategies" -- src`(站點:`src/recompute/`、`createPipeline.mjs`、`WTradeStrategy.mjs`);`git grep -nE "writeFileSync|renameSync|rmSync|appendFileSync" -- src/recompute`(寫入站點全集:報告與 journal 只寫 `fdReport`、策略檔只經 `writeAtomic` 寫 `fdOut`、鎖檔與保護檔只在 `fdReport`;無任何對 `fdIn` 之寫入或刪除——`rmSync` 僅用於 `fdOut` 之殘留暫存檔、鎖檔、保護檔與暫存檔)。
  - 測試:`unit-recompute`(含各種別名與包含關係之拒絕、建立 `fdOut` 後之再核、別名判定兩法之單元測試、鎖檔之原子建立與接手〔保護檔、全程存在、競態、多個子行程同時建立與接手〕、各 `write` 案〔含續跑、中止與被拒者〕前後來源夾逐位相同、選項之數字字串與訊息)。
  - **已知限制**(不修;使用端知悉):①單檔重放無逾時(某檔重放卡住時整批不結束;可依 PID 中止,續跑接續);②寫出不做 fsync(暫存檔再改名;斷電時已記 `ok` 而內容未落盤者,續跑時以位元組數與雜湊核對而重做);③別名測試未涵蓋 8.3 短名與 `\\?\` 前綴(環境無法穩定產生 8.3 短名;判定以 `realpathSync.native` 與目錄本體兩法,與目錄連結同法);④鎖檔:「先建空檔再寫內容」之非原子寫法於本設計下不可觀察(空窗內他行程讀到內容無法讀出且修改時刻很新,仍判使用中,與原子建立之可觀察行為相同——兩項防線重疊,變異 L04 存活),殘留鎖之 PID 被他程式占用時誤判為使用中(偏安全,須手動刪鎖檔),當機於保護檔存在期間而遺留者使其後之接手被拒(偏安全,須確認無其他重算行程後手動刪保護檔);⑤普測之 raw 策略(無 `solve` 時間窗)不在重算範圍(判 `unsupported`;新口徑下以重跑普測取得);普測之精簡摘要無 `numTradeAllMax`(單位數不另記);⑥跨入庫門檻者只列清單,不刪不改名,處置由使用端裁示;⑦`r8` 依回測套件之構造無法端到端觸發(`unit` 只改名義不改進場),呼叫處之判定以核心之注入點觸發(worker 路徑不注入);⑧每 worker 載入全部序列(沿用 `w-data-tdprovide` 之既有行為;大庫之併行數由使用端依記憶體定,`takeLimit` 預設 2);⑨求解不讀 `cfg.settings` 之 `uTrade`、`rFee`(沿用 `estimKeys` 之 1 與 0.0005;給 `unit` 時只傳 `uIni` 與 `unit`;全面讀 `cfg.settings` 為另案,會改變現有使用者之求解結果);⑩檔內 `settings.uIni` 為數字字串者無法忠實重放(`w-trade-backtest` 對 `uIni` 不轉型而以原字串運算,摘要失真)⇒ `mismatch`,不當作同值之數字;⑪`already` 之逐位複製於主程序讀取,來源檔於重算期間被改動時複製者可能非 worker 所驗證者(來源庫於重算期間應唯讀);⑫`fdIn` 內無 `*.json` 時 `ok` 為 true(`nSelected` 為 0)。

## 3. 盤點指令與判準

| 項 | 指令 | 判準 |
|---|---|---|
| 全套測試 | `npm test` | 0 失敗 |
| 結構與發布面 | `unit-package` | 皆綠 |
| 按需引入 | `git grep -nE "from '(w-[a-z-]+|wsemi|lodash-es)'" -- src`、`git grep -nE "from 'node:" -- src` | 皆無命中 |
| 編譯 | `node toolg/gDistRollup.mjs` 後 `require('./dist/w-trade-strategy.umd.js')`(TS-06) | 載入不拋、匯出鍵集合與 `typeof` 同 `src/WTradeStrategy.mjs` 預設匯出、`buildOhlc` → `buildParams` → `buildCache` 實跑產物與 ESM 相同 |
| 文件 | `node node_modules/jsdoc/jsdoc.js -c .jsdoc`、`node toolg/gDocsExams.mjs` | exit 0 |

## 4. 測試清單(`test/`;前綴＝層級:`unit-` 單元、不連網)

`unit-cfg`、`unit-buildOhlc`、`unit-buildParams`、`unit-sweep`、`unit-solve`、`unit-baseUnit`(TS-17/18)、`unit-recompute`(TS-19)、`unit-package`;共用件 `test/tools/synthKit.mjs`(合成 K 線與設定)、`test/tools/tmpdir.mjs`、`test/tools/jsdocExamples.mjs`、`test/tools/lockChild.mjs`(`unit-recompute` 之子行程:多個行程同時取鎖)。
