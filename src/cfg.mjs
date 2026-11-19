import path from 'path'
import get from 'lodash-es/get.js'
import cloneDeep from 'lodash-es/cloneDeep.js'
import buildBaseUnitNotional from 'w-trade-backtest/src/buildBaseUnitNotional.mjs'
import parseBarTime from 'w-trade-backtest/src/barTime.mjs'
import { chkIntervalSec, INTERVAL_SEC_MAX } from 'w-data-trade/src/resolvePeriods.mjs'
import { getIntervals, getIntervalPlan } from 'w-dwdata-binance/src/intervals.mjs'
import cdbl from 'wsemi/src/cdbl.mjs'
import cint from 'wsemi/src/cint.mjs'
import isenum from 'wsemi/src/isenum.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import isday from 'wsemi/src/isday.mjs'
import istime from 'wsemi/src/istime.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'


/**
 * 各K線週期之秒數(鍵名與w-dwdata-binance saveData之週期鍵一致)
 *
 * @type {Object}
 */
let INTERVALS = {
    '1m': 60,
    '3m': 3 * 60,
    '5m': 5 * 60,
    '15m': 15 * 60,
    '30m': 30 * 60,
    '1hr': 60 * 60,
    '2hr': 2 * 60 * 60,
    '4hr': 4 * 60 * 60,
    '6hr': 6 * 60 * 60,
    '8hr': 8 * 60 * 60,
    '12hr': 12 * 60 * 60,
    '1day': 24 * 60 * 60,
    '1week': 7 * 24 * 60 * 60,
}


/**
 * 4hr之每根秒數(各相依套件「未給每根時長」之預設；工作根口徑之預設亦以此判定)
 *
 * @type {Number}
 */
let INTERVAL_SEC_DEFAULT = 4 * 60 * 60


//hasOwn, 自有鍵之判定(週期鍵不認原型鏈名, 如'constructor'; 與w-dwdata-binance之週期鍵判定一致)
let hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)


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
    'root', 'name', 'symbol', 'interval', 'intervalSec', 'timeBasis', 'timeZone',
    'source', 'aggregateFrom', 'useIndex', 'dayStart', 'timeBegin', 'train',
    'fds', 'settings',
])


/**
 * normalizeCfg產出之衍生鍵(重入時略過不計)
 *
 * @type {Array}
 */
let DERIVED_KEYS = Object.freeze(['keyOhlc', 'keyIndex'])


/**
 * 取得K線週期之秒數
 *
 * interval為內建週期(INTERVALS)時回傳其秒數；非內建週期時取fallback(每根K線之秒數，即cfg.intervalSec)
 * fallback給了(非null與undefined)即依w-data-trade之chkIntervalSec檢核(60之正整數倍且至多31536000之整數，數值或數字字串，數字字串轉為數值，檢測之值即使用之值)，無效即throw(內建週期亦同，不退回預設值；訊息固定且不含輸入值)
 * 內建週期而另給有效之fallback時須等於內建秒數，不等即throw `invalid cfg.intervalSec: must equal the seconds of the built-in cfg.interval`(不含輸入值)
 *
 * @function
 * @param {String} interval 輸入K線週期字串，例如'4hr'
 * @param {Number|String} [fallback=null] 輸入interval非內建週期時改用之每根秒數(數值或數字字串)，內建週期時須等於其秒數，預設null
 * @returns {Number} 回傳秒數
 * @example
 *
 * console.log(intervalSec('4hr'), intervalSec('1day'), intervalSec('1day', '86400'), intervalSec('10m', 600))
 * // => 14400 86400 86400 600
 *
 */
let intervalSec = (interval, fallback = null) => {
    let given = null
    if (fallback !== null && fallback !== undefined) {
        try {
            given = chkIntervalSec(fallback)
        }
        catch (err) {
            throw new Error(`invalid cfg.intervalSec: must be a positive integer multiple of 60 up to ${INTERVAL_SEC_MAX}`)
        }
    }
    if (hasOwn(INTERVALS, interval)) {
        if (given !== null && given !== INTERVALS[interval]) {
            throw new Error(`invalid cfg.intervalSec: must equal the seconds of the built-in cfg.interval`)
        }
        return INTERVALS[interval]
    }
    if (given !== null) {
        return given
    }
    throw new Error(`invalid interval[${interval}], 非內建週期(${Object.keys(INTERVALS).join(', ')})時須給cfg.intervalSec`)
}


