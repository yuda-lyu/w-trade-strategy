import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { readCsvFolder, HEADS_INDEX } from '../src/data/buildOhlc.mjs'
import { buildFdTmp } from './tools/synthKit.mjs'


//規格來源: src/data/buildOhlc.mjs 之 readCsvFolder(TS-29)
//  readCsvFolder(fdSrcCsv, heads): 讀 w-dwdata-binance saveData 產出之分段csv資料夾, 只讀 fdSrcCsv 第1層之 .csv 檔(分段檔與 _gaps.json 同夾,
//  分段檔名為時間tag, 依檔名排序即依時間排序), 不進入子資料夾; 合併為K線陣列, 僅保留 time 與 heads 欄位, 數值字串轉數值
//  wsemi 1.9.80 起列舉函數之 opt.levelLimit 未給即窮舉全部層級(舊版預設1層), 故 readCsvFolder 須明給 { levelLimit: 1 }
//  (R01 第1層之 .csv 依檔名排序合併且非 .csv 之檔不讀; R02 第2層之 .csv 不讀; R03 第3層之 .csv 不讀; R04 筆數恰為第1層之列數)
//合成資料: 各檔之各列 Close 逐筆相異(以百位表示所在檔: 1xx 第1層之 20230101.csv、2xx 第1層之 20230102.csv、3xx 第2層、4xx 第3層),
//  由 Close 即知該列來自哪一層之哪個檔


let fdTmp = buildFdTmp('readCsvFolder')

//heads: time + HEADS_INDEX(Open/High/Low/Close); 分段檔無表頭, 由 readCsvFolder 補上
let write = (rel, text) => {
    let fp = path.resolve(fdTmp, rel)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, text, 'utf8')
}


describe('readCsvFolder', function() {

    let arr = null

    before(async function() {
        //第1層: 兩個分段檔(檔名故意以相反順序寫出, 驗依檔名排序)與非 .csv 之檔
        write('src/20230102.csv', '2023-01-02T00:00:00,201,202,203,204\n')
        write('src/20230101.csv', '2023-01-01T00:00:00,101,102,103,104\n2023-01-01T04:00:00,111,112,113,114\n')
        write('src/_gaps.json', '[{"x":"y"}]')
        write('src/notes.txt', 'not a csv')
        //第2層與第3層: 子資料夾內之分段檔不應被讀入
        write('src/sub/20230103.csv', '2023-01-03T00:00:00,301,302,303,304\n')
        write('src/sub/deep/20230104.csv', '2023-01-04T00:00:00,401,402,403,404\n')

        arr = await readCsvFolder(path.resolve(fdTmp, 'src'), HEADS_INDEX)
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('R01 第1層之 .csv 依檔名排序合併, 數值字串轉數值, 僅保留 time 與 heads 欄位', function() {
        assert.deepStrictEqual(arr.map((v) => v.time), ['2023-01-01T00:00:00', '2023-01-01T04:00:00', '2023-01-02T00:00:00'])
        assert.deepStrictEqual(arr.map((v) => v.Close), [104, 114, 204])
        assert.deepStrictEqual(Object.keys(arr[0]).sort(), ['Close', 'High', 'Low', 'Open', 'time'])
        assert.strictEqual(arr[0].Open, 101)
    })

    it('R02 子資料夾(第2層)之 .csv 不讀', function() {
        assert.ok(!arr.some((v) => v.Close === 304), '第2層之 20230103.csv 不應被讀入')
        assert.ok(!arr.some((v) => v.time === '2023-01-03T00:00:00'))
    })

    it('R03 更深子資料夾(第3層)之 .csv 不讀', function() {
        assert.ok(!arr.some((v) => v.Close === 404), '第3層之 20230104.csv 不應被讀入')
        assert.ok(!arr.some((v) => v.time === '2023-01-04T00:00:00'))
    })

    it('R04 筆數: 恰為第1層兩個分段檔之列數', function() {
        assert.strictEqual(arr.length, 3)
    })

})
