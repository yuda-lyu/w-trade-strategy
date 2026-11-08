import path from 'path'
import get from 'lodash-es/get.js'
import isestr from 'wsemi/src/isestr.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import isnum from 'wsemi/src/isnum.mjs'
import isday from 'wsemi/src/isday.mjs'
import istime from 'wsemi/src/istime.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'


/**
 * 各K線週期之秒數(與w-dwdata-binance saveData支援之interval一致)
 *
 * @type {Object}
 */
let INTERVALS = {
    '1m': 60,
    '5m': 5 * 60,
    '15m': 15 * 60,
    '30m': 30 * 60,
    '1hr': 60 * 60,
    '4hr': 4 * 60 * 60,
}


/**
 * 工作根之子資料夾名稱(各可由cfg.fds覆寫為任意路徑)
 *
 * @type {Array}
 */
let FDS = [
    'raw', //抓取之原始分段csv(w-dwdata-binance saveData之fdData)
    'ohlc', //K線序列json(`${name}_price_${interval}.json`、`${name}_index_${interval}.json`)
    'param', //指標參數序列json(每key一檔, 供w-data-tdprovide讀取)
    'cache', //止盈止損先觸結果快取(cacheKLinesTpSl.json)
    'strategies', //最佳化求解之策略庫(w-trade-solve estimKeys之fdData)
    'strategiesP1', //單因子普測之raw策略
    'strategiesP2', //雙因子普測之raw策略
    'meta', //各階段之狀態與凍結之校正值(nm、optMethod)
]


/**
 * cfg之全部可用鍵(normalizeCfg讀取者之聯集)，不在此者於正規化時拋錯；新增讀取cfg.<鍵>處須同步列入
 *
 * @type {Array}
 */
let CFG_KEYS = Object.freeze([
    'root', 'name', 'symbol', 'interval', 'intervalSec', 'timeZone',
    'source', 'useIndex', 'dayStart', 'timeBegin', 'train',
    'fds', 'settings',
])


/**
 * normalizeCfg產出之衍生鍵(重入時略過不計)
 *
 * @type {Array}
 */
let DERIVED_KEYS = Object.freeze(['keyOhlc', 'keyIndex', 'barsPerDay'])


/**
 * 取得K線週期之秒數
 *
 * @function
 * @param {String} interval 輸入K線週期字串，例如'4hr'
 * @param {Number} [fallback=null] 輸入interval非內建週期時改用之秒數，預設null
 * @returns {Number} 回傳秒數
 * @example
 *
 * console.log(intervalSec('4hr'), intervalSec('1hr'), intervalSec('2hr', 7200))
 * // => 14400 3600 7200
 *
 */
let intervalSec = (interval, fallback = null) => {
    if (INTERVALS[interval] !== undefined) {
        return INTERVALS[interval]
    }
    if (isnum(fallback) && fallback > 0) {
        return fallback
    }
    throw new Error(`invalid interval[${interval}], 非內建週期(${Object.keys(INTERVALS).join(', ')})時須給cfg.intervalSec`)
}


/**
 * 正規化管線設定
 *
 * 必填: root(工作根資料夾)、name(幣種或標的名稱, 用於組序列key與策略識別)、symbol(交易對)、interval(K線週期)
 * source為'binance'(預設, 由幣安抓取現貨K線與溢價指數K線)或物件{price,index}(外部數據, 各為K線陣列或回傳K線陣列之async函數, 供股價等非幣安標的)
 * useIndex預設true(須同時有price與index), 外部數據未給index時自動為false; 為false時基於index之參數將於buildParams被剔除
 * train為訓練期{timeStart,timeEnd[,timeEndByMode:{long,short}]}, 為最佳化求解與普測之評估區間; 未給時僅能執行數據與參數階段
 * cfg之鍵只認CFG_KEYS，打錯之鍵拋錯(靜默接受會使正名鍵維持預設而無人察覺)
 *
 * @function
 * @param {Object} cfg 輸入設定物件
 * @returns {Object} 回傳正規化後之設定物件，含fds(各資料夾絕對路徑)、keyOhlc、keyIndex、intervalSec、barsPerDay與settings
 * @example
 *
 * let cfg = normalizeCfg({ root: './data', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr', train: { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00' } })
 * console.log(cfg.keyOhlc, cfg.keyIndex, cfg.intervalSec, cfg.barsPerDay, cfg.useIndex, cfg.source, cfg.timeZone)
 * // => ETH_price_4hr ETH_index_4hr 14400 6 true binance Asia/Taipei
 *
 * let cfgStock = normalizeCfg({ root: './data', name: 'TSMC', symbol: '2330', interval: '1day', intervalSec: 86400, source: { price: [] } })
 * console.log(cfgStock.useIndex, cfgStock.barsPerDay, Object.keys(cfgStock.fds).join(','))
 * // => false 1 raw,ohlc,param,cache,strategies,strategiesP1,strategiesP2,meta
 *
 */
