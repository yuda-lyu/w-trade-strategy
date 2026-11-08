import { parentPort, workerData } from 'worker_threads'
import createCore from './sweepSingle_core.mjs'


//worker entry(parfor協定): workerData為sweepCfgOf之設定, createCore時載入先觸快取(每worker一次)
let core = createCore(workerData)

parentPort.on('messageerror', (err) => {
    throw err
}) //job反序列化失敗時拋出使parfor fail-fast
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
