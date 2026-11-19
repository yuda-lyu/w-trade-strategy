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
import { INTERVAL_SEC_DEFAULT, rawKeyOf } from '../cfg.mjs'
import { checkBasis } from '../util/basis.mjs'


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
 * 核對K線序列之時刻格線: 相鄰兩根之時差須為每根秒數之正整數倍(可有缺根)，且各界線(cfg.timeBegin、cfg.train之timeStart、timeEnd與timeEndByMode)須落在格線上(與格線起點之時差為每根秒數之整數倍)
 *
 * 格線起點為t0(未給時取arr首根)；不合即throw(訊息不含輸入值): `invalid <cointpe> series: must have bar times spaced by positive multiples of cfg.intervalSec`、`invalid index series: must have bar times on the bar grid of the price series (cfg.intervalSec)`、`invalid cfg.<界線>: must be on the bar grid of the <cointpe> series (cfg.intervalSec)`
 * 時差以cfg.timeZone之時刻換算為epoch毫秒(有日光節約之時區於切換日之日線間距不為86400秒之整數倍，即拋)
 *
 * @function
 * @param {Function} ott 輸入時間函數(makeOtt之回傳)
 * @param {Array} arr 輸入K線陣列(依time升序)
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件(取intervalSec、timeBegin、train)
 * @param {String} cointpe 輸入序列名稱字串('price'或'index')，用於錯誤訊息
 * @param {Number} [t0=null] 輸入格線起點之epoch毫秒，預設null(取arr首根)
 * @returns {Number} 回傳格線起點之epoch毫秒(arr為空且未給t0時為null)
 * @example
 *
 * import { makeOtt } from 'w-trade-strategy/src/util/ott.mjs'
 *
 * let cfg = { intervalSec: 86400, timeBegin: '2023-01-01T00:00:00', train: null }
 * let arr = [{ time: '2023-01-01T00:00:00' }, { time: '2023-01-02T00:00:00' }, { time: '2023-01-04T00:00:00' }]
 * console.log(checkBarGrid(makeOtt('UTC'), arr, cfg, 'price') === Date.UTC(2023, 0, 1))
 * // => true
 *
 */
let checkBarGrid = (ott, arr, cfg, cointpe, t0 = null) => {
    let step = cfg.intervalSec * 1000
    let es = map(arr, (v) => ott(v[KEY_TIME]).valueOf())
    for (let i = 1; i < es.length; i++) {
        let d = es[i] - es[i - 1]
        if (!(d > 0) || d % step !== 0) {
            throw new Error(`invalid ${cointpe} series: must have bar times spaced by positive multiples of cfg.intervalSec`)
        }
    }
    let origin = t0 !== null ? t0 : (es.length > 0 ? es[0] : null)
    if (origin === null) {
        return null
    }
    if (t0 !== null) {
        for (let i = 0; i < es.length; i++) {
            if (((es[i] - origin) % step + step) % step !== 0) {
                throw new Error(`invalid ${cointpe} series: must have bar times on the bar grid of the price series (cfg.intervalSec)`)
            }
        }
    }
    let bounds = [['timeBegin', cfg.timeBegin]]
    if (cfg.train) {
        bounds.push(['train.timeStart', cfg.train.timeStart], ['train.timeEnd', cfg.train.timeEnd])
        for (let mode of ['long', 'short']) {
            let t = get(cfg.train, `timeEndByMode.${mode}`, '')
            if (istime(t)) {
                bounds.push([`train.timeEndByMode.${mode}`, t])
            }
        }
    }
    for (let [name, t] of bounds) {
        if (!istime(t)) {
            continue
        }
        if (((ott(t).valueOf() - origin) % step + step) % step !== 0) {
            throw new Error(`invalid cfg.${name}: must be on the bar grid of the ${cointpe} series (cfg.intervalSec)`)
        }
    }
    return origin
}


