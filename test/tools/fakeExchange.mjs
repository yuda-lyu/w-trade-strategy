import http from 'http'


//假交易所(本機HTTP, 作業系統配發之埠; 供api-fetchBinance與abPipeline共用, 不帶.test.中綴, 不會被mocha抓取)
//  只回STEPS所列之週期(送交易所之週期字串)之根, 只回開盤不晚於「現在」者; 各欄以「第幾根」(開盤 ÷ 每根毫秒)逐根相異(價格欄為8位小數字串, 溢價指數之量欄為0), 對任何週期同式
//  ex.nowCap: 「現在」上限(毫秒, null為Date.now(); 同一案內兩次抓取取得同一批根); ex.skip: (type, 開盤毫秒) => Boolean, 為真者略去(模擬交易所缺漏); ex.reqs: 收到之請求紀錄[{type,interval}]
let STEPS = { '1m': 60 * 1000, '3m': 3 * 60 * 1000, '5m': 5 * 60 * 1000, '15m': 15 * 60 * 1000, '30m': 30 * 60 * 1000, '1h': 3600 * 1000, '2h': 2 * 3600 * 1000, '4h': 4 * 3600 * 1000 }
let E8 = 10n ** 8n


//fmt8, 放大1e8之整數 → 8位小數字串
let fmt8 = (v) => {
    let s = v.toString().padStart(9, '0')
    return `${s.slice(0, -8)}.${s.slice(-8)}`
}


//barOf, 第k根(開盤 = k × 每根毫秒)之各欄(放大1e8之整數; index之量欄為0)
let barOf = (type, k) => {
    let K = BigInt(k)
    let base = type === 'index' ? 1000n * E8 : 3000n * E8
    let o = base + ((K * 7919n) % 200003n) * 1000n
    let c = o + ((K * 104729n) % 4001n) * 1000n - 2000000n
    let h = (o > c ? o : c) + ((K * 31n) % 997n) * 1000n + 1n
    let l = (o < c ? o : c) - ((K * 17n) % 991n) * 1000n - 1n
    let v = type === 'index' ? 0n : ((K % 97n) + 1n) * E8 + (K % 1000n) * 12345n
    let q = type === 'index' ? 0n : v * 3n + (K % 7n)
    let n = type === 'index' ? 0 : Number(K % 50n) + 1
    let tb = type === 'index' ? 0n : v / 2n + (K % 3n)
    let tq = type === 'index' ? 0n : q / 2n + (K % 5n)
    return { o, h, l, c, v, q, n, tb, tq }
}


/**
 * 啟動假交易所
 *
 * @param {Object} [init={}] 初始值{nowCap,skip}
 * @returns {Promise} 回傳Promise，resolve為{ex,epOf,close}；ex為可改之狀態物件{nowCap,skip,reqs}，epOf(type)為端點(本機，不寫位址字面值)，close()關閉伺服器
 */
let createFakeExchange = async (init = {}) => {
    let ex = { nowCap: init.nowCap === undefined ? null : init.nowCap, skip: init.skip === undefined ? null : init.skip, reqs: [] }
    let server = http.createServer((req, res) => {
        let u = new URL(req.url, 'http://localhost')
        let type = u.pathname.split('/')[1]
        let interval = u.searchParams.get('interval')
        ex.reqs.push({ type, interval })
        let step = STEPS[interval]
        if (step === undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ code: -1120, msg: 'Invalid interval.' }))
            return
        }
        let s = Number(u.searchParams.get('startTime'))
        let e = Number(u.searchParams.get('endTime'))
        let now = ex.nowCap !== null ? ex.nowCap : Date.now()
        let rs = []
        for (let o = Math.ceil(s / step) * step; o <= e && o <= now; o += step) {
            if (ex.skip !== null && ex.skip(type, o)) {
                continue
            }
            let b = barOf(type, o / step)
            rs.push([o, fmt8(b.o), fmt8(b.h), fmt8(b.l), fmt8(b.c), fmt8(b.v), o + step - 1, fmt8(b.q), b.n, fmt8(b.tb), fmt8(b.tq), '0'])
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rs))
    })
    await new Promise((resolve) => server.listen(0, resolve)) //作業系統配發之埠(未指定位址: 雙堆疊, localhost 之 IPv4/IPv6 皆可連)
    let port = server.address().port
    let epOf = (type) => `http://localhost:${port}/${type}/klines`
    let close = () => new Promise((resolve) => server.close(resolve))
    return { ex, epOf, close }
}


export { STEPS, fmt8, barOf, createFakeExchange }
export default createFakeExchange
