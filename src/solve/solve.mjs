import path from 'path'
import { Worker } from 'worker_threads'
import get from 'lodash-es/get.js'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isnum from 'wsemi/src/isnum.mjs'
import { prepareSolve, runRound } from './solveRound.mjs'
import { serializableCfg } from '../cfg.mjs'
import { ensureFolder, countJson } from '../util/fsx.mjs'


/**
 * solve之opt內允許為函數之事件欄位(其餘函數欄位於workers>0時不可用)
 *
 * @type {Array}
 */
let EVENT_KEYS = Object.freeze(['onReady', 'onRound', 'onCandidate', 'onProgress', 'onError', 'shouldStop'])


/**
 * solve之opt全部可用鍵(createSolver、prepareSolve與runRound讀取者之聯集)，不在此者於建立求解器時拋錯
 *
 * @type {Array}
 */
let SOLVE_OPT_KEYS = Object.freeze([
    'fdStrategies', 'engine', 'methodOml', 'workers', 'closeOnly', 'comps', 'mode',
    'funFilterKeysNorm', 'funFilterKeysIndex', 'funFilterKeysVolumn',
    'thsTp', 'thsSl', 'thNumTrade', 'thRWin', 'thEqYr', 'thREquivalentCumuProfitOrLossFinalNormYear', 'oml',
    'maxStrategies', 'maxRounds', 'maxTimeMs', 'maxRoundsPerWorker', 'useShowLog',
    ...EVENT_KEYS,
])


/**
 * 建立求解器: 持續執行求解輪次擴建策略庫，提供事件回傳與停止條件
 *
 * 每輪為一次w-trade-solve estimFinder(隨機方向與指標組成，於訓練期率定門檻與止盈止損)，達門檻之策略由estimKeys寫入策略庫(同tkid僅於更佳時覆寫)
 * 預設engine為'fast'(加速評估核心，存檔前官方重跑)，'full'為全程官方runStrategy
 * opt.workers為0時於本程序內循序執行(opt可含函數)，>0時以worker_threads平行執行(opt除事件欄位外不可含函數，改用closeOnly等旗標)
 * 停止條件: maxStrategies(策略庫檔數達此即停)、maxRounds(總輪數)、maxTimeMs、shouldStop(status) => bool、或呼叫stop()；workers>0時各worker每輪結束皆等主程序放行才起下一輪，故停止條件成立時進行中之他worker至多再完成當輪(總輪數至多超出workers-1)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件(須含train)
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {String} [opt.fdStrategies] 輸入策略庫資料夾，預設cfg.fds.strategies
 * @param {String} [opt.engine='fast'] 輸入評估核心，'fast'或'full'
 * @param {String} [opt.methodOml='RGA'] 輸入最佳化演算法，'RGA'、'DE'、'HS'、'PSO'或'ACO'
 * @param {Integer} [opt.workers=0] 輸入平行worker數，0為本程序內執行
 * @param {Boolean} [opt.closeOnly=false] 輸入是否只用由Close推導之因子
 * @param {Array|String} [opt.comps] 輸入指標組成候選('a,b,c')，預設18種，依可用因子類別數自動過濾
 * @param {String} [opt.mode] 輸入固定交易方向'long'或'short'，未給時每輪隨機
 * @param {Array} [opt.thsTp] 輸入止盈門檻百分比陣列，預設1~10
 * @param {Array} [opt.thsSl] 輸入止損門檻百分比陣列，預設1~10
 * @param {Number} [opt.thNumTrade=1] 輸入存檔之最少交易次數
 * @param {Number} [opt.thRWin=0.5] 輸入存檔之最低勝率
 * @param {Number} [opt.thEqYr=0.15] 輸入存檔之最低等效年化(比例)
 * @param {Number} [opt.thREquivalentCumuProfitOrLossFinalNormYear] 輸入存檔之最低等效年化(比例)，為thEqYr之原名，兩者皆給時以thEqYr為準
 * @param {Function} [opt.funFilterKeysNorm] 輸入一般類因子key之過濾函數async (keys) => keys，僅workers為0時可用；未給且closeOnly為true時採Close-only過濾
 * @param {Function} [opt.funFilterKeysIndex] 輸入指數類因子key之過濾函數，規則同funFilterKeysNorm
 * @param {Function} [opt.funFilterKeysVolumn] 輸入成交量類因子key之過濾函數，規則同funFilterKeysNorm
 * @param {Integer} [opt.maxRoundsPerWorker] 輸入每個worker至多執行之輪數，僅workers大於0時有效；未給或非正整數為不限
 * @param {Object} [opt.oml] 輸入最佳化演算法設定(如Np、Ng、NContiguous)，原樣傳遞
 * @param {Integer} [opt.maxStrategies] 輸入策略庫檔數達此即停
 * @param {Integer} [opt.maxRounds] 輸入總輪數上限
 * @param {Integer} [opt.maxTimeMs] 輸入總時長上限(毫秒)
 * @param {Function} [opt.shouldStop] 輸入自訂停止判斷(status) => Boolean，每輪結束檢查
 * @param {Function} [opt.onReady] 輸入準備完成回呼({workerId,counts,comps,engine})
 * @param {Function} [opt.onRound] 輸入每輪結束回呼({workerId,mode,comps,timeStart,timeEnd,candidates,...status})，其中elapsedMs為求解器累計耗時(status覆寫該輪耗時)
 * @param {Function} [opt.onCandidate] 輸入每個達門檻候選回呼({workerId,mode,comps,keys,conds,settings,summary})
 * @param {Function} [opt.onProgress] 輸入每輪結束之狀態回呼(status)
 * @param {Function} [opt.onError] 輸入worker錯誤回呼(err)
 * @param {Boolean} [opt.useShowLog=false] 輸入是否顯示求解過程log
 * @returns {Object} 回傳求解器{start,stop,status}，start()回傳Promise(resolve為最終status)，stop()要求停止，status()回傳目前狀態{state,nRounds,nCandidates,nStrategies,nStrategiesStart,nNew,elapsedMs,workers,engine,fdStrategies,stopReason,errors}
 * @example
 * need test in nodejs.
 *
 * let sv = createSolver(cfg, { workers: 4, maxStrategies: 30000, onRound: (ev) => console.log(ev.nStrategies) })
 * let st = await sv.start()
 * console.log(st.stopReason, st.nRounds)
 */
