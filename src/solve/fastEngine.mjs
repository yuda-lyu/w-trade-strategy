import buildStrategyFastSession from 'w-trade-backtest/src/buildStrategyFastSession.mjs'


/**
 * 建立加速評估核心(抽自使用端既有管線之加速評估注入件)
 *
 * 產生w-trade-solve estimKeys之opt.funRunStrategyCustom: 以w-trade-backtest buildStrategyFastSession預算first-touch表與因子對位序列，每次評估約2~4ms(官方runStrategy約60~100ms)
 * 須搭配opt.useRunStrategyBeforeSave: true，使存檔前以官方runStrategy重衍生summary/tkid/檔名，落地口徑與完整版相同
 * session快取以funGetSeries(每輪一個)為錨，每(mode×keys組合)建一次
 *
 * @function
 * @returns {Function} 回傳async函數({ott,strategy,funGetSeries}) => {summary}
 * @example
 * need test in nodejs.
 *
 * let fast = makeFastEngine()
 * let r = await fast({ ott, strategy, funGetSeries })
 * console.log(r.summary.numTrade)
 */
let makeFastEngine = () => {
    let byFgs = new WeakMap()
    return async ({ ott, strategy, funGetSeries }) => {
        let m = byFgs.get(funGetSeries)
        if (!m) {
            m = new Map()
            byFgs.set(funGetSeries, m)
        }
        let keys = strategy.conds.map((c) => c.key)
        let sk = strategy.mode + '|' + [...keys].sort().join(',')
        let session = m.get(sk)
        if (!session) {
            let arrOhlc = await funGetSeries(strategy.keyOhlc)
            let serieses = {}
            for (let k of new Set(keys)) {
                serieses[k] = await funGetSeries(k)
            }
            session = buildStrategyFastSession(ott, { arrOhlc, mode: strategy.mode, serieses })
            m.set(sk, session)
        }
        let summary = session.evaluate({
            conds: strategy.conds,
            tp: strategy.settings.rTakeProfit,
            sl: strategy.settings.rStopLoss,
            settings: strategy.settings,
        })
        return { summary }
    }
}


export default makeFastEngine
