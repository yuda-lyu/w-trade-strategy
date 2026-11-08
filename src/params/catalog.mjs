//內建參數(因子)目錄: 由使用端既有管線之 34 個參數定義抽提, 去除幣種專屬之 nm(avg/std, 改由 buildParams 依指定期間自算並凍結於 meta)
//  各定義: { id, cointpe('price'|'index'), keyKind('ohlc'|'vbs'), fields(計算實際存取之 K 線欄位; 數據缺任一欄即整個定義跳過), keysIn(取值類之來源欄位; 空陣列代表 'none'),
//           funAddKeysIn(逐筆擴增欄位之函數, 僅 vbs 用), methods: [{ method, optMethod(index 側之偏移參數, 為校正起點; null=無), deals: [{ keyIn?, keyOut }] }] }
//  key 命名由 w-data-trade dataConvert 決定: `${cointpe}_${keyKind}_${keyIn||'none'}_${keyOut}_${method}_${period}`
//  index 側之 optMethod 預設值為 ETH 之率定值; buildParams 預設會以 w-data-trade dataCalibrate 對新幣種重新校正(以 price 側同名 keyOut 為參考), 結果凍結於 meta
//  各 calc 之週期表(1day=6 根 …)在 w-data-trade 內以 4hr K 線為基準; buildParams 於每次呼叫併入 barsPerDay(= 86400 / intervalSec)換算, 其他 interval 之週期標籤維持時間語意(見 README §4 K 線週期)
import diviProt from 'w-data-trade/src/diviProt.mjs'


/**
 * 由成交量欄位擴增volumn/volumnBuy/volumnSell/volumnDiff/vbr/vsr/vdr七欄(供price_vbs定義之取值類method使用)
 *
 * @function
 * @param {Object} v 輸入K線物件(須含Volumn與TakerBuyBaseAssetVolume)
 * @returns {Object} 回傳同一物件(已擴增欄位)
 * @example
 *
 * let v = funAddKeysInVbs({ Volumn: 1000, TakerBuyBaseAssetVolume: 600 })
 * console.log(v.volumnSell, v.volumnDiff, v.vbr, v.vsr, v.vdr)
 * // => 400 200 0.6 0.4 0.2
 *
 */
let funAddKeysInVbs = (v) => {
    let volumn = v.Volumn
    let volumnBuy = v.TakerBuyBaseAssetVolume
    let volumnSell = volumn - volumnBuy
    let volumnDiff = volumnBuy - volumnSell
    v.volumn = volumn
    v.volumnBuy = volumnBuy
    v.volumnSell = volumnSell
    v.volumnDiff = volumnDiff
    v.vbr = diviProt(volumnBuy, volumn) //volumnBuy/volumn
    v.vsr = diviProt(volumnSell, volumn) //volumnSell/volumn
    v.vdr = diviProt(volumnDiff, volumn) //volumnDiff/volumn
    return v
}


/**
 * 內建參數(因子)定義目錄(34個定義、136個輸出；price 20、index 14)，各定義格式見檔頭
 *
 * @type {Array}
 */
