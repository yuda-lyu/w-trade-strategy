# 回饋(w-trade-strategy)

> 任務中發現之自有套件、全域技能、全域設定之調整與抽提提案;只增不改,處置結果另記一列並寫明承接哪一列。回饋是紀錄與提案,不等於自行修改(實際修改走各自之通報管道)。

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-18 | 自有套件 | w-trade-backtest | `runStrategy` 對 `settings.uIni` 之數字字串不轉型:以原字串運算(摘要之 `uEquityFinal`、回撤、年化等靜默失真,`summary.uIni` 亦記成字串),與同函數對 `settings.unit` 之數字字串轉型(K4)不一致,且不報錯。建議於入口對 `uIni`、`uTrade`、`rFee`、`rTakeProfit`、`rStopLoss` 等數值欄檢測並轉型(或拒收),使同一套設定之數字字串寫法不致無聲出錯 | `node_modules/w-trade-backtest/src/runStrategy.mjs:109-118`(`st` 取自 `strategy.settings` 後直接使用)、`:355`、`:364`、`:374`;`test/unit-recompute.test.mjs` 〈C1 檔內 `settings.uIni` 為數字字串者不能忠實重放〉(重放摘要之 `uIni` 與多個金額欄不同) |
| 2026-11-18 | 自有套件 | wsemi | 本庫需「檢測數字字串後轉為數值並只用轉換值」之站點已有多處(`toNumericUnit`:`cdbl`／`cint` 配 `isenum`／`iseint`;`recomputeStrategies` 之 `uIni`、`thEqYr`、`takeLimit`、`limit`;`normalizeCfg` 之 `uIni`),各自「`isenum`／`iseint` 判定 + `cdbl`／`cint` 取值」兩步寫法,易有只判不轉(K4)之漏。建議 wsemi 提供單一之「判定並轉換」函數(回傳轉換值或失敗標記),與 `w-trade-solve` 之 `estimKeys` 同提案(併入其已通報之第 519 項③) | `src/cfg.mjs`(`toNumericUnit`、`normalizeCfg`)、`src/recompute/recomputeStrategies.mjs`(目標口徑與 `thEqYr`、`takeLimit`、`limit`之檢測段) |
| 2026-11-18 | 全域技能 | role-coder-for-test | 互斥(鎖檔、接手殘留鎖、單例)類之測試出現「偶發失敗」時,先以獨立探測腳本於同條件下重複 N 次,量「持有者數 ≠ 1」之比率與結果分布(本案:提案之鎖檔接手設計,60 次同時接手有 1 次兩個行程同時持有、3 次取得者之 `staleLock` 為 false;其測試偶發失敗之真因即產品缺陷,非測試脆弱),不得只放寬斷言或重試。建議於「flake 排查／測試先紅」處加一條:互斥類斷言之偶發失敗先視為被測設計之競態,以失敗率前後對照驗證修正 | `test/unit-recompute.test.mjs`〈C11 鎖檔〉;探測方法見 `sgud/exp/experience.md` 第 16 條與 `test/tools/lockRaceProbe.mjs` |