/**
 * 檢測基礎單位選項並把其數字字串轉為數值(不要求asOf與source; normalizeUnit與策略庫重算比對檔內口徑共用)
 *
 * 先複製一次(unit各欄只讀取一次，其後檢測與轉換皆用此副本，檢測之值即使用之值)，以w-trade-backtest之buildBaseUnitNotional檢測(與回測各路徑檢測settings.unit者同一函數：須為一般物件，rule三欄與buffer、units為有效數字或數字字串，並以價格1試算一次)，通過後把rule三欄與buffer轉為數值、units轉為整數，buffer與units為null或未給時補預設0.1與1(不寫入null)，其餘欄位原樣
 * 無效時throw(訊息為buildBaseUnitNotional所拋，以`invalid ${name}`起頭，不含輸入值)
 *
 * @function
 * @param {Object} unit 輸入基礎單位選項物件{rule,buffer,units}
 * @param {String} [name='unit'] 輸入錯誤訊息所用之選項名稱字串，預設'unit'
 * @returns {Object} 回傳副本{rule,buffer,units}，數值皆為Number
 * @example
 *
 * let u = toNumericUnit({ rule: { stepSize: '0.001', minQty: '0.001', minNotional: '20' }, units: '2' })
 * console.log(u.rule.stepSize, u.buffer, u.units)
 * // => 0.001 0.1 2
 *
 */
let toNumericUnit = (unit, name = 'unit') => {
    let u = cloneDeep(unit)
    buildBaseUnitNotional(u, name)
    u.rule.stepSize = cdbl(u.rule.stepSize)
    u.rule.minQty = cdbl(u.rule.minQty)
    u.rule.minNotional = cdbl(u.rule.minNotional)
    u.buffer = (u.buffer === undefined || u.buffer === null) ? 0.1 : cdbl(u.buffer)
    u.units = (u.units === undefined || u.units === null) ? 1 : cint(u.units)
    return u
}


/**
 * 正規化基礎單位選項(下單之基礎單位 = 交易所之最小可下單數量)
 *
 * unit為一般物件{rule,buffer,units}：rule為交易規則{stepSize,minQty,minNotional}(各為有效數字或數字字串且大於0)，且須另記asOf(查得之時刻)與source(來源)兩個非空字串；buffer為非負數、null或未給為0.1，units為正整數、null或未給為1(介面同w-trade-backtest之settings.unit，>=1.1.40)
 * 有效性由w-trade-backtest之buildBaseUnitNotional判定(與回測各路徑檢測settings.unit者同一函數；須為一般物件，並以價格1試算一次)，不另加型別限制；通過後回傳之副本把rule三欄與buffer之數字字串轉為數值、units轉為整數(落地皆為數值，轉換前後buildBaseUnitNotional之key相同)，buffer與units為null或未給時補預設(不寫入null；策略檔因此記錄實際採用之緩衝與單位數)，asOf、source與其他欄位原樣複製，不改呼叫端之物件
 * unit非物件、rule非物件、asOf或source非非空字串、或buildBaseUnitNotional拋錯時throw(訊息為`invalid ${name}...: must be ...`，以`invalid ${name}`起頭，不含輸入值)
 *
 * @function
 * @param {Object} unit 輸入基礎單位選項物件{rule,buffer,units}
 * @param {String} [name='unit'] 輸入錯誤訊息所用之選項名稱字串，預設'unit'
 * @returns {Object} 回傳正規化後之基礎單位選項副本{rule,buffer,units}，數值皆為Number
 * @example
 *
 * let u = normalizeUnit({ rule: { stepSize: '0.001', minQty: 0.001, minNotional: 20, asOf: '2026-01-01T00:00:00', source: 'exchangeInfo' } })
 * console.log(u.buffer, u.units, u.rule.stepSize, u.rule.asOf)
 * // => 0.1 1 0.001 2026-01-01T00:00:00
 *
 */
