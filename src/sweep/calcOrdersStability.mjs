//策略級edge穩定度共用核心(抽自使用端既有管線)
//  口徑: edge = 窗內「策略已結單勝率」− 窗內「同(mode,tp,sl)全bar first-touch基準勝率」(pp)
//  用「勝率超出基準」而非原始報酬: scale-free, 不隨TP/SL放大, 且把「行情本身好壞」從策略表現中扣除


//meanOf, stdOf: 母體均值/標準差(ddof=0)
let meanOf = (a) => {
    if (a.length < 1) {
        return 0
    }
    let m = 0
    for (let v of a) {
        m += v
    }
    return m / a.length
}
let stdOf = (a) => {
    let n = a.length
    if (n < 1) {
        return 0
    }
    let m = meanOf(a)
    let s = 0
    for (let v of a) {
        let d = v - m
        s += d * d
    }
    return Math.sqrt(s / n)
}


/**
 * 建立區段內逐bar「已結／勝」之prefix sums基準(供edge計算)
 *
 * @function
 * @param {Array} times 輸入升序bar時間陣列(呼叫端已限定評估區段)
 * @param {Function} getRec 輸入取該bar於此(mode,tp,sl)之first-touch結果函數(t) => {win,timeEnd}或undefined
 * @param {String} [maxExitTime=null] 輸入出場裁切時間，出場>=它視未結；null不裁
 * @returns {Object} 回傳{n,idxOf(時間→索引Map),pr(已結數prefix),pw(勝數prefix)}
 * @example
 *
 * let recs = { t1: { win: 1, timeEnd: 't2' }, t2: { win: 0, timeEnd: 't3' }, t3: { win: -1, timeEnd: null } }
 * let base = buildBaseBars(['t1', 't2', 't3'], (t) => recs[t])
 * console.log(base.n, Array.from(base.pr).join(','), Array.from(base.pw).join(','))
 * // => 3 0,1,2,2 0,1,1,1
 *
 */
let buildBaseBars = (times, getRec, maxExitTime = null) => {
    let n = times.length
    let pr = new Int32Array(n + 1)
    let pw = new Int32Array(n + 1)
    let idxOf = new Map()
    for (let i = 0; i < n; i++) {
        idxOf.set(times[i], i)
        let rec = getRec(times[i])
        let resolved = rec && rec.win >= 0 && rec.timeEnd && (!maxExitTime || rec.timeEnd < maxExitTime)
        pr[i + 1] = pr[i] + (resolved ? 1 : 0)
        pw[i + 1] = pw[i] + (resolved && rec.win === 1 ? 1 : 0)
    }
    return { n, idxOf, pr, pw }
}


/**
 * 二項分布單尾尾機率P(X >= k | n, p)(log空間累加)
 *
 * @function
 * @param {Number} n 輸入試驗次數
 * @param {Number} k 輸入成功次數門檻
 * @param {Number} p 輸入單次成功機率
 * @returns {Number} 回傳機率
 * @example
 *
 * console.log(binomTailGE(10, 5, 0.5).toFixed(4), binomTailGE(10, 0, 0.5), binomTailGE(10, 11, 0.5))
 * // => 0.6230 1 0
 *
 */
let binomTailGE = (n, k, p) => {
    if (p <= 0) {
        return k <= 0 ? 1 : 0
    }
    if (p >= 1) {
        return 1
    }
    let lp = Math.log(p)
    let lq = Math.log(1 - p)
    let logC = 0
    let s = 0
    for (let i = 0; i <= n; i++) {
        if (i >= k) {
            s += Math.exp(logC + i * lp + (n - i) * lq)
        }
        logC += Math.log(n - i) - Math.log(i + 1)
    }
    return Math.min(s, 1)
}


/**
 * 計算策略已結訂單相對基準之edge穩定度並綜合判定(雙軌：滾動窗icir軌／小樣本sparse軌)
 *
 * icir軌(有效窗數>=minRollEdges)：edgeICIR、edgePosRatio、時間等分塊覆蓋與正向比皆達門檻才ok；sparse軌(窗數不足但全段已結>=sparseMinN)：全段edge>0、二項顯著性p<sparsePMax且已結分布於>=sparseMinBlocks個時間塊；已結<sparseMinN者不可評估(track null、ok false)
 *
 * @function
 * @param {Object} base 輸入buildBaseBars之回傳
 * @param {Array} orders 輸入訂單陣列(未結者timeEnd為空字串，自動跳過)
 * @param {Object} [opt={}] 輸入門檻物件(見sweep/common之assmDefaultOf)，預設以4hr K線之90天/30天窗為準
 * @returns {Object} 回傳{ok,track,edge,edgeICIR,edgePosRatio,edgeT,blockPosRatio,blockFullCoverage,nRoll,nFin,sparseP}
 * @example
 *
 * let times = Array.from({ length: 40 }, (v, i) => `t${String(i).padStart(2, '0')}`)
 * let base = buildBaseBars(times, (t) => ({ win: Number(t.slice(1)) % 2, timeEnd: 'z' }))
 * let orders = times.filter((t, i) => i % 2 === 1).map((t) => ({ timeStart: t, timeEnd: 'z', uProfitOrLoss: 1 }))
 * let r = calcOrdersStability(base, orders, { rollWindowBars: 10, rollStepBars: 10, minRollResolved: 2, minRollEdges: 2, icirMin: 0 })
 * console.log(r.track, r.ok, r.nFin, r.edge, r.edgeICIR, r.edgePosRatio)
 * // => icir true 20 50 0 1
 *
 */
