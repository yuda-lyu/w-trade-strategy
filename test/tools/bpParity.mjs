import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'


//buildParams 對拍件(unit-buildParams 取用, 下游亦可取用): 對一組合成資料與選項跑 buildParams, 回傳 param/ 整夾與 meta/params.json 與回傳值之雜湊
//  本檔不帶 .test. 中綴, 不會被 mocha 當測試檔抓取; 以參數收函數(normalizeCfg、buildOhlc、buildParams、cfgOf), 使同一流程可套到不同版本之套件
//  meta/params.json 之時間戳 at 以固定字串取代後再取雜湊(其餘須逐位元組相同)


//sha, sha256 十六進位
let sha = (buf) => createHash('sha256').update(buf).digest('hex')


//SCENARIOS, 各案之設定: n 為K線根數, ov 為 cfgOf 之覆寫, runs 為同一工作根依序執行之 buildParams 選項(每次皆記錄雜湊)
let ONLY = ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_dirchange', 'price_ohlc_klr', 'index_ohlc_close', 'index_ohlc_klr', 'price_vbs', 'price_ohlc_mfi']
let SCENARIOS = {
    //4hr: 目錄子集(含 index 側校正)、前段 nm 期間凍結、再跑一次(沿用)、加入新定義(以凍結值自算)、recalibrate
    cat4hr: { n: 500, ov: {}, runs: [{ only: ONLY, nmPeriod: { timeStart: '2023-01-01T00:00:00', timeEnd: '2023-02-15T00:00:00' } }, { only: ONLY }, { only: [...ONLY, 'price_ohlc_cvd'] }, { only: ONLY, recalibrate: true }] },
    //1day: 根數為本
    cat1day: { n: 700, ov: { interval: '1day', intervalSec: 86400, stepMs: 86400 * 1000 }, runs: [{ only: ONLY }, { only: ONLY, nmPeriod: 'all', recalibrate: true }] },
    //定義自帶 nm
    selfNm: { n: 400, ov: {}, runs: [{ only: [], extraDefs: [{ id: 'price_ohlc_fixednm', cointpe: 'price', keyKind: 'ohlc', fields: ['Close'], keysIn: ['Close'], methods: [{ method: 'ma', deals: [{ keyOut: 'param', nm: { avg: 100, std: 10 } }] }] }] }] },
}


//runScenario, 執行一案: fns = { normalizeCfg, buildOhlc, buildParams, cfgOf }, fdTmp 為暫存夾(須存在), extra 為併入每次執行選項之物件(預設空); 回傳各次執行之 { nFiles, manifest(param/ 之檔名與各檔雜湊之雜湊), meta(遮蔽 at 後之 meta/params.json 之雜湊), ret(回傳值去除 meta.at 與新增欄位 nmScope、nmStat 後之雜湊) }
let runScenario = async (fns, fdTmp, id, extra = {}) => {
    let sc = SCENARIOS[id]
    let { cfg } = fns.cfgOf(fdTmp, sc.n, { root: path.resolve(fdTmp, `root_${id}`), ...sc.ov })
    let c = fns.normalizeCfg(cfg)
    await fns.buildOhlc(c)
    let outs = []
    for (let opt of sc.runs) {
        let r = await fns.buildParams(c, { ...opt, ...extra })
        let files = {}
        for (let fn of fs.readdirSync(c.fds.param).sort()) {
            files[fn] = sha(fs.readFileSync(path.resolve(c.fds.param, fn)))
        }
        let metaRaw = fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8').replace(/"at":\s*"[^"]*"/, '"at":"MASK"')
        let { nmScope, nmStat, meta, ...rest } = r
        let metaR = { ...meta }
        delete metaR.at
        outs.push({ nFiles: Object.keys(files).length, manifest: sha(JSON.stringify(files)), meta: sha(metaRaw), ret: sha(JSON.stringify({ ...rest, meta: metaR })) })
    }
    return outs
}


export {
    SCENARIOS,
    sha,
    runScenario
}