/**
 * 列出K線序列於期間內(首末根之間)之洞: 相鄰兩根之時差大於每根秒數者
 *
 * 各洞記{time,bars}，time為洞內第1根缺漏之開盤時刻(依cfg.timeZone之字串)，bars為缺漏之根數；尾端(晚於最末一根)不屬期間內，不列
 *
 * @function
 * @param {Function} ott 輸入時間函數(makeOtt之回傳)
 * @param {Array} arr 輸入K線陣列(依time升序, 相鄰時差為每根秒數之正整數倍)
 * @param {Number} intervalSec 輸入每根秒數
 * @returns {Array} 回傳洞之陣列
 * @example
 *
 * import { makeOtt } from 'w-trade-strategy/src/util/ott.mjs'
 *
 * let arr = [{ time: '2023-01-01T00:00:00' }, { time: '2023-01-02T00:00:00' }, { time: '2023-01-05T00:00:00' }]
 * console.log(JSON.stringify(gapsOf(makeOtt('UTC'), arr, 86400)))
 * // => [{"time":"2023-01-03T00:00:00","bars":2}]
 *
 */
let gapsOf = (ott, arr, intervalSec) => {
    let step = intervalSec * 1000
    let rs = []
    for (let i = 1; i < arr.length; i++) {
        let t0 = ott(arr[i - 1][KEY_TIME])
        let n = Math.round((ott(arr[i][KEY_TIME]).valueOf() - t0.valueOf()) / step) - 1
        if (n > 0) {
            rs.push({ time: t0.add(intervalSec, 'second').format('YYYY-MM-DDTHH:mm:ss'), bars: n })
        }
    }
    return rs
}


//mismatchOf, 價格與溢價指數於共同區間(兩者首根之較晚者至末根之較早者)內之根集合差: 只見於價格者與只見於溢價指數者之開盤時刻
let mismatchOf = (arrP, arrI) => {
    let lo = arrP[0][KEY_TIME] > arrI[0][KEY_TIME] ? arrP[0][KEY_TIME] : arrI[0][KEY_TIME]
    let hi = last(arrP)[KEY_TIME] < last(arrI)[KEY_TIME] ? last(arrP)[KEY_TIME] : last(arrI)[KEY_TIME]
    let inRange = (arr) => arr.map((v) => v[KEY_TIME]).filter((t) => t >= lo && t <= hi)
    let sp = new Set(inRange(arrP))
    let si = new Set(inRange(arrI))
    return {
        onlyPrice: [...sp].filter((t) => !si.has(t)),
        onlyIndex: [...si].filter((t) => !sp.has(t)),
    }
}


/**
 * 價格與溢價指數之首、尾根數差(只供紀錄與提示, 不拋)
 *
 * 回傳{headBars,tailBars}: headBars為溢價指數首根晚於價格首根之根數(早於者為負), tailBars為溢價指數末根早於價格末根之根數(溢價指數已截齊至價格末根, 故不為負)
 *
 * @function
 * @param {Function} ott 輸入時間函數(makeOtt之回傳)
 * @param {Array} arrP 輸入價格K線陣列(依time升序, 非空)
 * @param {Array} arrI 輸入溢價指數K線陣列(依time升序, 非空)
 * @param {Number} intervalSec 輸入每根秒數
 * @returns {Object} 回傳{headBars,tailBars}
 * @example
 *
 * import { makeOtt } from 'w-trade-strategy/src/util/ott.mjs'
 *
 * let p = [{ time: '2023-01-01T00:00:00' }, { time: '2023-01-10T00:00:00' }]
 * let i = [{ time: '2023-01-03T00:00:00' }, { time: '2023-01-06T00:00:00' }]
 * console.log(JSON.stringify(edgesOf(makeOtt('UTC'), p, i, 86400)))
 * // => {"headBars":2,"tailBars":4}
 *
 */
let edgesOf = (ott, arrP, arrI, intervalSec) => {
    let step = intervalSec * 1000
    let bars = (ta, tb) => Math.round((ott(tb).valueOf() - ott(ta).valueOf()) / step)
    return {
        headBars: bars(arrP[0][KEY_TIME], arrI[0][KEY_TIME]),
        tailBars: bars(last(arrI)[KEY_TIME], last(arrP)[KEY_TIME]),
    }
}