let calcOrdersStability = (base, orders, opt = {}) => {

    let rollWindowBars = opt.rollWindowBars ?? 540
    let rollStepBars = opt.rollStepBars ?? 180
    let minRollResolved = opt.minRollResolved ?? 5
    let minRollEdges = opt.minRollEdges ?? 4
    let icirMin = opt.icirMin ?? 0.5
    let posMin = opt.posMin ?? 0.6
    let nBlocks = opt.nBlocks ?? 4
    let minBlockResolved = opt.minBlockResolved ?? 5
    let blockPosMin = opt.blockPosMin ?? 0.5
    let sparseMinN = opt.sparseMinN ?? 10
    let sparsePMax = opt.sparsePMax ?? 0.1
    let sparseMinBlocks = opt.sparseMinBlocks ?? 2

    let ent = []
    for (let o of orders) {
        if (!o.timeEnd) {
            continue
        }
        let i = base.idxOf.get(o.timeStart)
        if (i === undefined) {
            continue
        }
        ent.push({ i, w: o.uProfitOrLoss > 0 ? 1 : 0 })
    }

    let edgeOver = (i0, i1, minN) => {
        let fc = 0
        let fw = 0
        for (let e of ent) {
            if (e.i < i0 || e.i >= i1) {
                continue
            }
            fc++
            fw += e.w
        }
        let bc = base.pr[i1] - base.pr[i0]
        let bw = base.pw[i1] - base.pw[i0]
        if (fc < minN || bc === 0) {
            return null
        }
        return (fw / fc - bw / bc) * 100
    }

    let edge = edgeOver(0, base.n, 1)

    let rollEdges = []
    for (let w0 = 0; w0 + rollWindowBars <= base.n; w0 += rollStepBars) {
        let e = edgeOver(w0, w0 + rollWindowBars, minRollResolved)
        if (e !== null) {
            rollEdges.push(e)
        }
    }
    let nRoll = rollEdges.length
    let edgeICIR = null
    let edgePosRatio = null
    let edgeT = null
    if (nRoll >= minRollEdges) {
        let m = meanOf(rollEdges)
        let sd = stdOf(rollEdges)
        edgeICIR = sd > 1e-9 ? m / sd : 0
        edgePosRatio = rollEdges.filter((e) => e > 0).length / nRoll
        edgeT = edgeICIR * Math.sqrt(nRoll)
    }

    let blockEdges = []
    for (let b = 0; b < nBlocks; b++) {
        let i0 = Math.floor(b * base.n / nBlocks)
        let i1 = Math.floor((b + 1) * base.n / nBlocks)
        blockEdges.push(edgeOver(i0, i1, minBlockResolved))
    }
    let valid = blockEdges.filter((e) => e !== null)
    let blockFullCoverage = valid.length === nBlocks
    let blockPosRatio = valid.length ? valid.filter((e) => e > 0).length / valid.length : null

    let nFin = ent.length
    let track = null
    let ok = false
    let sparseP = null
    if (nRoll >= minRollEdges) {
        track = 'icir'
        ok = blockFullCoverage &&
            (edgeICIR !== null && edgeICIR >= icirMin) &&
            (edgePosRatio !== null && edgePosRatio >= posMin) &&
            (blockPosRatio !== null && blockPosRatio >= blockPosMin)
    }
    else if (nFin >= sparseMinN) {
        track = 'sparse'
        let fw = 0
        for (let e of ent) {
            fw += e.w
        }
        let bc = base.pr[base.n]
        let bw = base.pw[base.n]
        let pBase = bc > 0 ? bw / bc : null
        sparseP = pBase !== null ? binomTailGE(nFin, fw, pBase) : null
        let blocksHit = 0
        for (let b = 0; b < nBlocks; b++) {
            let i0 = Math.floor(b * base.n / nBlocks)
            let i1 = Math.floor((b + 1) * base.n / nBlocks)
            if (ent.some((e) => e.i >= i0 && e.i < i1)) {
                blocksHit++
            }
        }
        ok = (edge !== null && edge > 0) &&
            (sparseP !== null && sparseP < sparsePMax) &&
            blocksHit >= sparseMinBlocks
    }

    return { ok, track, edge, edgeICIR, edgePosRatio, edgeT, blockPosRatio, blockFullCoverage, nRoll, nFin, sparseP }
}


/**
 * 穩定度核心之聚合物件{buildBaseBars,calcOrdersStability}
 *
 * @type {Object}
 */
let r = {
    buildBaseBars,
    calcOrdersStability,
}


export { buildBaseBars, calcOrdersStability, binomTailGE }
export default r
