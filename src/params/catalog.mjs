//內建參數(因子)目錄: 由使用端既有管線之 34 個參數定義抽提(另增方向改變法 price_ohlc_dirchange 與價格側之 price_ohlc_momz、price_ohlc_volx、price_ohlc_down、price_ohlc_flow, 共 39 個), 去除幣種專屬之 nm(avg/std, 改由 buildParams 依指定期間自算並凍結於 meta)
//  各定義: { id, cointpe('price'|'index'), keyKind('ohlc'|'vbs'), fields(計算實際存取之 K 線欄位; 數據缺任一欄即整個定義跳過), keysIn(取值類之來源欄位; 空陣列代表 'none'),
//           funAddKeysIn(逐筆擴增欄位之函數, 僅 vbs 用), methods: [{ method, optMethod(index 側之偏移參數, 為校正起點; null=無), deals: [{ keyIn?, keyOut }] }] }
//  key 命名由 w-data-trade dataConvert 決定: `${cointpe}_${keyKind}_${keyIn||'none'}_${keyOut}_${method}_${period}`
//  index 側之 optMethod 預設值為 ETH 之率定值; buildParams 預設會以 w-data-trade dataCalibrate 對新幣種重新校正(以 price 側同名 keyOut 為參考), 結果凍結於 meta
//  各 calc 之週期表之值為根數(根數為本; w-data-trade >= 1.0.50), 標籤以每根 4hr 寫定(1day = 6 根 …); buildParams 於每次呼叫併入 intervalSec(= cfg.intervalSec, 每根 K 線之秒數), 其他 interval 之根數不變、期別標籤 = 根數 × 每根秒數(1hr 之 6 根為 6hr; 見 README §4 K 線週期)
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
 * 內建參數(因子)定義目錄(39個定義、170個輸出；price 25、index 14)，各定義格式見檔頭
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
        //方向改變法(directional change): 只用收盤之因果估計(w-data-trade calcDirChange); 門檻表為價格之比例(4、6、8、10%), 期別段為`${門檻}pct`, 不隨K線週期改變
        //  只列價格側: 溢價指數之值近0、取對數無意義
        id: 'price_ohlc_dirchange',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'dirChange',
                optMethod: null,
                deals: [
                    { keyOut: 'dirState' },
                    { keyOut: 'dirRetrace' },
                    { keyOut: 'dirRun' },
                    { keyOut: 'dirAge' },
                ],
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
        //下跌之統計(w-data-trade calcDown): 以keyIn欄位(Close)取對數報酬並讀Volumn; 收跌根數比例、收跌根之量占比、暴跌根數; 週期表用calc內建者(根數3、4、5、6、12、24、42、90、180; 期別標籤依每根秒數換算)
        //  keysIn為['Close']: calcDown以其key參數(= dataConvert傳入之keyIn)為取值欄位名, 'none'即讀不到欄位而整批reject(不同於rsi等不讀key者); 輸出key之keyIn段為Close
        //  只列價格側: 溢價指數之值可為0或負, 取對數無意義, 且無成交量欄
        id: 'price_ohlc_down',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close', 'Volumn'],
        keysIn: ['Close'],
        funAddKeysIn: null,
        methods: [
            {
                method: 'down',
                optMethod: null,
                deals: [{ keyOut: 'downBars' }, { keyOut: 'downVol' }, { keyOut: 'crashN' }],
            },
        ],
    },
    {
        //主動買賣量之水準、速度與加速度(w-data-trade calcFlow): 讀Volumn與TakerBuyBaseAssetVolume; buy、sell、net、share各取L(水準)、V(速度)、A(加速度)共12欄; 週期表同上
        //  只列價格側: 溢價指數無成交量欄
        id: 'price_ohlc_flow',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Volumn', 'TakerBuyBaseAssetVolume'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'flow',
                optMethod: null,
                deals: [
                    { keyOut: 'buyL' },
                    { keyOut: 'buyV' },
                    { keyOut: 'buyA' },
                    { keyOut: 'sellL' },
                    { keyOut: 'sellV' },
                    { keyOut: 'sellA' },
                    { keyOut: 'netL' },
                    { keyOut: 'netV' },
                    { keyOut: 'netA' },
                    { keyOut: 'shareL' },
                    { keyOut: 'shareV' },
                    { keyOut: 'shareA' },
                ],
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
        //波動標準化之動能(w-data-trade calcMomz): 以keyIn欄位(Close)取對數報酬(須為正數); 以波動(近30根對數報酬之母體標準差)為單位之動能、速度、加速度、已漲之幅與效率比; 週期表用calc內建者(根數3、4、5、6、12、24、42、90、180; 期別標籤依每根秒數換算)
        //  keysIn為['Close']: calcMomz以其key參數(= dataConvert傳入之keyIn)為取值欄位名, 'none'即讀不到欄位而整批reject(不同於rsi等不讀key者); 輸出key之keyIn段為Close
        //  只列價格側: 溢價指數之值可為0或負, 取對數無意義
        id: 'price_ohlc_momz',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Close'],
        keysIn: ['Close'],
        funAddKeysIn: null,
        methods: [
            {
                method: 'momz',
                optMethod: null,
                deals: [
                    { keyOut: 'momZ' },
                    { keyOut: 'vel' },
                    { keyOut: 'acc' },
                    { keyOut: 'ext' },
                    { keyOut: 'er' },
                ],
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
        //波動之延伸(w-data-trade calcVolx): 讀Open、High、Low、Close(須為正數且High、Low涵蓋開收); 已實現波動與高低開收估計之波動(對數)、短長期之比、Choppiness、下行占比、跳躍占比、變異數比、波動之波動; 週期表用calc內建者(根數3、4、5、6、12、24、42、90、180; 期別標籤依每根秒數換算)
        //  只列價格側: 溢價指數之值可為0或負, 取對數無意義
        id: 'price_ohlc_volx',
        cointpe: 'price',
        keyKind: 'ohlc',
        fields: ['Open', 'High', 'Low', 'Close'],
        keysIn: [],
        funAddKeysIn: null,
        methods: [
            {
                method: 'volx',
                optMethod: null,
                deals: [
                    { keyOut: 'rv' },
                    { keyOut: 'park' },
                    { keyOut: 'gk' },
                    { keyOut: 'rs' },
                    { keyOut: 'rvRatio' },
                    { keyOut: 'chop' },
                    { keyOut: 'downShare' },
                    { keyOut: 'jumpShare' },
                    { keyOut: 'varRatio' },
                    { keyOut: 'volOfVol' },
                ],
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
