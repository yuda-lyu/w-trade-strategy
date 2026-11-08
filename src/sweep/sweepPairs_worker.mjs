import { parentPort, workerData } from 'worker_threads'
import createCore from './sweepPairs_core.mjs'


//worker entry(parfor協定): workerData = { sc, p2data }(主程序precompute之共享資料, 結構化複製注入一次)
let core = createCore(workerData)

parentPort.on('messageerror', (err) => {
    throw err
})
parentPort.on('message', async (m) => {
    let { k, job } = m
    try {
        let r = await core(job)
        parentPort.postMessage({ k, r })
    }
    catch (err) {
        parentPort.postMessage({ k, err: String((err && err.stack) || err) })
    }
})
