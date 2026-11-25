//求解之決定性輔助(各unit-*.test.mjs引用; 本檔不帶.test.中綴, 不會被mocha當測試檔抓取)
//
//求解為隨機最佳化, 單輪之產出可為0個策略(罕見: 實測全隨機120輪0次、指定組成'4,2,0'〔6個條件〕40輪1次): 斷言「求解後至少有一個策略」之測試不得取決於偶然(規格: 測試規範〈斷言不得依賴隨機搜尋之產出數〉)。依斷言是否綁定輪數擇一:
//  ①綁定輪數或候選(maxRounds: 2、stopReason === 'maxRounds'、各輪之事件)之in-process(workers: 0)案: 用quickDetOf固定一切隨機來源, 產出為定數
//  ②不綁定輪數者(只需策略庫有策略)與workers>0(函數不跨worker, 無法如①): 用untilOne取得前提, 輪數有上限, 取不到即以明確訊息失敗(不是靜默通過)
//
//opt.oml.random(固定種子之函數)只管最佳化器; w-trade-solve之挑key(lodash sampleSize, 載入時即捕捉Math.random)與runRound每輪之方向、組成皆不經它, 故quickDetOf另以opt.mode、opt.comps與opt.funFilterKeysNorm/Index把挑選壓成唯一


//untilOne, 求解至策略庫至少1隻(單輪可能0隻); 輪數上限30
let untilOne = { maxStrategies: 1, maxRounds: 30 }


//mulberry32, 固定種子之小型PRNG(回傳[0,1)之函數, 同Math.random之約定); 供opt.oml.random注入
//  自帶於測試而不用wsemi之pseudoRandom(種子, true): 種子對應之序列屬wsemi之實作細節, 升版若改變序列, 「有產出」之前提會靜默失效, 夾具之序列須自身凍結
let mulberry32 = (seed) => {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}


//quickDetOf, 求解之決定性設定(僅workers為0時可用: 函數不跨worker); quick為各檔之快速求解設定(其oml一併保留)
//  ①最佳化之隨機: opt.oml.random(固定種子之mulberry32; 每次呼叫另建新函數, 同一函數勿同時交給多個進行中之求解)
//  ②每輪之交易方向: opt.mode
//  ③指標組成與挑key: opt.comps '1,1,0'(一般類1個、指數類1個)加opt.funFilterKeysNorm/Index(排序後各類只留第1個key), 使挑選恰為該二key, 無挑選之隨機性與次序
//  須有一般類與指數類之因子(建參數時含指數類之項目), 否則無可用之指標組成而throw
let quickDetOf = (quick, seed, mode = 'long') => {
    //mode須為long或short: 其他值時runRound會退回Math.random隨機取方向, 使本設定不再決定性
    if (mode !== 'long' && mode !== 'short') {
        throw new Error('invalid mode: must be long or short')
    }
    return {
        ...quick,
        mode,
        comps: '1,1,0',
        funFilterKeysNorm: async (ks) => ks.slice().sort().slice(0, 1),
        funFilterKeysIndex: async (ks) => ks.slice().sort().slice(0, 1),
        oml: { ...quick.oml, random: mulberry32(seed) },
    }
}


export { untilOne, mulberry32, quickDetOf }