let createSolver = (cfg, opt = {}) => {

    if (opt === null || typeof opt !== 'object' || Array.isArray(opt)) {
        throw new Error(`invalid opt`)
    }
    let unknown = Object.keys(opt).filter((k) => !SOLVE_OPT_KEYS.includes(k))
    if (unknown.length > 0) {
        throw new Error(`opt含不認得之鍵[${unknown.join(', ')}], 可用: ${SOLVE_OPT_KEYS.join(', ')}`)
    }

    let workers = get(opt, 'workers', 0)
    if (!Number.isInteger(workers) || workers < 0) {
        workers = 0
    }
    let fdStrategies = get(opt, 'fdStrategies', '')
    fdStrategies = isestr(fdStrategies) ? path.resolve(fdStrategies) : cfg.fds.strategies
    ensureFolder(fdStrategies)

    let maxStrategies = isnum(opt.maxStrategies) ? opt.maxStrategies : 0
    let maxRounds = isnum(opt.maxRounds) ? opt.maxRounds : 0
    let maxTimeMs = isnum(opt.maxTimeMs) ? opt.maxTimeMs : 0

    let st = {
        state: 'idle',
        nRounds: 0,
        nCandidates: 0,
        nStrategies: countJson(fdStrategies),
        nStrategiesStart: 0,
        workers,
        engine: get(opt, 'engine', 'fast') === 'full' ? 'full' : 'fast',
        fdStrategies,
        errors: [],
    }
    st.nStrategiesStart = st.nStrategies
    let t0 = null
    let stopReason = null
    let stopFlag = false
    let wks = []

    let emit = (name, ev) => {
        let f = get(opt, name, null)
        if (isfun(f)) {
            f(ev)
        }
    }

    let status = () => ({
        ...st,
        nNew: st.nStrategies - st.nStrategiesStart,
        elapsedMs: t0 === null ? 0 : Date.now() - t0,
        stopReason,
    })

    let checkStop = () => {
        if (stopFlag) {
            return 'stop()'
        }
        if (maxStrategies > 0 && st.nStrategies >= maxStrategies) {
            return 'maxStrategies'
        }
        if (maxRounds > 0 && st.nRounds >= maxRounds) {
            return 'maxRounds'
        }
        if (maxTimeMs > 0 && t0 !== null && Date.now() - t0 >= maxTimeMs) {
            return 'maxTimeMs'
        }
        if (isfun(opt.shouldStop) && opt.shouldStop(status()) === true) {
            return 'shouldStop'
        }
        return null
    }

    let onRoundDone = (r) => {
        st.nRounds++
        st.nCandidates += get(r, 'candidates', 0)
        st.nStrategies = countJson(fdStrategies)
        emit('onRound', { ...r, ...status() })
        emit('onProgress', status())
    }

    let runInProcess = async () => {
        let prep = await prepareSolve(cfg, { ...opt, fdStrategies })
        emit('onReady', { workerId: 0, counts: prep.counts, comps: prep.comps, engine: prep.engine })
        stopReason = checkStop()
        while (!stopReason) {
            let r = await runRound(cfg, opt, prep, {
                onCandidate: (ev) => emit('onCandidate', { workerId: 0, ...ev }),
            })
            onRoundDone({ workerId: 0, ...r })
            stopReason = checkStop()
        }
    }

    let runWorkers = async () => {
        for (let k of Object.keys(opt)) {
            if (isfun(opt[k]) && !EVENT_KEYS.includes(k)) {
                throw new Error(`workers>0時opt.${k}不可為函數(worker無法序列化), 請改用closeOnly等旗標或workers:0`)
            }
        }
        let optSer = {}
        for (let k of Object.keys(opt)) {
            if (!isfun(opt[k])) {
                optSer[k] = opt[k]
            }
        }
        optSer.fdStrategies = fdStrategies
        let cfgSer = serializableCfg(cfg)
        await new Promise((resolve, reject) => {
            let alive = workers
            let settled = false
            let requestStop = (why) => {
                if (!stopReason) {
                    stopReason = why
                }
                for (let wk of wks) {
                    try {
                        wk.postMessage({ type: 'stop' })
                    }
                    catch (err) {}
                }
            }
            let maybeStop = () => {
                let why = checkStop()
                if (why) {
                    requestStop(why)
                }
            }
            let onExit = () => {
                alive--
                if (alive <= 0 && !settled) {
                    settled = true
                    if (!stopReason && st.nRounds === 0 && st.errors.length > 0) {
                        reject(new Error(st.errors[0]))
                    }
                    else {
                        resolve()
                    }
                }
            }
            for (let i = 0; i < workers; i++) {
                let wk = new Worker(new URL('./solveWorker.mjs', import.meta.url), { workerData: { cfg: cfgSer, opt: optSer, workerId: i } })
                wks.push(wk)
                wk.on('message', (m) => {
                    if (!m || !m.type) {
                        return
                    }
                    if (m.type === 'ready') {
                        emit('onReady', m)
                    }
                    else if (m.type === 'candidate') {
                        emit('onCandidate', m)
                    }
                    else if (m.type === 'round') {
                        onRoundDone(m)
                        maybeStop()
                        if (!stopReason) {
                            try {
                                wk.postMessage({ type: 'continue' }) //未達停止條件才放行下一輪(worker於round後等此回覆)
                            }
                            catch (err) {}
                        }
                    }
                    else if (m.type === 'error') {
                        st.errors.push(m.err)
                        emit('onError', new Error(m.err))
                        wk.terminate() //worker之parentPort監聯會撐住執行緒, 由主程序終止
                    }
                    else if (m.type === 'done') {
                        wk.terminate() //同上: worker迴圈結束後由主程序終止, 否則執行緒不會自行退出
                    }
                })
                wk.on('error', (err) => {
                    st.errors.push(String((err && err.stack) || err))
                    emit('onError', err)
                })
                wk.on('exit', onExit)
            }
            if (stopFlag) {
                requestStop('stop()')
            }
        })
        wks = []
    }

    let start = async () => {
        if (st.state !== 'idle') {
            throw new Error(`solver已啟動(state ${st.state})`)
        }
        st.state = 'running'
        t0 = Date.now()
        try {
            if (workers <= 0) {
                await runInProcess()
            }
            else {
                await runWorkers()
            }
            st.state = 'done'
        }
        catch (err) {
            st.state = 'error'
            throw err
        }
        return status()
    }

    let stop = () => {
        stopFlag = true
        if (!stopReason) {
            stopReason = 'stop()'
        }
        for (let wk of wks) {
            try {
                wk.postMessage({ type: 'stop' })
            }
            catch (err) {}
        }
    }

    return { start, stop, status }
}


/**
 * 執行求解至停止條件成立(createSolver之便捷包裝)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @param {Object} [opt={}] 輸入設定物件，見createSolver
 * @returns {Promise} 回傳Promise，resolve為最終status
 * @example
 * need test in nodejs.
 *
 * let st = await solve(cfg, { maxRounds: 10 })
 * console.log(st.nStrategies)
 */
let solve = (cfg, opt = {}) => createSolver(cfg, opt).start()


export { createSolver, solve, EVENT_KEYS, SOLVE_OPT_KEYS }
export default solve