/**
 * 將原始K線數據整理為序列json並儲存至cfg.fds.ohlc
 *
 * cfg.source為'binance'時讀取fetchBinance下載之分段csv(資料夾為rawKeyOf(cfg): 直接下載者為interval，須合併者為w-dwdata-binance之合併輸出夾，含偏移與dayStart，故須與抓取時同一timeZone、dayStart、aggregateFrom)；為外部數據時取cfg.source.price與cfg.source.index(K線陣列或回傳K線陣列之async函數)
 * 僅保留time>=cfg.timeBegin之K線，預設剔除尚未收棒之最末根；溢價指數序列會截齊至價格序列之最末時間
 * cfg.intervalSec非14400(4hr)時，寫出前以checkBarGrid核對時刻格線(相鄰時差為每根秒數之整數倍、cfg.timeBegin與訓練期各界線落在價格序列之格線上、溢價指數與價格同一格線)，不合即throw；4hr不核對(維持既有行為)
 * cfg.intervalSec非14400時，另依序列之相鄰時差判定期間內(首末根之間)之洞(gapsOf)與價格、溢價指數於共同區間內之根集合差：
 *   cfg.source為'binance'(交易所資料本身即有缺且補不回，故遇無數據之段略過並記錄，不拋錯)時預設放行(opt.allowGaps預設true)：把各洞與根集合差記入meta/ohlc.json之gaps並隨回傳，且以console.warn提示一則(內容只含序列名price/index與洞數，不含時刻或其他輸入值；無洞不提示)；兩序列於共同區間內之根集合不一致者，缺根之一方必有期間內之洞，故同此處置
 *   明給opt.allowGaps: false(嚴格模式; 只有false為嚴格，未給、null、其他值皆視為預設放行)時，遇洞即於寫檔前throw `invalid <price|index> series: must not have missing bars within the period when opt.allowGaps is false`
 *   外部數據(股票等有交易日曆者，洞為常態)不拋，只於meta/ohlc.json之gaps記洞數與缺根數；尾端(晚於最末一根)之未收棒或缺根不屬期間內(合併時之未輸出之目標根另見fetchBinance之meta/aggregate.json)
 *   gaps另記edges(有溢價指數時): 價格與溢價指數之首、尾根數差(edgesOf; 共同區間外之差不屬上述判定), 尾端差逾1根時以console.warn印一則提示(不拋; 近期之溢價指數類因子缺值)
 *   4hr不判定、不加欄(維持既有行為; 使用者2026-11-19裁定: 幣安資料本身即有缺根處，故4hr之缺根不會被攔下; 4hr而由下載套件合併者〔如東京之4hr〕亦同，其未輸出之目標根見meta/aggregate.json)
 * 寫出前另以工作根之口徑標記檢查(checkBasis之stage 'ohlc'；標記存在而口徑不同或無法解析即throw；無標記而為非預設口徑者，該口徑所綁之既有產物〔param夾、meta/params.json、各策略夾等〕須為空，否則throw；皆先於寫任何K線檔；本階段不寫標記)
 * 寫出`${cfg.keyOhlc}.json`(與cfg.useIndex時之`${cfg.keyIndex}.json`)，並將{timeFirst,timeLast,nPrice,nIndex}(非4hr時另含gaps)記錄於cfg.fds.meta/ohlc.json
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Boolean} [opt.dropIncompleteLastBar=true] 輸入是否剔除尚未收棒之最末根布林值，預設true
 * @param {Boolean} [opt.allowGaps=true] 輸入是否放行交易所來源於期間內之洞(非4hr時; 放行時各洞記入meta/ohlc.json之gaps並以console.warn提示洞數; 明給false時遇洞throw)布林值，預設true
 * @returns {Promise} 回傳Promise，resolve為{keyOhlc,keyIndex,timeFirst,timeLast,nPrice,nIndex,changed,at}(非4hr時另含gaps：{price:{nGaps,nBars[,list]},index:{nGaps,nBars[,list]}|null,mismatch:{nOnlyPrice,nOnlyIndex[,onlyPrice,onlyIndex]}|null,edges:{headBars,tailBars}|null}，list與時刻清單只於交易所來源記)，changed為與前次meta相比數據是否有變
 * @example
 * need test in nodejs.
 *
 * let r = await buildOhlc(cfg)
 * console.log(r.nPrice, r.timeLast)
 */
