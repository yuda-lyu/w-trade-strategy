import { parentPort, workerData } from 'worker_threads'
import { prepareSolve, runRound } from './solveRound.mjs'


//求解worker entry: workerData = { cfg(serializableCfg), opt(不含函數), workerId }
//  迴圈執行runRound: 每輪結束回報{type:'round'}後等主程序回{type:'continue'}才起下一輪(或收{type:'stop'}即結束), 使停止條件於各worker當輪結束即生效;
//  每個候選回報{type:'candidate'}; 達opt.maxRoundsPerWorker亦結束; 結束回報{type:'done'}(主程序據此terminate)
let { cfg, opt, workerId } = workerData

let stopped = false
let pending = null //等主程序回覆之resolve
parentPort.on('message', (m) => {
    if (!m || !m.type) {
        return
    }
    if (m.type === 'stop') {
        stopped = true
    }
    if ((m.type === 'stop' || m.type === 'continue') && pending) {
        let f = pending
        pending = null
        f()
    }
})

//waitGo, 等主程序之continue/stop(已收stop者立即回)
let waitGo = () => new Promise((resolve) => {
    if (stopped) {
        resolve()
        return
    }
    pending = resolve
})

let main = async () => {
    let prep = await prepareSolve(cfg, opt)
    parentPort.postMessage({ type: 'ready', workerId, counts: prep.counts, comps: prep.comps, engine: prep.engine })
    let i = 0
    let maxRounds = Number.isInteger(opt.maxRoundsPerWorker) && opt.maxRoundsPerWorker > 0 ? opt.maxRoundsPerWorker : 0
    //stopped由parentPort之message事件改動(每輪結束await waitGo時有機會處理), eslint看不見故停用該規則
    // eslint-disable-next-line no-unmodified-loop-condition
    while (!stopped) {
        if (maxRounds > 0 && i >= maxRounds) {
            break
        }
        let r = await runRound(cfg, opt, prep, {
            onCandidate: (ev) => parentPort.postMessage({ type: 'candidate', workerId, ...ev }),
        })
        i++
        let go = waitGo()
        parentPort.postMessage({ type: 'round', workerId, ...r })
        await go
    }
    parentPort.postMessage({ type: 'done', workerId, nRounds: i })
}

main().catch((err) => {
    parentPort.postMessage({ type: 'error', workerId, err: String((err && err.stack) || err) })
})