let normalizeCfg = (cfg = {}) => {

    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error(`invalid cfg`)
    }

    //keys, 不認得之鍵即拋錯(已正規化之cfg再傳入時, 其衍生鍵略過不計, 使normalizeCfg可重入)
    let unknown = Object.keys(cfg).filter((k) => !CFG_KEYS.includes(k) && !DERIVED_KEYS.includes(k))
    if (unknown.length > 0) {
        throw new Error(`cfg含不認得之鍵[${unknown.join(', ')}], 可用: ${CFG_KEYS.join(', ')}`)
    }

    //root
    let root = get(cfg, 'root', '')
    if (!isestr(root)) {
        throw new Error(`invalid cfg.root[${root}]`)
    }
    root = path.resolve(root)

    //name, symbol, interval
    let name = get(cfg, 'name', '')
    if (!isestr(name)) {
        throw new Error(`invalid cfg.name[${name}]`)
    }
    let symbol = get(cfg, 'symbol', '')
    if (!isestr(symbol)) {
        throw new Error(`invalid cfg.symbol[${symbol}]`)
    }
    let interval = get(cfg, 'interval', '')
    if (!isestr(interval)) {
        throw new Error(`invalid cfg.interval[${interval}]`)
    }
    let isec = intervalSec(interval, get(cfg, 'intervalSec', null))

    //timeZone, 時間字串所用之固定時區(與數據一致, 變更時須換新工作根)
    let timeZone = get(cfg, 'timeZone', '')
    if (!isestr(timeZone)) {
        timeZone = 'Asia/Taipei'
    }

    //source
    let source = get(cfg, 'source', 'binance')
    if (source !== 'binance' && !iseobj(source)) {
        throw new Error(`invalid cfg.source, 須為'binance'或{price,index}`)
    }
    if (iseobj(source) && source.price === undefined) {
        throw new Error(`invalid cfg.source.price, 外部數據須提供price(K線陣列或回傳K線陣列之函數)`)
    }

    //useIndex
    let useIndex = get(cfg, 'useIndex', null)
    if (!isbol(useIndex)) {
        useIndex = !(iseobj(source) && source.index === undefined) //外部數據未給index時預設false
    }
    if (useIndex && iseobj(source) && source.index === undefined) {
        throw new Error(`cfg.useIndex為true但cfg.source未提供index`)
    }

    //dayStart, 抓取起始日
    let dayStart = get(cfg, 'dayStart', '')
    if (!isday(dayStart)) {
        dayStart = '2020-01-01'
    }

    //timeBegin, 數據保留起點(早於此之K線不寫入ohlc)
    let timeBegin = get(cfg, 'timeBegin', '')
    if (!istime(timeBegin)) {
        timeBegin = `${dayStart}T00:00:00`
    }

    //train
    let train = get(cfg, 'train', null)
    if (train !== null && train !== undefined) {
        if (!iseobj(train)) {
            throw new Error(`invalid cfg.train`)
        }
        let ts = get(train, 'timeStart', '')
        let te = get(train, 'timeEnd', '')
        if (!istime(ts)) {
            throw new Error(`invalid cfg.train.timeStart[${ts}], 須為'YYYY-MM-DDTHH:mm:ss'`)
        }
        if (!istime(te)) {
            throw new Error(`invalid cfg.train.timeEnd[${te}], 須為'YYYY-MM-DDTHH:mm:ss'`)
        }
        if (!(ts < te)) {
            throw new Error(`cfg.train.timeStart[${ts}]須早於timeEnd[${te}]`)
        }
        let tebm = get(train, 'timeEndByMode', null)
        let timeEndByMode = {}
        if (iseobj(tebm)) {
            for (let mode of ['long', 'short']) {
                let t = get(tebm, mode, '')
                if (isestr(t)) {
                    if (!istime(t)) {
                        throw new Error(`invalid cfg.train.timeEndByMode.${mode}[${t}]`)
                    }
                    timeEndByMode[mode] = t
                }
            }
        }
        train = { timeStart: ts, timeEnd: te, timeEndByMode }
    }
    else {
        train = null
    }

    //fds
    let fds = {}
    for (let k of FDS) {
        let fd = get(cfg, `fds.${k}`, '')
        fds[k] = isestr(fd) ? path.resolve(fd) : path.resolve(root, k)
    }

    //settings, 策略之資金與手續費(與使用端既有管線一致: uIni 1000、uTrade 1、rFee 0.0005)
    let settings = {
        uIni: 1000,
        uTrade: 1,
        rFee: 0.0005,
        ...(iseobj(get(cfg, 'settings')) ? cfg.settings : {}),
    }

    return {
        root,
        name,
        symbol,
        interval,
        intervalSec: isec,
        timeZone,
        source,
        useIndex,
        dayStart,
        timeBegin,
        train,
        fds,
        keyOhlc: `${name}_price_${interval}`,
        keyIndex: `${name}_index_${interval}`,
        barsPerDay: 86400 / isec, //每日K線根數(4hr為6), 供w-data-trade各calc之週期表換算
        settings,
    }
}


/**
 * 取可結構化複製之設定副本(供worker_threads之workerData使用；外部數據之函數來源以字串'external'代之)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @returns {Object} 回傳設定副本
 * @example
 *
 * let cfg = normalizeCfg({ root: './data', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr', source: { price: async () => [] } })
 * console.log(serializableCfg(cfg).source, serializableCfg(normalizeCfg({ root: './data', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr' })).source)
 * // => external binance
 *
 */
let serializableCfg = (cfg) => {
    return {
        ...cfg,
        source: cfg.source === 'binance' ? 'binance' : 'external',
    }
}


export { INTERVALS, FDS, CFG_KEYS, DERIVED_KEYS, intervalSec, normalizeCfg, serializableCfg }
export default normalizeCfg
