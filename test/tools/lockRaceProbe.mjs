//鎖檔壓力探測工具(多個子行程同時接手同一殘留鎖, 量「持有者數 ≠ 1」與取得者之staleLock分布; 不帶.test.中綴, 不會被mocha抓取)
//  用法: node test/tools/lockRaceProbe.mjs [次數=20] [子行程數=6]
//  每次: 於test/_tmp/lockRaceProbe/下建立含殘留鎖之fdReport, 以test/tools/lockChild.mjs同時起N個子行程取鎖(各持有3秒); 全部次數結束後印出分布JSON並刪除暫存夾
//  期望: winnersNot1 = 0 且 staleFalse = 0(離開碼0); 單次測試綠不能證互斥, 改取鎖或接手之邏輯後須以本工具重複數十次(經測試鎖執行)
import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

let FD_TEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let FD_PACK = path.resolve(FD_TEST, '..')
let fdRoot = path.resolve(FD_TEST, '_tmp', 'lockRaceProbe')
let n = Number(process.argv[2] || 20)
let k = Number(process.argv[3] || 6)

fs.rmSync(fdRoot, { recursive: true, force: true })
fs.mkdirSync(fdRoot, { recursive: true })
let child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true })
let pidDead = Number(child.stdout)

let race = (fd, holdMs) => {
    let startAt = Date.now() + 2500
    return Promise.all([...Array(k)].map(() => new Promise((resolve) => {
        let cp = spawn(process.execPath, [path.join(FD_TEST, 'tools', 'lockChild.mjs'), fd, String(startAt), String(holdMs)], { cwd: FD_PACK, windowsHide: true })
        let out = ''
        cp.stdout.on('data', (b) => {
            out += b
        })
        cp.on('close', () => {
            resolve(JSON.parse(out.trim().split('\n').pop()))
        })
    })))
}

let dist = { n, k, winnersNot1: 0, staleTrue: 0, staleFalse: 0, notReleased: 0, detail: [] }
for (let i = 0; i < n; i++) {
    let fd = path.join(fdRoot, `r${i}`)
    fs.mkdirSync(fd, { recursive: true })
    fs.writeFileSync(path.join(fd, 'recompute.lock'), JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' }), 'utf8')
    let rs = await race(fd, 3000)
    let w = rs.filter((x) => x.got)
    if (w.length !== 1) {
        dist.winnersNot1++
        dist.detail.push({ i, winners: w.length })
    }
    else {
        dist[w[0].staleLock ? 'staleTrue' : 'staleFalse']++
        if (w[0].released !== true) {
            dist.notReleased++
        }
    }
}
fs.rmSync(fdRoot, { recursive: true, force: true })
console.log(JSON.stringify(dist))
process.exit(dist.winnersNot1 === 0 && dist.staleFalse === 0 && dist.notReleased === 0 ? 0 : 1)
