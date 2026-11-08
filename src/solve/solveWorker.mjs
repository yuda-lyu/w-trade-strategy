import { parentPort, workerData } from 'worker_threads'
import { prepareSolve, runRound } from './solveRound.mjs'


//求解worker entry: workerData = { cfg(serializableCfg), opt(不含函數), workerId }
//  迴圈執行runRound: 準備完成回報{type:'ready'}後等主程序回{type:'continue'}才起第1輪, 其後每輪結束回報{type:'round'}後同樣等{type:'continue'}才起下一輪(或收{type:'stop'}即結束),
//  使停止條件與資源閘(opt.gate, 於主程序執行)於各worker每輪起跑前皆生效;
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
    let go0 = waitGo() //先建立等待再回報ready, 主程序之continue/stop不致早於等待而遺失
    parentPort.postMessage({ type: 'ready', workerId, counts: prep.counts, comps: prep.comps, engine: prep.engine })
    await go0 //第1輪亦等主程序放行(主程序於ready後經資源閘才回continue; 已收stop者立即回, 下方迴圈不進入)
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