let normalizeUnit = (unit, name = 'unit') => {
    let u = toNumericUnit(unit, name)
    for (let k of ['asOf', 'source']) {
        if (!isestr(u.rule[k])) {
            throw new Error(`invalid ${name}.rule.${k}: must be a non-empty string`)
        }
    }
    return u
}


/**
 * 取幣安下載之取得方式(依w-dwdata-binance之getIntervalPlan, 不連網)
 *
 * 取得方式依下載套件之判定: aggregateFrom未給(undefined或null)時一律不傳, 由其預設('auto')決定, 任何週期鍵同一規則(目標之原生格線於期間內之各偏移下皆與timeZone之界線對齊者直接下載, 如台北與UTC之4hr; 不對齊者合併, 如東京與加爾各答之4hr)；有給時原樣傳入
 * interval為下載套件之週期鍵(或給了aggregateFrom)時回傳其plan({interval,mode,key,base,baseKey,count,dataSec,utcOffset}; mode為'native'(直接下載, key即interval)或'aggregate'(合併, key為合併輸出夾名))
 * interval非下載套件之週期鍵且未給aggregateFrom時回傳null(不呼叫getIntervalPlan, 行為同既有; 此類週期之幣安抓取由下載套件於抓取時拒絕)
 * aggregateFrom無效、須合併而timeZone非固定偏移(有日光節約時間)、或給了aggregateFrom而interval非下載套件之週期鍵時, 由getIntervalPlan拋錯(訊息原樣)
 *
 * @function
 * @param {Object} o 輸入物件{interval,timeZone,dayStart,aggregateFrom}
 * @returns {Object|null} 回傳plan物件或null
 * @example
 *
 * console.log(rawPlanOf({ interval: '4hr', timeZone: 'Asia/Taipei', dayStart: '2020-01-01' }).mode, rawPlanOf({ interval: 'c2hr' }))
 * // => native null
 *
 * console.log(rawPlanOf({ interval: '4hr', timeZone: 'Asia/Tokyo', dayStart: '2020-01-01' }).key)
 * // => 4hr_tz+0900_d20200101_from1hr
 *
 */
let rawPlanOf = (o) => {
    let interval = get(o, 'interval', '')
    let aggregateFrom = get(o, 'aggregateFrom', null)
    let given = aggregateFrom !== null && aggregateFrom !== undefined
    if (!given && !hasOwn(getIntervals(), interval)) {
        return null
    }
    return getIntervalPlan(interval, {
        timeZone: get(o, 'timeZone'),
        dayStart: get(o, 'dayStart'),
        ...(given ? { aggregateFrom } : {}),
    })
}


/**
 * 取幣安下載結果之資料夾名(raw/{name}/{price|index}/之下一層; 讀取與抓取共用)
 *
 * 須合併者為下載套件之合併輸出夾名(如'1day_tz+0800_d20200101_from4hr', 含偏移與dayStart, 故讀取與抓取須同一timeZone與dayStart); 直接下載者為interval(既有)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @returns {String} 回傳資料夾名
 * @example
 *
 * console.log(rawKeyOf({ interval: '4hr', timeZone: 'Asia/Taipei', dayStart: '2020-01-01' }), rawKeyOf({ interval: '1day', aggregateFrom: '4hr', timeZone: 'Asia/Taipei', dayStart: '2020-01-01' }))
 * // => 4hr 1day_tz+0800_d20200101_from4hr
 *
 */
let rawKeyOf = (cfg) => {
    let plan = rawPlanOf(cfg)
    return plan === null ? cfg.interval : plan.key
}


