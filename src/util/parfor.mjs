import os from 'os'
import { Worker } from 'worker_threads'


//本檔抽自w-package-tools/src/parfor.mjs(同作者, MIT), 以免執行期依賴開發工具套件


/**
 * 輕量持久worker pool平行執行器，以原生worker_threads把CPU密集計算分散到多核心，免任何編譯步驟
 *
 * worker協定(worker entry檔須遵守):
 *   1. 經workerData收initData(一次)
 *   2. 收{ k, job } → 計算 → 回{ k, r }
 *   3. 單job失敗回{ k, err }(err為字串) → 不炸批，主程序印錯後續跑
 *   4. worker載入/init失敗 → 整批fail-fast拋錯
 *   5. worker不得自行退出；整批完成前之任何退出、建立失敗、結果反序列化失敗、job無法結構化複製、cb拋錯 → 皆整批fail-fast拋錯並terminate全部worker
 *   6. worker entry須綁parentPort.on('messageerror', (err) => { throw err })
 *
 * @function
 * @param {String|URL} fpWorker 輸入worker entry之file URL(建議new URL('./xxx_worker.mjs', import.meta.url))或絕對路徑字串
 * @param {Array} jobs 輸入工作陣列，每個job經postMessage結構化複製傳入worker
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Integer} [opt.takeLimit=os.availableParallelism()-1] 輸入同時worker數正整數，至少1
 * @param {*} [opt.initData] 輸入經workerData一次性注入每個worker的共享唯讀資料
 * @param {Function} [opt.cb=null] 輸入每個job完成即時回呼函數cb(r, k)，job失敗時r為undefined
 * @param {Boolean} [opt.returnResult=false] 輸入是否回傳results陣列布林值
 * @returns {Promise} 回傳Promise，opt.returnResult為true時resolve為results陣列，否則為undefined
 * @example
 * need test in nodejs.
 *
 * await parfor(new URL('./sweepSingle_worker.mjs', import.meta.url), jobs, { takeLimit: 4, initData: sc, cb: (r, k) => console.log(k, r) })
 */
async function parfor(fpWorker, jobs, opt = {}) {

    let takeLimit = Number.isInteger(opt.takeLimit) && opt.takeLimit > 0 ? opt.takeLimit : Math.max(os.availableParallelism() - 1, 1)
    let initData = opt.initData
    let cb = typeof opt.cb === 'function' ? opt.cb : null
    let returnResult = opt.returnResult === true

    let n = jobs.length
    if (n === 0) {
        return returnResult ? [] : undefined
    }

    let nw = Math.min(takeLimit, n)
    let results = returnResult ? new Array(n) : null
    let workers = []

    await new Promise((resolve, reject) => {
        let next = 0
        let done = 0
        let settled = false

        let finish = (err) => {
            if (settled) {
                return
            }
            settled = true
            for (let wk of workers) {
                wk.terminate()
            }
            if (err) {
                reject(err)
            }
            else {
                resolve()
            }
        }

        let assign = (wk) => {
            if (settled || next >= n) {
                return
            }
            let k = next++
            try {
                wk.postMessage({ k, job: jobs[k] })
            }
            catch (err) {
                finish(err)
            }
        }

        try {
            for (let i = 0; i < nw; i++) {
                if (settled) {
                    break
                }
                let wk = new Worker(fpWorker, { workerData: initData })
                workers.push(wk)
                wk.on('message', (m) => {
                    if (settled) {
                        return
                    }
                    if (m && typeof m.err === 'string') {
                        console.error(`parfor: job ${m.k} 失敗(不炸批):`, m.err)
                    }
                    else if (results) {
                        results[m.k] = m.r
                    }
                    if (cb) {
                        try {
                            cb(m && typeof m.err === 'string' ? undefined : m.r, m.k)
                        }
                        catch (err) {
                            finish(err)
                            return
                        }
                    }
                    done++
                    if (done >= n) {
                        finish()
                    }
                    else {
                        assign(wk)
                    }
                })
                wk.on('error', (err) => {
                    finish(err)
                })
                wk.on('messageerror', (err) => {
                    finish(err)
                })
                wk.on('exit', (code) => {
                    if (!settled) {
                        finish(new Error(`parfor: worker 非預期退出(code ${code})`))
                    }
                })
                assign(wk)
            }
        }
        catch (err) {
            finish(err)
        }
    })

    await Promise.all(workers.map((wk) => wk.terminate()))

    return returnResult ? results : undefined
}


export default parfor