let CATALOG = [
    {
        id: 'index_ohlc_adx',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'adx',
                optMethod: null,
                deals: [
                    { keyOut: 'ADX' },
                    { keyOut: 'plusDI' },
                    { keyOut: 'minusDI' },
                    { keyOut: 'DIcross' },
                    { keyOut: 'ADXslope' },
                ],
            },
        ],
    },
    {
        id: 'index_ohlc_atr',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'atr',
                optMethod: { plusClose: 0.03 },
                deals: [
                    { keyOut: 'atr' },
                    { keyOut: 'atrRatioMod' },
                    { keyOut: 'atrChange' },
                    { keyOut: 'trRank' },
                ],
            },
        ],
    },
    {
        id: 'index_ohlc_bbpb',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'bbpb',
                optMethod: { subMid: -0.0002778, powMid: 0.5, plusMid: 0.1, plusBandWidth: -0.2 },
                deals: [{ keyOut: 'BBpctB' }, { keyOut: 'BBwidthMod' }, { keyOut: 'BBwidthChangeMod' }],
            },
        ],
    },
    {
        id: 'index_ohlc_candle',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['Open', 'High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'candle',
                optMethod: null,
                deals: [
                    { keyOut: 'bodyRatio' },
                    { keyOut: 'upperWickRatio' },
                    { keyOut: 'lowerWickRatio' },
                    { keyOut: 'candleDir' },
                    { keyOut: 'engulfStrength' },
                ],
            },
        ],
    },
    {
        id: 'index_ohlc_close',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: ['Close'],
        funAddKeysIn: null,
        methods: [
            {
                method: 'orig',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
            {
                method: 'ma',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
            {
                method: 'ema',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
            {
                method: 'vec',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
        ],
    },
    {
        id: 'index_ohlc_donchian',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'donchian',
                optMethod: { subMid: -0.0003428, powMid: 0.5, plusMid: 1 / 3, plusBandWidth: -0.2 },
                deals: [{ keyOut: 'dcPctB' }, { keyOut: 'dcWidthMod' }, { keyOut: 'dcWidthChangeMod' }],
            },
        ],
    },
    {
        id: 'index_ohlc_ichimoku',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'ichimoku',
                optMethod: { plusClose: 0.008, plusCloudMid: 0.07, plusBandWidth: 0, plusTenkans: 0.05 },
                deals: [{ keyOut: 'cloudDistMod' }, { keyOut: 'cloudThickMod' }, { keyOut: 'tkDiffMod' }],
            },
        ],
    },
    {
        id: 'index_ohlc_kdj',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'kdj',
                optMethod: null,
                deals: [
                    { keyOut: 'K' },
                    { keyOut: 'D' },
                    { keyOut: 'J' },
                    { keyOut: 'KminusD' },
                ],
            },
        ],
    },
    {
        id: 'index_ohlc_keltner',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'keltner',
                optMethod: { plusMiddle: 0.03 },
                deals: [{ keyOut: 'kcPctB' }, { keyOut: 'kcWidthMod' }],
            },
        ],
    },
    {
        id: 'index_ohlc_klr',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['Open', 'High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'klr',
                optMethod: { plusClose: 0.5 },
                deals: [
                    { keyOut: 'ho' },
                    { keyOut: 'lo' },
                    { keyOut: 'co' },
                    { keyOut: 'hc' },
                    { keyOut: 'lc' },
                    { keyOut: 'hl' },
                ],
            },
        ],
    },
    {
        id: 'index_ohlc_macd',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'macd',
                optMethod: null,
                deals: [{ keyOut: 'DIF' }, { keyOut: 'DEM' }, { keyOut: 'OSC' }],
            },
        ],
    },
    {
        id: 'index_ohlc_rsi',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'rsi',
                optMethod: null,
                deals: [
                    { keyOut: 'RSI' },
                    { keyOut: 'rsiAvgGain' },
                    { keyOut: 'rsiAvgLoss' },
                    { keyOut: 'rsiUp' },
                    { keyOut: 'rsiDown' },
                ],
            },
        ],
    },
    {
        id: 'index_ohlc_supertrend',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'supertrend',
                optMethod: { plusClose: 0.005 },
                deals: [{ keyOut: 'stDistanceMod' }],
            },
        ],
    },
    {
        id: 'index_ohlc_vortex',
        cointpe: 'index',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'vortex',
                optMethod: null,
                deals: [
                    { keyOut: 'VIplus' },
                    { keyOut: 'VIminus' },
                    { keyOut: 'VIdiff' },
                    { keyOut: 'VIsum' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_adx',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'adx',
                optMethod: null,
                deals: [
                    { keyOut: 'ADX' },
                    { keyOut: 'plusDI' },
                    { keyOut: 'minusDI' },
                    { keyOut: 'DIcross' },
                    { keyOut: 'ADXslope' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_atr',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'atr',
                optMethod: null,
                deals: [
                    { keyOut: 'atr' },
                    { keyOut: 'atrRatio' },
                    { keyOut: 'atrChange' },
                    { keyOut: 'trRank' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_ats',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['QuoteAssetVolume', 'NumberOfTrades'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'ats',
                optMethod: null,
                deals: [{ keyOut: 'atsRatio' }, { keyOut: 'atsChange' }],
            },
        ],
    },
    {
        id: 'price_ohlc_bbpb',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'bbpb',
                optMethod: null,
                deals: [{ keyOut: 'BBpctB' }, { keyOut: 'BBwidth' }, { keyOut: 'BBwidthChange' }],
            },
        ],
    },
    {
        id: 'price_ohlc_candle',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Open', 'High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'candle',
                optMethod: null,
                deals: [
                    { keyOut: 'bodyRatio' },
                    { keyOut: 'upperWickRatio' },
                    { keyOut: 'lowerWickRatio' },
                    { keyOut: 'candleDir' },
                    { keyOut: 'engulfStrength' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_close',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: ['Close'],
        funAddKeysIn: null,
        methods: [
            {
                method: 'maNorm',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
            {
                method: 'emaNorm',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
            {
                method: 'vecNorm',
                optMethod: null,
                deals: [{ keyOut: 'param' }],
            },
        ],
    },
    {
        id: 'price_ohlc_cvd',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Volumn', 'TakerBuyBaseAssetVolume'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'cvd',
                optMethod: null,
                deals: [{ keyOut: 'cvd' }, { keyOut: 'cvdSlope' }],
            },
        ],
    },
    {
        id: 'price_ohlc_donchian',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'donchian',
                optMethod: null,
                deals: [{ keyOut: 'dcPctB' }, { keyOut: 'dcWidth' }, { keyOut: 'dcWidthChange' }],
            },
        ],
    },
    {
        id: 'price_ohlc_ichimoku',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'ichimoku',
                optMethod: null,
                deals: [{ keyOut: 'cloudDist' }, { keyOut: 'cloudThick' }, { keyOut: 'tkDiff' }],
            },
        ],
    },
    {
        id: 'price_ohlc_kdj',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'kdj',
                optMethod: null,
                deals: [
                    { keyOut: 'K' },
                    { keyOut: 'D' },
                    { keyOut: 'J' },
                    { keyOut: 'KminusD' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_keltner',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'keltner',
                optMethod: null,
                deals: [{ keyOut: 'kcPctB' }, { keyOut: 'kcWidth' }],
            },
        ],
    },
    {
        id: 'price_ohlc_klr',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Open', 'High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'klr',
                optMethod: null,
                deals: [
                    { keyOut: 'ho' },
                    { keyOut: 'lo' },
                    { keyOut: 'co' },
                    { keyOut: 'hc' },
                    { keyOut: 'lc' },
                    { keyOut: 'hl' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_macd',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'macd',
                optMethod: null,
                deals: [{ keyOut: 'DIF' }, { keyOut: 'DEM' }, { keyOut: 'OSC' }],
            },
        ],
    },
    {
        id: 'price_ohlc_mfi',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close', 'Volumn'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'mfi',
                optMethod: null,
                deals: [{ keyOut: 'MFI' }, { keyOut: 'MFIratio' }, { keyOut: 'MFIdiv' }],
            },
        ],
    },
    {
        id: 'price_ohlc_obv',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close', 'Volumn'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'obv',
                optMethod: null,
                deals: [{ keyOut: 'OBVnorm' }, { keyOut: 'OBVslope' }, { keyOut: 'OBVdiv' }],
            },
        ],
    },
    {
        id: 'price_ohlc_rsi',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'rsi',
                optMethod: null,
                deals: [
                    { keyOut: 'RSI' },
                    { keyOut: 'rsiAvgGain' },
                    { keyOut: 'rsiAvgLoss' },
                    { keyOut: 'rsiUp' },
                    { keyOut: 'rsiDown' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_supertrend',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'supertrend',
                optMethod: null,
                deals: [{ keyOut: 'stDistance' }],
            },
        ],
    },
    {
        id: 'price_ohlc_vortex',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'vortex',
                optMethod: null,
                deals: [
                    { keyOut: 'VIplus' },
                    { keyOut: 'VIminus' },
                    { keyOut: 'VIdiff' },
                    { keyOut: 'VIsum' },
                ],
            },
        ],
    },
    {
        id: 'price_ohlc_vwap',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['High', 'Low', 'Close', 'Volumn'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'vwap',
                optMethod: null,
                deals: [{ keyOut: 'vwapDist' }, { keyOut: 'vwapDistATR' }],
            },
        ],
    },
    {
        id: 'price_vbs',
        cointpe: 'price',
        keyKind: 'vbs',
        fields: ['Volumn', 'TakerBuyBaseAssetVolume'],
        keysIn: ['volumn', 'volumnBuy', 'volumnSell', 'volumnDiff', 'vbr', 'vsr', 'vdr'],
        funAddKeysIn: funAddKeysInVbs,
        methods: [
            {
                method: 'maNorm',
                optMethod: null,
                deals: [
                    { keyIn: 'volumn', keyOut: 'param' },
                    { keyIn: 'volumnBuy', keyOut: 'param' },
                    { keyIn: 'volumnSell', keyOut: 'param' },
                    { keyIn: 'volumnDiff', keyOut: 'param' },
                    { keyIn: 'vbr', keyOut: 'param' },
                    { keyIn: 'vsr', keyOut: 'param' },
                    { keyIn: 'vdr', keyOut: 'param' },
                ],
            },
            {
                method: 'emaNorm',
                optMethod: null,
                deals: [
                    { keyIn: 'volumn', keyOut: 'param' },
                    { keyIn: 'volumnBuy', keyOut: 'param' },
                    { keyIn: 'volumnSell', keyOut: 'param' },
                    { keyIn: 'volumnDiff', keyOut: 'param' },
                    { keyIn: 'vbr', keyOut: 'param' },
                    { keyIn: 'vsr', keyOut: 'param' },
                    { keyIn: 'vdr', keyOut: 'param' },
                ],
            },
            {
                method: 'vecNorm',
                optMethod: null,
                deals: [
                    { keyIn: 'volumn', keyOut: 'param' },
                    { keyIn: 'volumnBuy', keyOut: 'param' },
                    { keyIn: 'volumnSell', keyOut: 'param' },
                    { keyIn: 'volumnDiff', keyOut: 'param' },
                    { keyIn: 'vbr', keyOut: 'param' },
                    { keyIn: 'vsr', keyOut: 'param' },
                    { keyIn: 'vdr', keyOut: 'param' },
                ],
            },
        ],
    },
]


export { funAddKeysInVbs }
export default CATALOG
