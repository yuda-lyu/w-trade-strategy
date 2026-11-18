//子行程(測試用): 於指定時刻嘗試取得策略庫重算之鎖, 取得者持有holdMs後釋放; 結果以一行JSON輸出(供多個子行程同時取鎖之測試)
//  node test/tools/lockChild.mjs <fdReport> <startAtMs> <holdMs>
import { acquireRecomputeLock, releaseRecomputeLock } from '../../src/recompute/recomputeLock.mjs'

let [fdReport, startAt, hold] = process.argv.slice(2)
startAt = Number(startAt)
hold = Number(hold)
let sab = new Int32Array(new SharedArrayBuffer(4))

//等到共同之起跑時刻(多個子行程同時取鎖)
while (Date.now() < startAt) {
    Atomics.wait(sab, 0, 0, Math.min(5, Math.max(startAt - Date.now(), 0)))
}
let out = { pid: process.pid }
try {
    let lock = acquireRecomputeLock(fdReport, { mode: 'test' })
    out.got = true
    out.staleLock = lock.staleLock
    Atomics.wait(sab, 0, 0, hold)
    out.released = releaseRecomputeLock(lock)
}
catch (err) {
    out.got = false
    out.err = String(err.message)
}
console.log(JSON.stringify(out))
