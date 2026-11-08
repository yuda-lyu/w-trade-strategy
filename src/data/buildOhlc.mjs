import fs from 'fs'
import path from 'path'
import get from 'lodash-es/get.js'
import each from 'lodash-es/each.js'
import map from 'lodash-es/map.js'
import filter from 'lodash-es/filter.js'
import flatten from 'lodash-es/flatten.js'
import sortBy from 'lodash-es/sortBy.js'
import last from 'lodash-es/last.js'
import isnum from 'wsemi/src/isnum.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isearr from 'wsemi/src/isearr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import istime from 'wsemi/src/istime.mjs'
import cdbl from 'wsemi/src/cdbl.mjs'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import fsTreeFolder from 'wsemi/src/fsTreeFolder.mjs'
import pmSeries from 'wsemi/src/pmSeries.mjs'
import wdc from 'w-data-csv/src/WDataCsv.mjs'
import { makeOtt } from '../util/ott.mjs'
import { readJsonOr, writeJson, nowIso } from '../util/fsx.mjs'


/**
 * 幣安現貨K線csv欄位(首欄time由讀取時補上)
 *
 * @type {Array}
 */
let HEADS_PRICE = [
    'Open', //開盤價
    'High', //最高價
    'Low', //最低價
    'Close', //收盤價
    'Volumn', //成交量
    'CloseTime', //收盤時間
    'QuoteAssetVolume', //成交額(報價幣種)
    'NumberOfTrades', //成交筆數
    'TakerBuyBaseAssetVolume', //主動買入量
    'TakerBuyQuoteAssetVolume', //主動買入額
]

/**
 * 幣安溢價指數K線csv欄位
 *
 * @type {Array}
 */
let HEADS_INDEX = [
    'Open',
    'High',
    'Low',
    'Close',
]

//KEY_TIME, 開盤時間欄位
let KEY_TIME = 'time'


//cvRow, 數值字串轉數值、字串去前後空白
let cvRow = (dt) => {
    each(dt, (v, k) => {
        if (isnum(v)) {
            dt[k] = cdbl(v)
        }
        else if (isestr(v)) {
            dt[k] = v.trim()
        }
    })
    return dt
}


/**
 * 讀取w-dwdata-binance saveData產出之分段csv資料夾，合併為K線陣列(僅保留heads欄位，數值字串轉數值)
 *
 * @function
 * @param {String} fdSrcCsv 輸入分段csv資料夾路徑字串
 * @param {Array} heads 輸入欄位名稱陣列(不含time)
 * @returns {Promise} 回傳Promise，resolve為K線陣列
 * @example
 * need test in nodejs.
 *
 * let arr = await readCsvFolder('./data/raw/ETH/price/4hr', HEADS_PRICE)
 */
let readCsvFolder = async (fdSrcCsv, heads) => {

    let hs = [KEY_TIME, ...heads]
    let kpHead = {}
    for (let h of hs) {
        kpHead[h] = true
    }
    let chead = hs.join(',')

    let vfps = fsTreeFolder(fdSrcCsv)
    vfps = filter(vfps, { isFolder: false })
    vfps = filter(vfps, (v) => v.name.endsWith('.csv'))
    vfps = sortBy(vfps, 'name') //分段檔名為時間tag, 依名排序即依時間排序

    let rs = []
    await pmSeries(vfps, async (v) => {
        let c = fs.readFileSync(v.path, 'utf8')
        c = chead + '\n' + c
        let ltdt = await wdc.parseCsv(c)
        let _ltdt = []
        each(ltdt, (dt) => {
            let _dt = {}
            each(dt, (vv, kk) => {
                if (kpHead[kk]) {
                    _dt[kk] = vv
                }
            })
            if (isestr(_dt[KEY_TIME])) {
                _ltdt.push(cvRow(_dt))
            }
        })
        rs.push(_ltdt)
    })

    return flatten(rs)
}


/**
 * 檢核與整理外部提供之K線陣列(各筆須含time與數值之Open/High/Low/Close；依time升序排序)
 *
 * @function
 * @param {Array} arr 輸入K線陣列
 * @param {String} cointpe 輸入數據類型字串('price'或'index')，僅用於錯誤訊息
 * @returns {Array} 回傳整理後之K線陣列
 * @example
 *
 * let arr = normalizeExternal([
 *     { time: '2023-01-01T04:00:00', Open: 2, High: 3, Low: 1, Close: 2 },
 *     { time: '2023-01-01T00:00:00', Open: '1', High: 2, Low: 0.5, Close: 1.5 },
 * ], 'price')
 * console.log(arr.map((v) => v.time).join(' '), typeof arr[0].Open)
 * // => 2023-01-01T00:00:00 2023-01-01T04:00:00 number
 *
 */
let normalizeExternal = (arr, cointpe) => {
    if (!isearr(arr)) {
        throw new Error(`cfg.source.${cointpe}須為非空K線陣列或回傳非空K線陣列之函數`)
    }
    let rs = map(arr, (v, i) => {
        if (!istime(get(v, KEY_TIME, ''))) {
            throw new Error(`cfg.source.${cointpe}[${i}].time[${get(v, KEY_TIME)}]須為'YYYY-MM-DDTHH:mm:ss'`)
        }
        for (let k of ['Open', 'High', 'Low', 'Close']) {
            if (!isnum(v[k])) {
                throw new Error(`cfg.source.${cointpe}[${i}].${k}[${v[k]}]須為數值`)
            }
        }
        return cvRow({ ...v })
    })
    rs = sortBy(rs, KEY_TIME)
    return rs
}


