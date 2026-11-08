import map from 'lodash-es/map.js'
import round from 'lodash-es/round.js'
import readStrategies from 'w-trade-solve/src/readStrategies.mjs'


/**
 * 讀單因子普測之策略資料夾，轉為單因子配置陣列(僅於主程序讀取一次，job索引即此陣列順序；worker取用主程序precompute後經workerData注入之共享資料，不再自行讀取)
 *
 * @function
 * @param {String} fdF1 輸入單因子策略資料夾路徑字串
 * @returns {Array} 回傳[{key,sym,th,mode,tpsl}]，tpsl由rTakeProfit還原取整
 * @example
 * need test in nodejs.
 *
 * let fs1 = readF1Factors('./data/strategiesP1')
 * console.log(fs1.length, fs1[0])
 */
let readF1Factors = (fdF1) => {
    let ss = readStrategies(fdF1, { readContent: true })
    return map(ss, 'data')
        .filter((s) => s && Array.isArray(s.conds) && s.conds.length > 0 && s.settings)
        .map((s) => ({
            key: s.conds[0].key,
            sym: s.conds[0].sym,
            th: s.conds[0].th,
            mode: s.mode,
            tpsl: round(s.settings.rTakeProfit * 100), //由rTakeProfit(=tpsl/100)還原取整 → 對應快取key
        }))
}


export default readF1Factors
