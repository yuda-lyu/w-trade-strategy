import assert from 'assert'
import fs from 'fs'
import path from 'path'
import createPipeline from '../src/createPipeline.mjs'
import { COMPS_ALL, classifyKeys, allowedComps, parseComps, prepareSolve } from '../src/solve/solveRound.mjs'
import { isKeyCloseOnly, filterKeysCloseOnly, compsCloseOnly } from '../src/params/keysCloseOnly.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: src/solve/*.mjs、src/params/keysCloseOnly.mjs
//  prepareSolve: 依因子分類數過濾18種組成; 無可用組成即throw; closeOnly套用close-only過濾
//  solve/createSolver: 每輪一次estimFinder; 事件onReady/onRound/onCandidate/onProgress; 停止條件maxRounds/maxStrategies/maxTimeMs/shouldStop/stop()
//  workers>0: worker_threads平行, opt不可含非事件之函數
//  策略庫檔為w-trade-solve estimKeys格式(含tkid/solve區塊)


let fdTmp = buildFdTmp('solve')
let n = 500
let pl = null

//快速求解設定(合成數據下門檻放寬, 使每輪必有存檔)
let quick = {
    thNumTrade: 1,
    thRWin: 0,
    thEqYr: -1e9,
    thsTp: [3, 5],
    thsSl: [3, 5],
    oml: { Np: 6, NContiguous: 3, Ng: 15 },
}


