# 經驗(w-trade-strategy)

> 執行時之累積經驗,留給後續嘗試、執行、判斷;規則見 `../rule/rulebook.md`,現況見 `../state/state.md`。

1. **抽提管線為套件,先找出全部「標的專屬常數」**:使用端既有管線把 z-score 之 avg／std、溢價指數側之偏移參數、訓練期終點、序列 key 前綴、標的名稱寫死於各段程式;套件化時逐一改為設定參數或「首次自算並凍結於 meta」,否則換標的就失真。驗法:以原定義(含原常數)餵回套件,與既有管線之產物逐值比對為 0 差才算抽對(2026-11-08 某實測:全部序列檔逐值相同)。
2. **內建定義目錄不手抄**:由原定義檔以腳本產生(去除常數、加 id／fields),再以逐值比對驗證;手抄 136 個輸出必有錯漏。
3. **外部數據之通用性靠欄位宣告**:每個定義列出 calc 實際存取之 K 線欄位(依 calc 原始碼核對,不憑名稱猜),數據缺欄即整個定義剔除並列原因,而不是算出 NaN 序列。
4. **worker_threads 之長駐迴圈不會自行退出**:`parentPort.on('message')` 撐住執行緒,主程序收到 `done`／`error` 必 `terminate()`;冒煙時以 `| tail` 管線跑看不到任何輸出,長流程之冒煙要寫 log 檔。
5. **停止條件要在 worker 之迴圈邊界生效**:worker 自行連續起下一輪時,主程序之 stop 訊息趕不上,總輪數超出 `maxRounds` 達 `2 × workers`;改為每輪結束等主程序放行(`continue`)才起下一輪,超出至多 `workers − 1`。
6. **依隨機性或時間之測試斷言先算清**:`maxTimeMs: 1` 於準備快於 1 ms 時會跑完第 1 輪才停(斷言寫 `nRounds ≤ 1`);合成數據之因子類別數、週期數、終點時刻皆由程式決定,寫斷言前先算。
7. **週期由 K 線週期換算,不由標籤硬改**:w-data-trade 之週期表以 4hr 寫死,套件以 `barsPerDay = 86400 / intervalSec` 併入每次 calc 呼叫;標籤維持時間語意(`'1day'` 於 1hr K 線為 24 根),單根型態之標籤改為該週期(`'1hr'`)。
8. **估時(某實測,真實 4hr 數據)**:buildParams 全目錄(含 index 校正)約 43 秒;sweepSingle 每因子約 0.7 秒(4 worker);solve 加速版一輪約 33 秒;合成 900 根整條管線 15 秒內。
9. **UMD dist 不可把 ESM 自有套件列為 external**:rollup UMD 的 CJS 路徑以 `require()` 取外部模組並直接當預設匯出用;Node 對 ESM 檔 `require()` 回命名空間物件(`{ default }`),故把自有套件(皆 ESM)的 `src/` 深層路徑列為 external 時,dist 可載入、鍵集合也對,但執行 `buildParams` 即拋 `dataConvert is not a function`,且 `dist.readStrategies` 之 `typeof` 變 `object`。**只比對匯出鍵不夠,要比 `typeof` 並實跑**。正解:自有套件、wsemi、lodash-es 一律打包進 dist(external 只留 node 內建模組與 dayjs),ESM 專用第三方套件(`strip-bom-stream` 等)亦打包。自有套件以正則型 external 列出之寫法,`rollupFiles` 雖接受,但產物不可用(2026-11-08 實測)。
10. **測試中的 worker 數必須寫死**:`sweepSingle`／`sweepPairs` 預設 `takeLimit` 為 `os.availableParallelism() - 1`,會隨核數放大;所有測試與範例皆給 `takeLimit: 2`、`solve` 之 `workers` 為 0／1／2,新增測試延用。
11. **公開庫之去識別守門只守通用樣式**:把使用端專案名、目錄名、腳本名寫進守門正則或自檢字串,守門本身就把名稱公開了。`unit-package` ⑥ 只守磁碟機絕對路徑、使用者家目錄路徑、IPv4、權杖與私鑰樣式,自檢字串用中性假值(權杖以拼接組成避免被金鑰掃描誤報);名稱之偵測由發布前之私有檢查負責。
