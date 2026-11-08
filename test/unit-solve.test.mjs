import assert from 'assert'
import fs from 'fs'
import path from 'path'
import createPipeline from '../src/createPipeline.mjs'
import { EVENT_KEYS, SOLVE_OPT_KEYS } from '../src/solve/solve.mjs'
import { COMPS_ALL, classifyKeys, allowedComps, parseComps, prepareSolve } from '../src/solve/solveRound.mjs'
import { isKeyCloseOnly, filterKeysCloseOnly, compsCloseOnly } from '../src/params/keysCloseOnly.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: src/solve/*.mjs、src/params/keysCloseOnly.mjs
//  prepareSolve: 依因子分類數過濾18種組成; 無可用組成即throw; closeOnly套用close-only過濾
//  solve/createSolver: 每輪一次estimFinder; 事件onReady/onRound/onCandidate/onProgress; 停止條件maxRounds/maxStrategies/maxTimeMs/shouldStop/stop()
//  workers>0: worker_threads平行, opt不可含非事件之函數
//  策略庫檔為w-trade-solve estimKeys格式(含tkid/solve區塊)
//  gate(opt.gate, 每輪起跑前之資源閘): 每輪(含workers>0各worker之第1輪)起跑前由主程序await後才放行; 閘後再查停止條件, 成立即不放行;
//    閘拋錯記入errors並觸發onError、照常放行; 起跑前(含workers>0)已達停止條件即不起跑;
//    閘等待期間停止條件成立時, 正在等放行之worker必須收到stop並結束(start()必結算)


let fdTmp = buildFdTmp('solve')
let n = 500
let pl = null

//gate測試輔助: 同步點為事件與呼叫序列, 不以固定延時判定先後
//  T_GUARD為防懸置上限(只防卡死、不表達規格; 逾時即判紅, 並先要求求解器停止以免殘留worker)
let T_GUARD = 40000

//defer, 可由測試放行之promise(閘內等待用)
let defer = () => {
    let resolve = null
    let promise = new Promise((_resolve) => {
        resolve = _resolve
    })
    return { promise, resolve }
}

//sleep, 只用於閘內製造「閘等待中」之狀態, 不作為斷言之同步點
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

//guardP, 為promise加防懸置上限: 逾時先執行onTimeout(如sv.stop())再reject
let guardP = (p, label, onTimeout) => new Promise((resolve, reject) => {
    let t = setTimeout(() => {
        try {
            if (onTimeout) {
                onTimeout()
            }
        }
        catch (err) {}
        reject(new Error(`懸置: ${label}(逾${T_GUARD}ms)`))
    }, T_GUARD)
    p.then((v) => {
        clearTimeout(t)
        resolve(v)
    }, (e) => {
        clearTimeout(t)
        reject(e)
    })
})

//makeRec, 事件紀錄器: add(type, data)依序記入log; waitCount(type, n)於該type累計n筆時解除(事件同步點)
let makeRec = () => {
    let log = []
    let waiters = []
    let count = (type) => log.filter((x) => x.type === type).length
    let add = (type, data = {}) => {
        log.push({ type, ...data })
        waiters = waiters.filter((w) => {
            if (count(w.type) >= w.n) {
                w.resolve()
                return false
            }
            return true
        })
    }
    let waitCount = (type, n, label, onTimeout) => {
        let p = new Promise((resolve) => {
            if (count(type) >= n) {
                resolve()
            }
            else {
                waiters.push({ type, n, resolve })
            }
        })
        return guardP(p, label, onTimeout)
    }
    return { log, add, count, waitCount }
}

//evOpt, 把onReady/onRound/onCandidate記入紀錄器
let evOpt = (rec) => ({
    onReady: (ev) => rec.add('ready', { workerId: ev.workerId }),
    onRound: (ev) => rec.add('round', { workerId: ev.workerId, nRounds: ev.nRounds }),
    onCandidate: (ev) => rec.add('candidate', { workerId: ev.workerId }),
})