describe('solve', function() {

    before(async function() {
        this.timeout(180000)
        let { cfg } = cfgOf(fdTmp, n)
        pl = createPipeline(cfg)
        await pl.buildOhlc()
        await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_adx', 'index_ohlc_close', 'price_vbs'] })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('keysCloseOnly規則與comps解析', function() {
        assert.strictEqual(isKeyCloseOnly('price_ohlc_Close_param_maNorm_1day'), true)
        assert.strictEqual(isKeyCloseOnly('price_ohlc_none_RSI_rsi_1day'), true)
        assert.strictEqual(isKeyCloseOnly('price_ohlc_none_ADX_adx_1day'), false)
        assert.strictEqual(isKeyCloseOnly('price_vbs_volumn_param_maNorm_1day'), false)
        assert.strictEqual(isKeyCloseOnly('index_ohlc_Close_param_ema_1day'), true)
        assert.strictEqual(isKeyCloseOnly('weird_key'), false)
        assert.deepStrictEqual(filterKeysCloseOnly(['price_ohlc_none_RSI_rsi_1day', 'price_ohlc_none_ADX_adx_1day']), ['price_ohlc_none_RSI_rsi_1day'])
        assert.strictEqual(compsCloseOnly.length, 9)
        assert.strictEqual(COMPS_ALL.length, 18)
        assert.deepStrictEqual(parseComps('2,1,0'), [2, 1, 0])
        assert.throws(() => parseComps('2,1'), /invalid comps/)
        let cls = classifyKeys(['index_a', 'price_vbs_x', 'price_ohlc_y'])
        assert.deepStrictEqual(cls, { keysNorm: ['price_ohlc_y'], keysIndex: ['index_a'], keysVolumn: ['price_vbs_x'] })
        assert.deepStrictEqual(allowedComps({ norm: 3, index: 0, volumn: 0 }, COMPS_ALL), ['2,0,0', '3,0,0'])
        assert.deepStrictEqual(allowedComps({ norm: 9, index: 1, volumn: 0 }, COMPS_ALL), ['2,0,0', '3,0,0', '4,0,0', '2,1,0', '3,1,0', '4,1,0'])
    })

    it('prepareSolve: 分類數、組成過濾、closeOnly; 無train即throw', async function() {
        let p = await prepareSolve(pl.cfg, {})
        assert.ok(p.counts.norm > 0 && p.counts.index > 0 && p.counts.volumn > 0, JSON.stringify(p.counts))
        assert.strictEqual(p.comps.length, 18)
        assert.strictEqual(p.engine, 'fast')
        let p2 = await prepareSolve(pl.cfg, { closeOnly: true, engine: 'full' })
        assert.strictEqual(p2.counts.volumn, 0)
        assert.ok(p2.comps.every((c) => c.endsWith(',0')))
        assert.strictEqual(p2.engine, 'full')
        let p3 = await prepareSolve(pl.cfg, { comps: ['2,0,0', '2,50,0'] })
        assert.deepStrictEqual(p3.comps, ['2,0,0'])
        await assert.rejects(prepareSolve(pl.cfg, { comps: '2,999,0' }), /無可用之指標組成/)
        await assert.rejects(prepareSolve({ ...pl.cfg, train: null }, {}), /cfg.train/)
    })

    it('in-process: maxRounds 2, 事件齊備, 策略庫有檔且格式為estimKeys', async function() {
        this.timeout(300000)
        let evs = { ready: [], round: [], cand: [], prog: [] }
        let r = await pl.solve({
            ...quick,
            maxRounds: 2,
            onReady: (ev) => evs.ready.push(ev),
            onRound: (ev) => evs.round.push(ev),
            onCandidate: (ev) => evs.cand.push(ev),
            onProgress: (ev) => evs.prog.push(ev),
        })
        assert.strictEqual(r.state, 'done')
        assert.strictEqual(r.stopReason, 'maxRounds')
        assert.strictEqual(r.nRounds, 2)
        assert.strictEqual(evs.ready.length, 1)
        assert.strictEqual(evs.round.length, 2)
        assert.strictEqual(evs.prog.length, 2)
        assert.ok(evs.cand.length > 0)
        assert.strictEqual(r.nCandidates, evs.cand.length)
        assert.ok(r.nStrategies > 0)
        assert.strictEqual(r.nNew, r.nStrategies)
        assert.ok(['long', 'short'].includes(evs.round[0].mode))
        assert.ok(COMPS_ALL.includes(evs.round[0].comps))
        assert.ok(Array.isArray(evs.cand[0].keys) && evs.cand[0].summary && evs.cand[0].settings)
        assert.strictEqual(pl.countStrategies(), r.nStrategies)
        let ss = pl.readStrategies(null, { readContent: true })
        let s = ss[0].data
        assert.ok(s.tkid && s.tid && s.sid)
        assert.strictEqual(s.name, 'TST')
        assert.strictEqual(s.solve.timeStart, pl.cfg.train.timeStart)
        assert.strictEqual(s.solve.timeEnd, pl.cfg.train.timeEnd)
        assert.strictEqual(s.solve.methodOml, 'RGA')
        assert.ok(s.summary.rSharpe !== undefined, '存檔前官方重跑, summary應為完整欄位')
    })

    it('maxStrategies與shouldStop停止; mode固定; timeEndByMode', async function() {
        this.timeout(300000)
        let fdStrategies = path.resolve(fdTmp, 'lib2')
        let cfg2 = { ...pl.cfg, train: { ...pl.cfg.train, timeEndByMode: { long: '2023-03-01T00:00:00' } } }
        let pl2 = createPipeline({ ...cfg2, fds: { ...pl.cfg.fds } })
        let r = await pl2.solve({ ...quick, fdStrategies, maxStrategies: 1, mode: 'long' })
        assert.strictEqual(r.stopReason, 'maxStrategies')
        assert.ok(r.nStrategies >= 1)
        let ss = pl2.readStrategies(fdStrategies, { readContent: true })
        assert.ok(ss.every((x) => x.data.mode === 'long'))
        assert.strictEqual(ss[0].data.solve.timeEnd, '2023-03-01T00:00:00')
        let r2 = await pl2.solve({ ...quick, fdStrategies, shouldStop: (st) => st.nRounds >= 1 })
        assert.strictEqual(r2.stopReason, 'shouldStop')
        assert.strictEqual(r2.nRounds, 1)
        let r3 = await pl2.solve({ ...quick, fdStrategies, maxTimeMs: 1 })
        assert.strictEqual(r3.stopReason, 'maxTimeMs')
        assert.ok(r3.nRounds <= 1, `nRounds ${r3.nRounds}`) //準備完成即已逾時時第1輪不起跑(準備快於1ms時跑1輪即停)
        let r4 = await pl2.solve({ ...quick, fdStrategies, maxStrategies: 1 })
        assert.strictEqual(r4.stopReason, 'maxStrategies')
        assert.strictEqual(r4.nRounds, 0) //策略庫已達上限, 不起跑
    })

    it('workers 2: maxRounds 2後各worker於當輪結束停止, 執行緒收尾; 函數選項被拒; stop()可中止', async function() {
        this.timeout(300000)
        let fdStrategies = path.resolve(fdTmp, 'lib3')
        let ready = []
        let r = await pl.solve({ ...quick, fdStrategies, workers: 2, maxRounds: 2, closeOnly: true, onReady: (ev) => ready.push(ev) })
        assert.strictEqual(r.state, 'done')
        assert.strictEqual(r.stopReason, 'maxRounds')
        assert.ok(r.nRounds >= 2 && r.nRounds <= 3, `nRounds ${r.nRounds}`) //達maxRounds時另一worker至多再完成當輪(每輪結束等主程序放行才起下一輪)
        assert.strictEqual(ready.length, 2)
        assert.deepStrictEqual(ready.map((x) => x.workerId).sort(), [0, 1])
        assert.strictEqual(ready[0].counts.volumn, 0)
        assert.ok(r.nStrategies > 0)
        assert.deepStrictEqual(r.errors, [])
        //函數選項
        await assert.rejects(pl.solve({ ...quick, fdStrategies, workers: 1, maxRounds: 1, funFilterKeysNorm: (ks) => ks }), /不可為函數/)
        //不認得之鍵
        assert.throws(() => pl.createSolver({ ...quick, maxRound: 1 }), /不認得之鍵\[maxRound\]/)
        //stop()
        let sv = pl.createSolver({ ...quick, fdStrategies, workers: 2, closeOnly: true })
        setTimeout(() => sv.stop(), 500)
        let r2 = await sv.start()
        assert.strictEqual(r2.state, 'done')
        assert.strictEqual(r2.stopReason, 'stop()')
        await assert.rejects(sv.start(), /已啟動/)
    })

    it('createPipeline.status彙整各階段', function() {
        let st = pl.status()
        assert.strictEqual(st.cfg.name, 'TST')
        assert.strictEqual(st.ohlc.nPrice, n)
        assert.ok(st.params.nKeys > 0)
        assert.ok(st.strategies.solve > 0)
    })

})
