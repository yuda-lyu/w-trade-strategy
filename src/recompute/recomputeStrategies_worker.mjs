import { parentPort, workerData } from 'worker_threads'
import createCore from './recomputeStrategies_core.mjs'


//worker entry(parfor協定): workerData為{fdIn,fdOhlc,fdParam,timeZone,mode,target}, 序列於首次用到之求解時間窗時載入(每worker一次)
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