let buildOhlc = async (cfg, opt = {}) => {

    let dropIncomplete = get(opt, 'dropIncompleteLastBar', true) !== false
    let allowGaps = get(opt, 'allowGaps', true) !== false //只有明給false為嚴格模式, 其餘(未給、null、其他值)視為預設放行(K3)
    let ott = makeOtt(cfg.timeZone)

    //basis, 工作根之口徑檢查(標記存在而口徑不同或無法解析即throw; 無標記而為非預設口徑者, 該口徑所綁之既有產物須為空; 皆先於任何讀寫; 本階段不寫標記)
    checkBasis(cfg, 'ohlc')

    //getArr
    let getArr = async (cointpe) => {
        if (cfg.source === 'binance') {
            let fdSrcCsv = path.resolve(cfg.fds.raw, cfg.name, cointpe, rawKeyOf(cfg)) //下載結果之資料夾: 直接下載者為interval(既有), 須合併者為下載套件之合併輸出夾(含偏移與dayStart)
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

    //grid, 非4hr時核對時刻格線(相鄰時差為每根秒數之整數倍、各界線落在價格序列之格線上、溢價指數與價格同一格線; 不合即throw, 先於寫檔); 4hr維持既有行為(不核對)
    if (cfg.intervalSec !== INTERVAL_SEC_DEFAULT) {
        let t0 = checkBarGrid(ott, arrP, cfg, 'price')
        if (arrI) {
            checkBarGrid(ott, arrI, cfg, 'index', t0)
        }
    }

    //gaps, 非4hr時依相鄰時差判定期間內之洞與價格、溢價指數之根集合差: 交易所來源預設放行並記錄(有洞時console.warn一則, 內容只含序列名與洞數), 明給allowGaps: false(嚴格模式)時throw(先於寫檔); 外部數據只記數量(不拋、不提示); 4hr維持既有行為(不判定、不加欄)
    let gaps = null
    if (cfg.intervalSec !== INTERVAL_SEC_DEFAULT) {
        let exch = cfg.source === 'binance'
        let gp = gapsOf(ott, arrP, cfg.intervalSec)
        let gi = arrI ? gapsOf(ott, arrI, cfg.intervalSec) : null
        let mm = arrI ? mismatchOf(arrP, arrI) : null
        if (exch && !allowGaps) {
            if (gp.length > 0) {
                throw new Error(`invalid price series: must not have missing bars within the period when opt.allowGaps is false`)
            }
            if (gi && gi.length > 0) {
                throw new Error(`invalid index series: must not have missing bars within the period when opt.allowGaps is false`) //兩序列於共同區間內之根集合不一致者, 缺根之一方必有期間內之洞, 故亦於此二處拋
            }
        }
        if (exch && allowGaps && (gp.length > 0 || (gi && gi.length > 0))) {
            let ns = []
            if (gp.length > 0) {
                ns.push(`price gaps: ${gp.length}`)
            }
            if (gi && gi.length > 0) {
                ns.push(`index gaps: ${gi.length}`)
            }
            //只列有洞者之序列名與洞數, 不含時刻或其他輸入值
            console.warn(`[w-trade-strategy] buildOhlc: skipped missing bars within the period (${ns.join(', ')}); recorded in meta/ohlc.json (gaps)`)
        }
        let brief = (g) => (g === null ? null : { nGaps: g.length, nBars: g.reduce((t, v) => t + v.bars, 0), ...(exch ? { list: g } : {}) })
        gaps = {
            price: brief(gp),
            index: brief(gi),
            mismatch: mm === null ? null : { nOnlyPrice: mm.onlyPrice.length, nOnlyIndex: mm.onlyIndex.length, ...(exch ? mm : {}) },
            edges: arrI ? edgesOf(ott, arrP, arrI, cfg.intervalSec) : null,
        }
        if (gaps.edges !== null && gaps.edges.tailBars > 1) {
            console.warn(`[w-trade-strategy] buildOhlc: the index series ends ${gaps.edges.tailBars} bars before the price series; index-based factors have no values for the latest bars (see gaps.edges in meta/ohlc.json)`)
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
        ...(gaps !== null ? { gaps } : {}),
        at: nowIso(),
    }
    let fpMeta = path.resolve(cfg.fds.meta, 'ohlc.json')
    let prev = readJsonOr(fpMeta, null)
    let changed = !prev || prev.timeLast !== meta.timeLast || prev.nPrice !== meta.nPrice || prev.nIndex !== meta.nIndex || prev.timeFirst !== meta.timeFirst
    writeJson(fpMeta, meta)

    return { ...meta, changed }
}


export { HEADS_PRICE, HEADS_INDEX, readCsvFolder, normalizeExternal, isBarComplete, checkBarGrid, gapsOf, edgesOf }
export default buildOhlc
