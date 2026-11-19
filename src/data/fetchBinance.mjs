import path from 'path'
import get from 'lodash-es/get.js'
import isestr from 'wsemi/src/isestr.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import saveData from 'w-dwdata-binance/src/saveData.mjs'
import { rawPlanOf } from '../cfg.mjs'
import { writeJson, nowIso } from '../util/fsx.mjs'


/**
 * 幣安現貨K線端點
 *
 * @type {String}
 */
let ENDPOINT_PRICE = 'https://api.binance.com/api/v3/klines'

/**
 * 幣安合約溢價指數(Premium Index)K線端點
 *
 * @type {String}
 */
let ENDPOINT_INDEX = 'https://www.binance.com/fapi/v1/premiumIndexKlines'


/**
 * 由幣安抓取K線數據(現貨價格與溢價指數)並以分段csv儲存至cfg.fds.raw
 *
 * 以w-dwdata-binance之saveData抓取，既有且完整之分段不重抓，最新分段每次必抓；cfg.useIndex為true時另抓溢價指數K線
 * cfg.aggregateFrom有給時原樣轉傳saveData之opt.aggregateFrom；未給時一律不傳，由下載套件之預設('auto')決定，任何週期鍵同一規則(下載套件依週期鍵、timeZone與aggregateFrom決定直接下載或合併；價格與溢價指數以同一設定呼叫，故同一資料夾，即rawKeyOf(cfg)，buildOhlc讀取之處)
 * 須合併時另把取得方式與未輸出之目標根(aggregate.missing: 尚未收棒、基底缺漏等; 此處不拋錯, 期間內之洞由buildOhlc依序列之相鄰時差判定: 交易所來源預設放行並記錄、opt.allowGaps為false時拋錯)記於cfg.fds.meta/aggregate.json；直接下載(如台北與UTC之4hr)時不寫此檔
 * cfg.source非'binance'時throw(外部數據請直接呼叫buildOhlc)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {String} [opt.endpointPrice] 輸入價格K線端點，預設幣安現貨klines
 * @param {String} [opt.endpointIndex] 輸入溢價指數K線端點，預設幣安premiumIndexKlines
 * @param {Object} [opt.proxy={}] 輸入axios proxy設定
 * @param {Integer} [opt.timeBudget=0] 輸入每次呼叫處理舊分段之時間上限毫秒數，0代表不限
 * @param {Integer} [opt.timeGrace] 輸入名目收棒後之寬限毫秒數，未給時採saveData預設
 * @param {Boolean} [opt.useShowLog=false] 輸入是否顯示log布林值
 * @returns {Promise} 回傳Promise，resolve為{price,index}，各為saveData之回傳({timeKeep,timeLast,items}，須合併時另含aggregate{key,base,baseKey,count,utcOffset,fd,segments,missing})，不抓index時index為null
 * @example
 * need test in nodejs.
 *
 * let r = await fetchBinance(cfg, { useShowLog: true })
 * console.log(r.price.items.length)
 */
let fetchBinance = async (cfg, opt = {}) => {

    if (cfg.source !== 'binance') {
        throw new Error(`cfg.source非'binance', 外部數據請直接呼叫buildOhlc`)
    }

    let endpointPrice = get(opt, 'endpointPrice', '')
    if (!isestr(endpointPrice)) {
        endpointPrice = ENDPOINT_PRICE
    }
    let endpointIndex = get(opt, 'endpointIndex', '')
    if (!isestr(endpointIndex)) {
        endpointIndex = ENDPOINT_INDEX
    }

    let common = {
        dayStart: cfg.dayStart,
        timeZone: cfg.timeZone,
        fdData: cfg.fds.raw,
        proxy: iseobj(get(opt, 'proxy')) ? opt.proxy : {},
        useConvertToCsv: true,
        useShowLog: get(opt, 'useShowLog', false) === true,
    }
    if (isp0int(get(opt, 'timeBudget'))) {
        common.timeBudget = opt.timeBudget
    }
    if (isp0int(get(opt, 'timeGrace'))) {
        common.timeGrace = opt.timeGrace
    }
    if (cfg.aggregateFrom !== undefined && cfg.aggregateFrom !== null) {
        common.aggregateFrom = cfg.aggregateFrom //有給時原樣轉傳; 未給時不傳, 由下載套件之預設('auto')決定(任何週期鍵同一規則, 不明傳'none')
    }

    //plan, 須合併者之資料夾名(buildOhlc讀取之處; 價格與溢價指數以同一設定呼叫, 故同一資料夾), 先於任何連網(參數無效即由getIntervalPlan拋錯)
    let plan = rawPlanOf(cfg)
    let keyWant = plan !== null && plan.mode === 'aggregate' ? plan.key : null

    let price = await saveData(cfg.name, 'price', endpointPrice, cfg.symbol, cfg.interval, common)

    let index = null
    if (cfg.useIndex) {
        index = await saveData(cfg.name, 'index', endpointIndex, cfg.symbol, cfg.interval, common)
    }

    //aggregate, 須合併時記錄取得方式與未輸出之目標根
    if (keyWant !== null) {
        let brief = (r) => (r ? { nMissing: r.aggregate.missing.length, missing: r.aggregate.missing, nSegments: r.aggregate.segments.length } : null)
        writeJson(path.resolve(cfg.fds.meta, 'aggregate.json'), {
            key: keyWant,
            base: price.aggregate.base,
            baseKey: price.aggregate.baseKey,
            count: price.aggregate.count,
            utcOffset: price.aggregate.utcOffset,
            price: brief(price),
            index: brief(index),
            at: nowIso(),
        })
    }

    return { price, index }
}


export { ENDPOINT_PRICE, ENDPOINT_INDEX }
export default fetchBinance
