import get from 'lodash-es/get.js'
import isestr from 'wsemi/src/isestr.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import saveData from 'w-dwdata-binance/src/saveData.mjs'


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
 * @returns {Promise} 回傳Promise，resolve為{price,index}，各為saveData之回傳({timeKeep,timeLast,items})，不抓index時index為null
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

    let price = await saveData(cfg.name, 'price', endpointPrice, cfg.symbol, cfg.interval, common)

    let index = null
    if (cfg.useIndex) {
        index = await saveData(cfg.name, 'index', endpointIndex, cfg.symbol, cfg.interval, common)
    }

    return { price, index }
}


export { ENDPOINT_PRICE, ENDPOINT_INDEX }
export default fetchBinance
