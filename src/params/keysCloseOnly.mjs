import filter from 'lodash-es/filter.js'
import includes from 'lodash-es/includes.js'


//【僅用Close欄位之參數(因子)過濾器】抽自使用端既有管線(2026-09-03 逐檔核對w-data-trade各calc實際存取之欄位)
//
//  key命名: `${cointpe}_${keyKind}_${keyIn}_${keyOut}_${method}_${period}`(w-data-trade dataConvert), 非6段者視為未知一律不放行
//  判定依據(逐檔核對w-data-trade各calc實際存取之欄位):
//    ① 取值類orig/ma/maNorm/ema/emaNorm/vec/vecNorm: 來源欄位由keyIn決定 → 僅keyIn==='Close'者放行
//    ② 指標類僅存取Close者: bbpb、macd、rsi
//    ③ 其餘指標皆另取High/Low/Open或成交量欄位, 一律不放行
//  成交量類(_vbs_)過濾後為空, 故配合使用之comps第3段須恆為0(見compsCloseOnly)


//METHODS_BY_KEYIN, 來源欄位由keyIn決定之取值類method
let METHODS_BY_KEYIN = ['orig', 'ma', 'maNorm', 'ema', 'emaNorm', 'vec', 'vecNorm']

//METHODS_CLOSE_ONLY, 內部僅存取Close欄位之指標類method
let METHODS_CLOSE_ONLY = ['bbpb', 'macd', 'rsi']


/**
 * 判定單一參數key是否僅由K線Close欄位推導
 *
 * @function
 * @param {String} key 輸入參數key字串，例如'price_ohlc_none_RSI_rsi_1day'
 * @returns {Boolean} 回傳是否為close-only布林值
 * @example
 *
 * console.log(isKeyCloseOnly('price_ohlc_Close_param_maNorm_1day'), isKeyCloseOnly('price_ohlc_none_RSI_rsi_1day'), isKeyCloseOnly('price_ohlc_none_ADX_adx_1day'))
 * // => true true false
 *
 */
let isKeyCloseOnly = (key) => {
    let ps = String(key).split('_')
    if (ps.length !== 6) {
        return false
    }
    let keyIn = ps[2]
    let method = ps[4]
    if (includes(METHODS_BY_KEYIN, method)) {
        return keyIn === 'Close'
    }
    return includes(METHODS_CLOSE_ONLY, method)
}


/**
 * 過濾出僅由K線Close欄位推導之參數keys
 *
 * @function
 * @param {Array} keys 輸入參數key字串陣列
 * @returns {Array} 回傳過濾後之key字串陣列
 * @example
 *
 * console.log(filterKeysCloseOnly(['price_ohlc_none_RSI_rsi_1day', 'price_ohlc_none_ADX_adx_1day', 'price_vbs_volumn_param_maNorm_1day']))
 * // => [ 'price_ohlc_none_RSI_rsi_1day' ]
 *
 */
let filterKeysCloseOnly = (keys) => {
    return filter(keys, isKeyCloseOnly)
}


/**
 * close-only之指標組成候選(成交量類過濾後為空，僅保留第3段為0之組成；18種之前9種)
 *
 * @type {Array}
 */
let compsCloseOnly = [
    '2,0,0',
    '3,0,0',
    '4,0,0',
    '2,1,0',
    '3,1,0',
    '4,1,0',
    '2,2,0',
    '3,2,0',
    '4,2,0',
]


export { isKeyCloseOnly, filterKeysCloseOnly, compsCloseOnly }
export default filterKeysCloseOnly