/**
 * 依週期判斷K線是否已收(開盤時間+週期 <= 現在)
 *
 * @function
 * @param {Function} ott 輸入時間函數(makeOtt之回傳)
 * @param {String} time 輸入K線開盤時間字串
 * @param {Number} intervalSec 輸入週期秒數
 * @returns {Boolean} 回傳是否已收布林值
 * @example
 *
 * import { makeOtt } from 'w-trade-strategy/src/util/ott.mjs'
 *
 * console.log(isBarComplete(makeOtt('UTC'), '2020-01-01T00:00:00', 14400), isBarComplete(makeOtt('UTC'), '2999-01-01T00:00:00', 14400))
 * // => true false
 *
 */
let isBarComplete = (ott, time, intervalSec) => {
    return ott(time).add(intervalSec, 'second').valueOf() <= ott().valueOf()
}


/**
 * 將原始K線數據整理為序列json並儲存至cfg.fds.ohlc
 *
 * cfg.source為'binance'時讀取fetchBinance下載之分段csv；為外部數據時取cfg.source.price與cfg.source.index(K線陣列或回傳K線陣列之async函數)
 * 僅保留time>=cfg.timeBegin之K線，預設剔除尚未收棒之最末根；溢價指數序列會截齊至價格序列之最末時間
 * 寫出`${cfg.keyOhlc}.json`(與cfg.useIndex時之`${cfg.keyIndex}.json`)，並將{timeFirst,timeLast,nPrice,nIndex}記錄於cfg.fds.meta/ohlc.json
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Boolean} [opt.dropIncompleteLastBar=true] 輸入是否剔除尚未收棒之最末根布林值，預設true
 * @returns {Promise} 回傳Promise，resolve為{keyOhlc,keyIndex,timeFirst,timeLast,nPrice,nIndex,changed,at}，changed為與前次meta相比數據是否有變
 * @example
 * need test in nodejs.
 *
 * let r = await buildOhlc(cfg)
 * console.log(r.nPrice, r.timeLast)
 */
let buildOhlc = async (cfg, opt = {}) => {

    let dropIncomplete = get(opt, 'dropIncompleteLastBar', true) !== false
    let ott = makeOtt(cfg.timeZone)

    //getArr
    let getArr = async (cointpe) => {
        if (cfg.source === 'binance') {
            let fdSrcCsv = path.resolve(cfg.fds.raw, cfg.name, cointpe, cfg.interval)
            if (!fsIsFolder(fdSrcCsv)) {
                throw new Error(`尚無下載數據資料夾[${fdSrcCsv}], 請先執行fetchData`)
            }
            let arr = await readCsvFolder(fdSrcCsv, cointpe === 'price' ? HEADS_PRICE : HEADS_INDEX)
            return sortBy(arr, KEY_TIME)
        }
        let src = cfg.source[cointpe]
        if (isfun(src)) {
            src = await src(cfg, cointpe)
        }
        return normalizeExternal(src, cointpe)
    }

    //arrP
    let arrP = await getArr('price')
    arrP = filter(arrP, (v) => v[KEY_TIME] >= cfg.timeBegin)
    if (dropIncomplete && arrP.length > 0 && !isBarComplete(ott, last(arrP)[KEY_TIME], cfg.intervalSec)) {
        arrP.pop()
    }
    if (arrP.length === 0) {
        throw new Error(`價格K線於timeBegin[${cfg.timeBegin}]之後無數據`)
    }
    let tEndP = last(arrP)[KEY_TIME]

    //arrI
    let arrI = null
    if (cfg.useIndex) {
        arrI = await getArr('index')
        arrI = filter(arrI, (v) => v[KEY_TIME] >= cfg.timeBegin && v[KEY_TIME] <= tEndP)
        if (arrI.length === 0) {
            throw new Error(`溢價指數K線於timeBegin[${cfg.timeBegin}]之後無數據`)
        }
    }

    //write
    writeJson(path.resolve(cfg.fds.ohlc, `${cfg.keyOhlc}.json`), arrP, { format: false })
    if (arrI) {
        writeJson(path.resolve(cfg.fds.ohlc, `${cfg.keyIndex}.json`), arrI, { format: false })
    }

    //meta
    let timeFirst = arrP[0][KEY_TIME]
    let timeLast = tEndP
    if (arrI) {
        timeFirst = arrI[0][KEY_TIME] > timeFirst ? arrI[0][KEY_TIME] : timeFirst
        timeLast = last(arrI)[KEY_TIME] < timeLast ? last(arrI)[KEY_TIME] : timeLast
    }
    let meta = {
        name: cfg.name,
        symbol: cfg.symbol,
        interval: cfg.interval,
        timeZone: cfg.timeZone,
        keyOhlc: cfg.keyOhlc,
        keyIndex: arrI ? cfg.keyIndex : null,
        timeFirst,
        timeLast,
        nPrice: arrP.length,
        nIndex: arrI ? arrI.length : 0,
        at: nowIso(),
    }
    let fpMeta = path.resolve(cfg.fds.meta, 'ohlc.json')
    let prev = readJsonOr(fpMeta, null)
    let changed = !prev || prev.timeLast !== meta.timeLast || prev.nPrice !== meta.nPrice || prev.nIndex !== meta.nIndex || prev.timeFirst !== meta.timeFirst
    writeJson(fpMeta, meta)

    return { ...meta, changed }
}


export { HEADS_PRICE, HEADS_INDEX, readCsvFolder, normalizeExternal, isBarComplete }
export default buildOhlc