//seqOf, 紀錄器中指定worker之gate/gateEnd/round序列(字串，各項後接逗號)
let seqOf = (rec, workerId) => rec.log.filter((x) => x.workerId === workerId && ['gate', 'gateEnd', 'round'].includes(x.type)).map((x) => `${x.type},`).join('')

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

    describe('gate', function() {

        let lib = (name) => path.resolve(fdTmp, name)

        it('常數: EVENT_KEYS與SOLVE_OPT_KEYS含gate, 建立求解器不拒收', function() {
            assert.ok(EVENT_KEYS.includes('gate'))
            assert.ok(SOLVE_OPT_KEYS.includes('gate'))
            assert.doesNotThrow(() => pl.createSolver({ ...quick, workers: 2, gate: () => {} }))
        })

        it('in-process: 每輪(含第1輪)起跑前經閘一次, 閘結束後輪次才動作; 達maxRounds後不再過閘', async function() {
            this.timeout(300000)
            let rec = makeRec()
            let r = await pl.solve({
                ...quick,
                fdStrategies: lib('g_seq'),
                maxRounds: 2,
                //每輪estimFinder挑因子時呼叫(準備期亦呼叫一次): 作為「輪次已起跑」之事件訊號
                funFilterKeysNorm: (ks) => {
                    rec.add('probe')
                    return ks
                },
                ...evOpt(rec),
                gate: async (ev) => {
                    rec.add('gate', { workerId: ev.workerId, nRounds: ev.nRounds, st: ev.state })
                    await sleep(120) //製造「閘等待中」之狀態
                    rec.add('gateEnd', { workerId: ev.workerId })
                },
            })
            assert.strictEqual(r.state, 'done')
            assert.strictEqual(r.stopReason, 'maxRounds')
            assert.strictEqual(r.nRounds, 2)
            //閘參數為{workerId, ...status}: 首輪前nRounds 0, 其後每輪結束一次; 閘共2次(達maxRounds後不再過閘)
            let gates = rec.log.filter((x) => x.type === 'gate')
            assert.deepStrictEqual(gates.map((x) => [x.workerId, x.nRounds, x.st]), [[0, 0, 'running'], [0, 1, 'running']])
            //每輪: gate → gateEnd → (輪次動作: probe至少一次, candidate) → round; 閘結束前無任何輪次動作, 閘結束後才起該輪
            let iReady = rec.log.findIndex((x) => x.type === 'ready')
            assert.ok(iReady >= 0)
            let seq = rec.log.slice(iReady + 1).map((x) => `${x.type},`).join('')
            assert.ok(/^(gate,gateEnd,probe,((probe|candidate),)*round,){2}$/.test(seq), seq)
        })

        it('in-process: 閘內stop()或shouldStop成立 ⇒ 閘後不放行(0輪)', async function() {
            this.timeout(300000)
            for (let how of ['stop()', 'shouldStop']) {
                let rec = makeRec()
                let flag = false
                let sv = null
                sv = pl.createSolver({
                    ...quick,
                    fdStrategies: lib(`g_stop_${how.replace(/\W/g, '')}`),
                    //in-process之求解迴圈只讓出微任務, 計時器(防懸置上限、mocha逾時)不會觸發, 故以maxRounds兜底(非被測條件: 閘有效時為0輪)
                    maxRounds: 2,
                    funFilterKeysNorm: (ks) => {
                        rec.add('probe')
                        return ks
                    },
                    shouldStop: () => flag,
                    ...evOpt(rec),
                    gate: () => {
                        rec.add('gate')
                        if (how === 'stop()') {
                            sv.stop()
                        }
                        else {
                            flag = true
                        }
                    },
                })
                let r = await guardP(sv.start(), `${how}: start()未結算`, () => sv.stop())
                assert.strictEqual(r.state, 'done', how)
                assert.strictEqual(r.stopReason, how, how)
                assert.strictEqual(r.nRounds, 0, how)
                assert.strictEqual(rec.count('gate'), 1, how)
                let iReady = rec.log.findIndex((x) => x.type === 'ready')
                assert.deepStrictEqual(rec.log.slice(iReady + 1).map((x) => x.type), ['gate'], how) //閘之後無任何輪次動作
            }
        })

        it('gate拋錯: 記入errors並觸發onError, 照常放行; onError拋錯亦不致卡住(workers 0與2)', async function() {
            this.timeout(300000)
            //workers 0, 同步拋錯
            let errs = []
            let r = await pl.solve({
                ...quick,
                fdStrategies: lib('g_err0'),
                maxRounds: 1,
                gate: () => {
                    throw new Error('gate boom')
                },
                onError: (e) => errs.push(e),
            })
            assert.strictEqual(r.stopReason, 'maxRounds')
            assert.strictEqual(r.nRounds, 1)
            assert.strictEqual(r.errors.length, 1)
            assert.ok(/gate boom/.test(r.errors[0]))
            assert.strictEqual(errs.length, 1)
            assert.strictEqual(errs[0].message, 'gate boom')
            //workers 0, 非同步rejection, 且onError本身拋錯
            let nOnError = 0
            let r2 = await pl.solve({
                ...quick,
                fdStrategies: lib('g_err0b'),
                maxRounds: 1,
                gate: async () => {
                    throw new Error('gate boom 2')
                },
                onError: () => {
                    nOnError++
                    throw new Error('onError boom')
                },
            })
            assert.strictEqual(r2.stopReason, 'maxRounds')
            assert.strictEqual(r2.nRounds, 1)
            assert.strictEqual(r2.errors.length, 1)
            assert.strictEqual(nOnError, 1)
            //workers 2: 每個過閘之worker各記一筆(停止後不再過閘, 故1~2筆), 皆放行
            let errs3 = []
            let r3 = await pl.solve({
                ...quick,
                fdStrategies: lib('g_err2'),
                workers: 2,
                maxRounds: 1,
                closeOnly: true,
                gate: async () => {
                    throw new Error('gate boom 3')
                },
                onError: (e) => errs3.push(e),
            })
            assert.strictEqual(r3.state, 'done')
            assert.strictEqual(r3.stopReason, 'maxRounds')
            assert.ok(r3.nRounds >= 1 && r3.nRounds <= 2, `nRounds ${r3.nRounds}`)
            assert.ok(r3.errors.length >= 1 && r3.errors.length <= 2, `errors ${r3.errors.length}`)
            assert.ok(r3.errors.every((x) => /gate boom 3/.test(x)))
            assert.strictEqual(errs3.length, r3.errors.length)
        })

        it('workers 2: 首輪前即經閘, 閘內stop() ⇒ 0輪, 且停止後不再過閘', async function() {
            this.timeout(300000)
            let rec = makeRec()
            let sv = null
            sv = pl.createSolver({
                ...quick,
                fdStrategies: lib('g_w2stop'),
                workers: 2,
                closeOnly: true,
                ...evOpt(rec),
                gate: (ev) => {
                    rec.add('gate', { workerId: ev.workerId, nRounds: ev.nRounds })
                    sv.stop()
                },
            })
            let r = await guardP(sv.start(), 'start()未結算', () => sv.stop())
            assert.strictEqual(r.state, 'done')
            assert.strictEqual(r.stopReason, 'stop()')
            assert.strictEqual(r.nRounds, 0)
            assert.strictEqual(rec.count('round'), 0)
            assert.strictEqual(rec.count('candidate'), 0)
            //第一個過閘者於閘內同步呼叫stop(), 另一worker之ready到達時已要求停止, 不再過閘
            assert.strictEqual(rec.count('gate'), 1)
            assert.strictEqual(rec.log.find((x) => x.type === 'gate').nRounds, 0)
            assert.deepStrictEqual(r.errors, [])
        })

        it('workers 2 + maxRounds 2: 每worker之閘與輪次嚴格交替且以閘起頭, 閘次數有界', async function() {
            this.timeout(300000)
            let rec = makeRec()
            let r = await pl.solve({
                ...quick,
                fdStrategies: lib('g_w2rounds'),
                workers: 2,
                maxRounds: 2,
                closeOnly: true,
                ...evOpt(rec),
                gate: async (ev) => {
                    rec.add('gate', { workerId: ev.workerId, nRounds: ev.nRounds })
                    await sleep(30) //製造「閘等待中」之狀態
                    rec.add('gateEnd', { workerId: ev.workerId })
                },
            })
            assert.strictEqual(r.state, 'done')
            assert.strictEqual(r.stopReason, 'maxRounds')
            assert.ok(r.nRounds >= 2 && r.nRounds <= 3, `nRounds ${r.nRounds}`)
            //每個worker: (gate, gateEnd, round)* 後可接一個進行中或被拒之 gate[, gateEnd]; 輪次必在自己之閘結束後
            for (let w of [0, 1]) {
                let seq = seqOf(rec, w)
                assert.ok(/^(gate,gateEnd,round,)*(gate,(gateEnd,)?)?$/.test(seq), `worker ${w}: ${seq}`)
            }
            //閘次數: 至少1次, 至多每worker之ready一次加每個已處理輪次一次
            assert.ok(rec.count('gate') >= 1 && rec.count('gate') <= 2 + r.nRounds, `gate ${rec.count('gate')} rounds ${r.nRounds}`)
            assert.strictEqual(rec.count('round'), r.nRounds)
            assert.deepStrictEqual(r.errors, [])
        })

        it('workers 1 + maxRoundsPerWorker 1: 末輪後worker不再起跑, 故不再過閘', async function() {
            this.timeout(300000)
            let rec = makeRec()
            let r = await pl.solve({
                ...quick,
                fdStrategies: lib('g_cap'),
                workers: 1,
                maxRoundsPerWorker: 1,
                closeOnly: true,
                ...evOpt(rec),
                gate: (ev) => {
                    rec.add('gate', { workerId: ev.workerId, nRounds: ev.nRounds })
                },
            })
            assert.strictEqual(r.state, 'done')
            assert.strictEqual(r.stopReason, null)
            assert.strictEqual(r.nRounds, 1)
            assert.strictEqual(rec.log.filter((x) => ['gate', 'round'].includes(x.type)).map((x) => x.type).join(','), 'gate,round')
        })

        it('workers 2: 起跑前已達停止條件(maxStrategies、shouldStop、stop())⇒ 不起worker, 0輪', async function() {
            this.timeout(300000)
            let fd = lib('g_pre')
            //種一檔: in-process跑到策略庫達1檔
            let seed = await pl.solve({ ...quick, fdStrategies: fd, maxStrategies: 1 })
            assert.ok(seed.nStrategies >= 1)
            let recOf = () => {
                let rec = makeRec()
                return { rec, o: { ...quick, fdStrategies: fd, workers: 2, closeOnly: true, ...evOpt(rec), gate: () => rec.add('gate') } }
            }
            //maxStrategies
            let a = recOf()
            let r = await pl.solve({ ...a.o, maxStrategies: 1 })
            assert.strictEqual(r.state, 'done')
            assert.strictEqual(r.stopReason, 'maxStrategies')
            assert.strictEqual(r.nRounds, 0)
            assert.strictEqual(a.rec.log.length, 0, '不起worker: 無ready、無閘、無輪次')
            //shouldStop
            let b = recOf()
            let r2 = await pl.solve({ ...b.o, shouldStop: () => true })
            assert.strictEqual(r2.stopReason, 'shouldStop')
            assert.strictEqual(r2.nRounds, 0)
            assert.strictEqual(b.rec.log.length, 0)
            //stop()後才start()
            let c = recOf()
            let sv = pl.createSolver(c.o)
            sv.stop()
            let r3 = await guardP(sv.start(), 'stop()後start()未結算', () => sv.stop())
            assert.strictEqual(r3.state, 'done')
            assert.strictEqual(r3.stopReason, 'stop()')
            assert.strictEqual(r3.nRounds, 0)
            assert.strictEqual(c.rec.log.length, 0)
        })

        it('不懸置: workers 2 兩個worker皆在閘內等待時stop() ⇒ start()結算, 無任何輪次', async function() {
            this.timeout(300000)
            let rec = makeRec()
            let hold = defer()
            let sv = pl.createSolver({
                ...quick,
                fdStrategies: lib('g_hold_stop'),
                workers: 2,
                closeOnly: true,
                ...evOpt(rec),
                gate: async (ev) => {
                    rec.add('gate', { workerId: ev.workerId })
                    await hold.promise
                },
            })
            let p = sv.start()
            try {
                await rec.waitCount('gate', 2, '兩worker皆進閘', () => sv.stop()) //事件同步: 兩個worker皆已在閘內等待
                sv.stop()
                let r = await guardP(p, '兩worker在閘內時stop()後start()未結算', () => sv.stop())
                assert.strictEqual(r.state, 'done') //start()結算＝兩個worker皆已結束(alive計數歸零)
                assert.strictEqual(r.stopReason, 'stop()')
                assert.strictEqual(r.nRounds, 0)
                assert.strictEqual(rec.count('round'), 0)
                assert.strictEqual(rec.count('candidate'), 0)
            }
            finally {
                hold.resolve() //放行殘留之閘promise
            }
        })

        it('不懸置: 一個worker之閘放行後停止條件成立(shouldStop、maxTimeMs)⇒ 另一仍在閘內之worker亦收stop', async function() {
            this.timeout(300000)
            for (let how of ['shouldStop', 'maxTimeMs']) {
                let rec = makeRec()
                let holdB = defer()
                let flag = false
                let opt = how === 'shouldStop' ? { shouldStop: () => flag } : { maxTimeMs: 200 }
                let sv = pl.createSolver({
                    ...quick,
                    fdStrategies: lib(`g_hold_${how}`),
                    workers: 2,
                    closeOnly: true,
                    ...opt,
                    ...evOpt(rec),
                    gate: async (ev) => {
                        rec.add('gate', { workerId: ev.workerId })
                        if (ev.workerId === 1) {
                            await holdB.promise //worker 1之閘不放行, 只能靠stop結束
                            return
                        }
                        //worker 0: 待兩閘皆進入後才放行; 停止條件於閘內成立(shouldStop為旗標, maxTimeMs為閘內等待超過總時限)
                        await rec.waitCount('gate', 2, '兩worker皆進閘', () => sv.stop())
                        if (how === 'shouldStop') {
                            flag = true
                        }
                        else {
                            await sleep(400)
                        }
                    },
                })
                try {
                    let r = await guardP(sv.start(), `${how}: 一閘放行後start()未結算(另一worker仍在閘內)`, () => sv.stop())
                    assert.strictEqual(r.state, 'done', how)
                    assert.strictEqual(r.stopReason, how, how)
                    assert.strictEqual(r.nRounds, 0, how)
                    assert.strictEqual(rec.count('round'), 0, how)
                    assert.strictEqual(rec.count('gate'), 2, how)
                }
                finally {
                    holdB.resolve()
                }
            }
        })

        it('不懸置: 他worker之輪次使maxStrategies成立 ⇒ 仍在閘內之worker收stop, 且從未起跑', async function() {
            this.timeout(300000)
            let rec = makeRec()
            let holdB = defer()
            let sv = pl.createSolver({
                ...quick,
                fdStrategies: lib('g_hold_max'),
                workers: 2,
                closeOnly: true,
                maxStrategies: 1,
                ...evOpt(rec),
                gate: async (ev) => {
                    rec.add('gate', { workerId: ev.workerId })
                    if (ev.workerId === 1) {
                        await holdB.promise //worker 1之閘不放行
                    }
                    else if (ev.nRounds === 0) {
                        await rec.waitCount('gate', 2, '兩worker皆進閘', () => sv.stop()) //worker 0待worker 1確已在閘內才起第1輪
                    }
                },
            })
            try {
                let r = await guardP(sv.start(), 'worker 1仍在閘內時start()未結算', () => sv.stop())
                assert.strictEqual(r.state, 'done')
                assert.strictEqual(r.stopReason, 'maxStrategies')
                assert.ok(r.nRounds >= 1)
                assert.ok(r.nStrategies >= 1)
                //worker 1之閘從未放行 ⇒ 從未起跑任何一輪(start()結算時兩worker皆已結束, 若越過閘則其輪次必已回報)
                assert.strictEqual(rec.log.filter((x) => x.type === 'round' && x.workerId === 1).length, 0)
                assert.strictEqual(rec.log.filter((x) => x.type === 'gate' && x.workerId === 1).length, 1)
                assert.ok(rec.log.filter((x) => x.type === 'round' && x.workerId === 0).length >= 1)
            }
            finally {
                holdB.resolve()
            }
        })

    })

})