/**
 * 正規化管線設定
 *
 * 必填: root(工作根資料夾)、name(幣種或標的名稱, 用於組序列key與策略識別)、symbol(交易對)、interval(K線週期)
 * interval為內建週期(INTERVALS)或另給intervalSec(每根K線之秒數, 60之正整數倍且至多31536000之整數, 數值或數字字串, 轉為數值; 依w-data-trade之chkIntervalSec檢核, 給了而無效即throw `invalid cfg.intervalSec: must be a positive integer multiple of 60 up to 31536000`, 不含輸入值; 內建週期另給有效而不同之值即throw `invalid cfg.intervalSec: must equal the seconds of the built-in cfg.interval`); 各calc之期別以根數為本, 期別標籤 = 根數 × intervalSec, 故換週期時根數不變(見buildParams)
 * timeBasis為時間口徑('open'以K線開盤時刻計, 同既有; 'span'計入每根K線之時距, 持倉天數與回測天數依實際時點計), 給予時依w-trade-backtest之parseBarTime檢核(與回測各路徑同一函數; 無效即throw `invalid cfg.timeBasis: must be one of 'open', 'span'`), 並與intervalSec一起寫入普測、求解與策略庫重算之策略settings及回測之opt(見barTimeOf); 未給時(含null)不出現於回傳, 各階段之行為與輸出不變; 不因週期而自動改預設
 * source為'binance'(預設, 由幣安抓取現貨K線與溢價指數K線)或物件{price,index}(外部數據, 各為K線陣列或回傳K線陣列之async函數, 供股價等非幣安標的)
 * aggregateFrom(只用於source為'binance')為下載之取得方式, 原樣轉傳w-dwdata-binance之opt.aggregateFrom('none'直接下載原生週期、'auto'不對齊時取能整除且對齊之最大原生週期合併、或基底週期鍵如'4hr'); 未給時一律不傳, 由下載套件之預設('auto')決定, 任何週期鍵同一規則(是否合併與資料夾位置依其getIntervalPlan之判定: 目標之原生格線與timeZone之界線對齊者直接下載, 如台北與UTC之1m～4hr; 不對齊者合併, 如東京與加爾各答之4hr; 須明給'none'才於任何時區直接下載原生週期); 研究用之日線宜明給'4hr'(與既有4hr資料同源); interval為下載套件之週期鍵者以其getIntervalPlan先行檢核(見rawPlanOf; 無效或須合併而timeZone非固定偏移即throw, 訊息原樣), 有給時才出現於回傳; source非'binance'而給了即throw `invalid cfg.aggregateFrom: must be used with cfg.source 'binance'`
 * useIndex預設true(須同時有price與index), 外部數據未給index時自動為false; 為false時基於index之參數將於buildParams被剔除
 * train為訓練期{timeStart,timeEnd[,timeEndByMode:{long,short}]}, 為最佳化求解與普測之評估區間; timeEnd(與timeEndByMode)為最後一根納入之K線之開盤時刻(該根整根納入; 每根1日而期間止於D日00:00者應寫D−1日00:00); 未給時僅能執行數據與參數階段
 * settings為策略之資金與手續費(預設{uIni:1000,uTrade:1,rFee:0.0005}); 可另給unit(基礎單位{rule,buffer,units}, 見normalizeUnit; rule須記asOf與source), 給予時普測、求解與策略庫重算之每單名義依基礎單位, uIni為研究用本金(須為有效正數, 數字或數字字串, 通過即轉為數值; 只作策略庫重算統計超過者之基準, 只列不判, 普測與求解不以之判定), unit內之數字字串亦轉為數值後落地, unit隨策略檔落地; 未給unit時行為不變(uIni等設定原樣)
 * cfg之鍵只認CFG_KEYS，打錯之鍵拋錯(靜默接受會使正名鍵維持預設而無人察覺)
 *
 * @function
 * @param {Object} cfg 輸入設定物件
 * @returns {Object} 回傳正規化後之設定物件，含fds(各資料夾絕對路徑)、keyOhlc、keyIndex、intervalSec(每根K線之秒數，數值)、timeBasis(有給時)與settings
 * @example
 *
 * let cfg = normalizeCfg({ root: './data', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr', train: { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00' } })
 * console.log(cfg.keyOhlc, cfg.keyIndex, cfg.intervalSec, cfg.useIndex, cfg.source, cfg.timeZone, 'timeBasis' in cfg)
 * // => ETH_price_4hr ETH_index_4hr 14400 true binance Asia/Taipei false
 *
 * let cfgStock = normalizeCfg({ root: './data', name: 'TSMC', symbol: '2330', interval: '1day', timeBasis: 'span', source: { price: [] } })
 * console.log(cfgStock.useIndex, cfgStock.intervalSec, cfgStock.timeBasis, Object.keys(cfgStock.fds).join(','))
 * // => false 86400 span raw,ohlc,param,cache,strategies,strategiesP1,strategiesP2,meta
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

    //timeBasis, 時間口徑(給予時以回測套件之parseBarTime檢核, 與回測各路徑同一函數; 'span'須有intervalSec, 此處恆有); 未給(含null)為null, 不出現於回傳
    let timeBasis = get(cfg, 'timeBasis', null)
    if (timeBasis !== null && timeBasis !== undefined) {
        timeBasis = parseBarTime({ intervalSec: isec, timeBasis }, 'cfg').timeBasis
    }
    else {
        timeBasis = null
    }

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

    //aggregateFrom, 幣安下載之取得方式(轉傳w-dwdata-binance之opt.aggregateFrom: 'none'、'auto'或基底週期鍵); 只用於source為'binance', 未給(含null)不出現於回傳(由下載套件依週期鍵決定預設)
    //  interval為下載套件之週期鍵(或給了aggregateFrom)者, 以其getIntervalPlan(不連網)先行檢核aggregateFrom與timeZone(須合併時須為固定偏移), 無效即throw(訊息原樣), 先於任何連網、建夾、寫檔
    let aggregateFrom = get(cfg, 'aggregateFrom', null)
    if (aggregateFrom === undefined) {
        aggregateFrom = null
    }
    if (aggregateFrom !== null && source !== 'binance') {
        throw new Error(`invalid cfg.aggregateFrom: must be used with cfg.source 'binance'`)
    }
    if (source === 'binance') {
        rawPlanOf({ interval, timeZone, dayStart, ...(aggregateFrom !== null ? { aggregateFrom } : {}) })
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

    //settings.unit, 基礎單位(下單之基礎單位 = 交易所之最小可下單數量), 給予時正規化(數字字串轉為數值)並檢查研究用本金uIni(有效正數, 數字或數字字串, 通過即轉為數值; 檢測之值即使用之值); 未給或為null時視同未給(原樣保留, 各階段以是否為物件判定)
    if (settings.unit !== undefined && settings.unit !== null) {
        settings.unit = normalizeUnit(settings.unit, 'cfg.settings.unit')
        if (!isenum(settings.uIni, { gt: 0 })) {
            throw new Error(`invalid cfg.settings.uIni: must be a positive number`)
        }
        settings.uIni = cdbl(settings.uIni)
    }

    return {
        root,
        name,
        symbol,
        interval,
        intervalSec: isec,
        ...(timeBasis !== null ? { timeBasis } : {}), //時間口徑(有給時才有此鍵; 未給時回傳與既有相同)
        timeZone,
        source,
        ...(aggregateFrom !== null ? { aggregateFrom } : {}), //幣安下載之取得方式(有給時才有此鍵; 未給時回傳與既有相同)
        useIndex,
        dayStart,
        timeBegin,
        train,
        fds,
        keyOhlc: `${name}_price_${interval}`,
        keyIndex: `${name}_index_${interval}`,
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


/**
 * 取策略settings與回測opt之時間口徑鍵(普測、求解、策略庫重算共用之單一來源)
 *
 * cfg.timeBasis有給時回傳{intervalSec,timeBasis}(intervalSec為cfg.intervalSec; 鍵名與語意同w-trade-backtest之settings.intervalSec、settings.timeBasis, 與w-trade-solve之opt.intervalSec、opt.timeBasis), 未給時回傳null(不附加任何鍵, 各階段與既有相同)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @returns {Object|null} 回傳{intervalSec,timeBasis}或null
 * @example
 *
 * console.log(barTimeOf({ intervalSec: 86400, timeBasis: 'span' }), barTimeOf({ intervalSec: 14400 }))
 * // => { intervalSec: 86400, timeBasis: 'span' } null
 *
 */
let barTimeOf = (cfg) => {
    let tb = get(cfg, 'timeBasis', null)
    if (tb === null || tb === undefined) {
        return null
    }
    return { intervalSec: cfg.intervalSec, timeBasis: tb }
}


export { INTERVALS, INTERVAL_SEC_DEFAULT, FDS, CFG_KEYS, DERIVED_KEYS, intervalSec, toNumericUnit, normalizeUnit, rawPlanOf, rawKeyOf, normalizeCfg, serializableCfg, barTimeOf }
export default normalizeCfg
