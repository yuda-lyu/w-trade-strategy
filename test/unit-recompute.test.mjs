import assert from 'assert'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import dataProvide from 'w-data-tdprovide/src/WDataTdprovide.mjs'
import runStrategy from 'w-trade-backtest/src/runStrategy.mjs'
import calcFitness from 'w-trade-solve/src/calcFitness.mjs'
import p2r from 'w-trade-solve/src/p2r.mjs'
import normalizeCfg, { normalizeUnit } from '../src/cfg.mjs'
import createPipeline from '../src/createPipeline.mjs'
import recomputeStrategies, { quantilesOf } from '../src/recompute/recomputeStrategies.mjs'
import createCore, { diffSummary, checkInvariant } from '../src/recompute/recomputeStrategies_core.mjs'
import parfor from '../src/util/parfor.mjs'
import { canonOf, idOf, relationOf } from '../src/recompute/pathRelation.mjs'
import { acquireRecomputeLock, releaseRecomputeLock } from '../src/recompute/recomputeLock.mjs'
import { makeOtt } from '../src/util/ott.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: src/recompute/recomputeStrategies.mjs 與 recomputeStrategies_core.mjs 之 JSDoc(策略庫重算: 不重新求解, 依基礎單位重算摘要)
//  C1 忠實重放: 以檔內settings於其求解時間窗重跑官方runStrategy, 摘要須與檔內逐欄相同(timeTest除外), 不同即mismatch並列欄名; 只有通過者才以新口徑重算; 檔內fitness與現行calcFitness不同者記fitnessStale(不擋), 重算時以現行calcFitness重寫
//  C2 verify只驗證、dry重算但不寫檔、write寫至明給之fdOut; write未給fdOut即throw; dry/write須有目標unit; takeLimit須為正整數(預設2); limit須為非負整數; files給予時須為非空之檔名字串陣列; write不可關閉stopOnError; thEqYr須為有限之數字
//  C3 新口徑: settings之uIni換為目標、unit設為目標(其餘欄與鍵序不變, unit接於末), summary為新settings之重放, fitness為calcFitness(新settings,新summary), 其餘欄與鍵序不變; 檔名與檔數不變; 輸出格式同原檔
//  C4 交易筆數、已平倉筆數、勝率與檔名須不變(checkInvariant; 否則r8)
//  C5 write遇任一不合格(mismatch、r8、unsupported、error)即中止(不再寫檔)並列出, verify與dry預設跑完並列出全部
//  C6 可中斷續跑: journal首行header記模式、資料夾、目標口徑、數據夾、時區、門檻與三個套件之版本(續跑時須相同, 否則throw); 各列另記來源檔之位元組數與修改時刻; 續跑時已為ok或already且來源未變者略過, write另核對輸出檔之位元組數與雜湊(不符即重做); 末行半截者丟棄; 檔內settings已等於目標者(settings.uIni與settings.unit之數字字串與同值之數字視為相同)為already(逐位複製); write之ok須namesSame為true(輸出夾之檔皆屬journal已記為寫出者、且涵蓋本次所選; 全庫時檔數等於fdIn)
//  C7 統計: 前後等效年化之分布(同一母體: 重算成功者)、跨過入庫門檻之隻數與清單(檔內solve之門檻; 無則opt.thEqYr並計nThFallback; 皆無則列noThreshold、不計入跨門檻)、不同之欄、最大持倉名義之分布
//  C8 非求解所落地之策略檔(無solve時間窗)為unsupported; 壞檔為error; 檔內settings.uIni為無效值者(忠實重放被回測套件拒絕)亦為error, 不中斷整批(訊息V19格式、不含輸入值V20)
//  C9 單一策略之最大持倉名義不設門檻: 超過目標uIni者照常重算寫出, 只統計其隻數、最大者與最大單位數並列清單(不處置)
//  C10 寫出之安全: 不提供原地寫回; fdOut與fdIn同夾(含大小寫、目錄連結之別名)或互為上下層即拒; fdReport不得等於或位於fdIn、fdOut之內(各模式); 建立fdOut之後再核一次; 首次執行時fdOut須不存在或不含*.json; 前次中斷所遺之暫存檔於開始時清除; 每一個寫出案(含續跑、中止與被拒者)之原策略庫逐位不變
//  C10(判定法) pathRelation: 正規路徑(realpathSync.native, win32不分大小寫)與目錄本體(dev+ino, 含上層)兩法各自可判定別名; 檔案識別為0者不以識別比對; 實體路徑取不到即throw
//  C11 鎖檔: 原子建立(內容先寫暫存檔再link); 鎖檔之行程仍在即拒; 內容無法讀出而修改時刻很新者視為使用中; 其餘殘留者以改名接手(多行程同時接手只一個成功; 取走者非所判定之殘留鎖即放回並拒); 結束後(含例外)只釋放自己之鎖
//  C12 例外中止: 已開始處理者寫部分報告(crashed)後再拋出
//  C13 檔名與檔內交易次數級距不一致之舊檔記nameMismatch(只列, 不擋; 輸出沿用原檔名); onProgress拋錯只計數不中斷


let fdTmp = buildFdTmp('recompute')
let n = 500
let links = [] //本檔所建之目錄連結(after先拆再刪暫存夾)

//ruleR, 交易規則之例(步長0.1、最小數量0.1、最小名義價值5): 合成價格約60~140時每單1格, 名義隨進場價大幅變動(使新舊等效年化有別)
let ruleR = { stepSize: 0.1, minQty: 0.1, minNotional: 5, asOf: '2026-01-01T00:00:00', source: 'exchangeInfo' }
let unitR = { rule: ruleR, buffer: 0.1, units: 1 }

let quick = { thNumTrade: 1, thRWin: 0, thEqYr: -1e9, thsTp: [3, 5], thsSl: [3, 5], oml: { Np: 6, NContiguous: 3, Ng: 15 } }

let base = null //未給unit之cfg
let cfgU = null //目標口徑之cfg(uIni 10000、unitR)
let fdLib = null //以求解建立之策略庫(未給unit)
let fns = null

let listJson = (fd) => fs.readdirSync(fd).filter((f) => f.endsWith('.json')).sort()
let readJ = (fd, fn) => JSON.parse(fs.readFileSync(path.resolve(fd, fn), 'utf8'))
let sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
//snapshot, 資料夾第1層之全部項目與各檔之雜湊(子夾記為<dir>)
let snapshot = (fd) => Object.fromEntries(fs.readdirSync(fd).sort().map((f) => {
    let fp = path.resolve(fd, f)
    return [f, fs.lstatSync(fp).isFile() ? sha(fs.readFileSync(fp)) : '<dir>']
}))
let copyLib = (to) => {
    fs.mkdirSync(to, { recursive: true })
    for (let f of listJson(fdLib)) {
        fs.copyFileSync(path.resolve(fdLib, f), path.resolve(to, f))
    }
    return to
}
let noTimeTest = (sm) => {
    let { timeTest, ...rest } = sm
    return rest
}
let maskTime = (o) => ({ ...o, summary: noTimeTest(o.summary) })
let lstatOrNull = (fp) => {
    try {
        return fs.lstatSync(fp)
    }
    catch (err) {
        return null
    }
}
//removeLink, 拆目錄連結(不動其目標)並回驗已不存在
let removeLink = (link) => {
    let st = lstatOrNull(link)
    if (st === null) {
        return
    }
    if (!st.isSymbolicLink()) {
        throw new Error(`[${link}]不是目錄連結`)
    }
    try {
        fs.unlinkSync(link)
    }
    catch (err) {
        fs.rmdirSync(link)
    }
    assert.strictEqual(lstatOrNull(link), null, `目錄連結[${link}]未拆除`)
}

//replay, 以指定settings於策略檔之求解時間窗重跑官方runStrategy(獨立於受測之worker)
let replay = async (data, settings) => {
    let fgs = await dataProvide(base.fds.ohlc, base.fds.param).buildGetTimeSeriesByTimeRange(data.solve.timeStart, data.solve.timeEnd)
    return runStrategy(makeOtt(base.timeZone), { ...data, settings }, fgs)
}
let settingsU = (data) => ({ ...data.settings, uIni: 10000, unit: unitR })

let rc = (cfg, opt) => recomputeStrategies(cfg, { takeLimit: 2, ...opt })

//rejectsKeep, 被拒之寫出案: 拋錯且原策略庫逐位不變
let rejectsKeep = async (cfg, opt, re, fdSrc) => {
    let before = snapshot(fdSrc)
    await assert.rejects(rc(cfg, opt), re)
    assert.deepStrictEqual(snapshot(fdSrc), before, 'C10 原策略庫須逐位不變')
}


describe('recomputeStrategies(策略庫依基礎單位重算)', function() {

    this.timeout(300000)

    before(async function() {
        let { cfg } = cfgOf(fdTmp, n)
        let pl = createPipeline(cfg)
        await pl.buildOhlc()
        await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd'] })
        base = pl.cfg
        fdLib = base.fds.strategies
        await pl.solve({ ...quick, mode: 'long', maxRounds: 2 })
        await pl.solve({ ...quick, mode: 'short', maxRounds: 2 })
        fns = listJson(fdLib)
        cfgU = normalizeCfg({ ...base, settings: { ...base.settings, uIni: 10000, unit: unitR } })
    })

    after(function() {
        for (let l of links) {
            removeLink(l)
        }
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('前提: 策略庫有做多與做空之策略, 且各單名義隨進場價而異', async function() {
        assert.ok(fns.length >= 4, `策略數 ${fns.length}`)
        let ms = new Set(fns.map((f) => f.split('_')[0]))
        assert.ok(ms.has('long') && ms.has('short'))
        let r = await replay(readJ(fdLib, fns[0]), settingsU(readJ(fdLib, fns[0])))
        assert.ok(new Set(r.orders.map((o) => o.uTrade)).size >= 2, '鑑別前提: 各單名義相異')
    })

    it('C1/C2 verify: 全部忠實重放相符; 不寫策略檔; journal與report寫於fdReport; 結束後釋放鎖檔', async function() {
        let before = snapshot(fdLib)
        let fdReport = path.resolve(fdTmp, 'rep-verify')
        let prog = []
        let r = await rc(base, { mode: 'verify', fdReport, onProgress: (p) => prog.push(p) })
        assert.strictEqual(r.ok, true)
        assert.strictEqual(r.complete, true)
        assert.deepStrictEqual(r.counts, { ok: fns.length }) //C1 全部相符
        assert.deepStrictEqual(r.faithful, { nPass: fns.length, nMismatch: 0, mismatchFields: {}, nFitnessStale: 0 })
        assert.strictEqual(r.nRun, fns.length)
        assert.deepStrictEqual(snapshot(fdLib), before) //C2 verify不寫檔
        assert.strictEqual(prog[prog.length - 1].i, fns.length)
        let lines = fs.readFileSync(path.resolve(fdReport, 'journal_verify.jsonl'), 'utf8').trim().split('\n')
        assert.strictEqual(lines.length, fns.length + 1) //C6 首行header + 每檔一行
        assert.strictEqual(JSON.parse(lines[0]).header, true)
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(fdReport, 'report_verify.json'), 'utf8')).counts, r.counts)
        assert.strictEqual(fs.existsSync(path.resolve(fdReport, 'recompute.lock')), false) //C11 釋放
        assert.strictEqual(r.staleLock, false)
    })

    it('C1/C8 verify之鑑別: 竄改摘要一欄即mismatch並列欄名; 竄改fitness只記fitnessStale; 無solve時間窗者unsupported; 壞檔error; 跑完並列出全部', async function() {
        let fd = copyLib(path.resolve(fdTmp, 'lib-bad'))
        let a = readJ(fd, fns[0])
        a.summary.rSharpe = a.summary.rSharpe + 1e-9
        fs.writeFileSync(path.resolve(fd, fns[0]), JSON.stringify(a, null, 2), 'utf8')
        let b = readJ(fd, fns[1])
        let fitOrig = b.fitness
        b.fitness = fitOrig + 1
        fs.writeFileSync(path.resolve(fd, fns[1]), JSON.stringify(b, null, 2), 'utf8')
        let c = readJ(fd, fns[2])
        delete c.solve
        fs.writeFileSync(path.resolve(fd, 'zz_nosolve.json'), JSON.stringify(c, null, 2), 'utf8')
        fs.writeFileSync(path.resolve(fd, 'zz_corrupt.json'), 'x{', 'utf8')
        let fdReport = path.resolve(fdTmp, 'rep-bad')
        let r = await rc(base, { mode: 'verify', fdIn: fd, fdReport })
        assert.deepStrictEqual(r.counts, { ok: fns.length - 1, mismatch: 1, unsupported: 1, error: 1 })
        assert.strictEqual(r.ok, false)
        assert.strictEqual(r.nFailures, 3)
        let byFn = Object.fromEntries(r.failures.map((e) => [e.fn, e]))
        assert.deepStrictEqual(byFn[fns[0]].diffFields, ['rSharpe']) //C1 列欄名
        assert.strictEqual(byFn['zz_nosolve.json'].status, 'unsupported') //C8
        assert.strictEqual(byFn['zz_corrupt.json'].status, 'error')
        assert.deepStrictEqual(r.faithful.mismatchFields, { rSharpe: 1 })
        assert.strictEqual(r.faithful.nFitnessStale, 1) //C1 fitness不同只記錄, 不擋
        let js = fs.readFileSync(path.resolve(fdReport, 'journal_verify.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l))
        let e1 = js.find((e) => e.fn === fns[1])
        assert.deepStrictEqual([e1.status, e1.fitnessStale, e1.fitness0, e1.fitnessNow], ['ok', true, fitOrig + 1, fitOrig])
    })

    it('C7 dry之統計母體: 前後等效年化皆以重算成功者計(不合格者不入前後分布)', async function() {
        let fd = path.resolve(fdTmp, 'lib-bad')
        let before = snapshot(fd)
        let r = await rc(cfgU, { mode: 'dry', fdIn: fd, fdReport: path.resolve(fdTmp, 'rep-bad-dry') })
        assert.deepStrictEqual(r.counts, { ok: fns.length - 1, mismatch: 1, unsupported: 1, error: 1 })
        assert.deepStrictEqual([r.eqYrBefore.n, r.eqYrAfter.n, r.eqYrDelta.n, r.cross.nBase], [fns.length - 1, fns.length - 1, fns.length - 1, fns.length - 1]) //C7 同一母體(mismatch者有前值而無後值, 不計)
        assert.deepStrictEqual(snapshot(fd), before)
    })

    it('C5/C10 write於不合格即中止: 不再寫檔並列出, 不合格之檔不寫, 原庫不變, 寫部分之統計', async function() {
        let fd = path.resolve(fdTmp, 'lib-bad')
        let before = snapshot(fd)
        let fdOut = path.resolve(fdTmp, 'out-bad')
        let fdReport = path.resolve(fdTmp, 'rep-bad-w')
        let r = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut, fdReport, takeLimit: 1 })
        assert.strictEqual(r.aborted, true) //C5 中止
        assert.strictEqual(r.ok, false)
        assert.strictEqual(r.crashed, null)
        assert.match(r.abortReason, /mismatch/)
        assert.strictEqual(r.nRun, 1) //依檔名排序, 第1檔即竄改者
        assert.deepStrictEqual(listJson(fdOut), []) //C5 不合格之檔不寫
        assert.deepStrictEqual(snapshot(fd), before) //C10
        assert.strictEqual(JSON.parse(fs.readFileSync(path.resolve(fdReport, 'report_write.json'), 'utf8')).aborted, true)
    })

    it('C2/C3/C7 dry: 不寫檔; 前後等效年化與跨門檻之清單與獨立重放一致', async function() {
        let fd = copyLib(path.resolve(fdTmp, 'lib-cross'))
        let wantDown = []
        let wantUp = []
        for (let [i, fn] of fns.entries()) {
            let d = readJ(fd, fn)
            let e0 = p2r(d.summary.rEquivalentCumuProfitOrLossFinalNormYear)
            let e1 = p2r((await replay(d, settingsU(d))).summary.rEquivalentCumuProfitOrLossFinalNormYear)
            let th = -1e9
            if (i % 2 === 0 && e0 !== e1) {
                th = (e0 + e1) / 2 //門檻取前後之中點 ⇒ 必跨
                ;(e1 < e0 ? wantDown : wantUp).push(fn)
            }
            d.solve.thREquivalentCumuProfitOrLossFinalNormYear = th
            fs.writeFileSync(path.resolve(fd, fn), JSON.stringify(d, null, 2), 'utf8')
        }
        assert.ok(wantDown.length + wantUp.length >= 1, '鑑別前提: 有新舊等效年化不同者')
        let before = snapshot(fd)
        let r = await rc(cfgU, { mode: 'dry', fdIn: fd, fdReport: path.resolve(fdTmp, 'rep-dry') })
        assert.strictEqual(r.ok, true)
        assert.deepStrictEqual(r.counts, { ok: fns.length })
        assert.deepStrictEqual(snapshot(fd), before) //C2 dry不寫檔
        assert.deepStrictEqual(r.cross.down.map((x) => x.fn).sort(), wantDown.sort()) //C7 跨門檻清單
        assert.deepStrictEqual(r.cross.up.map((x) => x.fn).sort(), wantUp.sort())
        assert.strictEqual(r.cross.nDown + r.cross.nUp, wantDown.length + wantUp.length)
        assert.deepStrictEqual([r.cross.nWithThreshold, r.cross.nThFallback, r.cross.nNoThreshold], [fns.length, 0, 0])
        let cross = JSON.parse(fs.readFileSync(path.resolve(fdTmp, 'rep-dry', 'cross_dry.json'), 'utf8'))
        assert.strictEqual(cross.down.length, wantDown.length)
        assert.strictEqual(r.eqYrBefore.n, fns.length)
        assert.strictEqual(r.eqYrAfter.n, fns.length)
        assert.ok((r.diffFields.uTradeAllMax || 0) === fns.length, 'C7 最大持倉名義每隻皆變')
        assert.ok(r.uTradeAllMaxAfter.max <= 10000 && r.uTradeAllMaxAfter.maxOverUIni === r.uTradeAllMaxAfter.max / 10000)
        assert.deepStrictEqual([r.overUIni.n, r.overUIni.top], [0, []]) //C9 本金10000時無超過者
    })

    it('C7 入庫門檻: 檔內無門檻者未給thEqYr即列noThreshold(不計入跨門檻); 給thEqYr即以之計並回報nThFallback', async function() {
        let fd = copyLib(path.resolve(fdTmp, 'lib-th'))
        //fA, 新舊等效年化不同者(以其前後中點為替代門檻 ⇒ 必跨); fB, 另一隻
        let eq = {}
        for (let fn of fns) {
            let d = readJ(fd, fn)
            eq[fn] = [p2r(d.summary.rEquivalentCumuProfitOrLossFinalNormYear), p2r((await replay(d, settingsU(d))).summary.rEquivalentCumuProfitOrLossFinalNormYear)]
        }
        let fA = fns.find((fn) => eq[fn][0] !== eq[fn][1])
        assert.ok(fA, '鑑別前提: 有新舊等效年化不同者')
        let fB = fns.find((fn) => fn !== fA)
        for (let fn of [fA, fB]) {
            let d = readJ(fd, fn)
            delete d.solve.thREquivalentCumuProfitOrLossFinalNormYear
            fs.writeFileSync(path.resolve(fd, fn), JSON.stringify(d, null, 2), 'utf8')
        }
        let r0 = await rc(cfgU, { mode: 'dry', fdIn: fd, fdReport: path.resolve(fdTmp, 'rep-th0') })
        assert.deepStrictEqual([r0.cross.nNoThreshold, r0.cross.nThFallback, r0.cross.nWithThreshold], [2, 0, fns.length - 2]) //C7 無門檻者不計
        assert.deepStrictEqual(r0.cross.noThreshold, [fA, fB].sort())
        assert.ok(!r0.cross.down.concat(r0.cross.up).some((x) => x.fn === fA || x.fn === fB))
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(fdTmp, 'rep-th0', 'cross_dry.json'), 'utf8')).noThreshold, [fA, fB].sort())
        let mid = (eq[fA][0] + eq[fA][1]) / 2
        let r1 = await rc(cfgU, { mode: 'dry', fdIn: fd, thEqYr: mid, fdReport: path.resolve(fdTmp, 'rep-th1') })
        assert.deepStrictEqual([r1.cross.nNoThreshold, r1.cross.nThFallback, r1.cross.nWithThreshold], [0, 2, fns.length]) //C7 替代門檻
        assert.strictEqual(r1.thEqYr, mid)
        let hit = r1.cross.down.concat(r1.cross.up).find((x) => x.fn === fA)
        assert.ok(hit, 'C7 以替代門檻計而跨過')
        assert.strictEqual(hit.th, Math.round(mid * 1e8) / 1e6)
    })

    describe('write', function() {

        let fdOut = null
        let rw = null
        let snapLib = null

        before(async function() {
            fdOut = path.resolve(fdTmp, 'out-full')
            snapLib = snapshot(fdLib)
            rw = await rc(cfgU, { mode: 'write', fdOut, fdReport: path.resolve(fdTmp, 'rep-write') })
        })

        //C10 本組各案(含續跑之各次write)後, 原策略庫須與起始快照逐位相同
        afterEach(function() {
            assert.deepStrictEqual(snapshot(fdLib), snapLib, 'C10 原策略庫須逐位不變')
        })

        it('C3/C10 檔名與檔數不變, 原庫逐位不變, 無殘留暫存檔', function() {
            assert.strictEqual(rw.ok, true)
            assert.strictEqual(rw.namesSame, true) //C3
            assert.deepStrictEqual(listJson(fdOut), fns)
            assert.deepStrictEqual(fs.readdirSync(fdOut).sort(), fns)
            assert.deepStrictEqual(snapshot(fdLib), snapLib) //C10
        })

        it('C3/C4 每隻: settings改記uIni與unit(unit接於末)、summary為新settings之重放、fitness為calcFitness、交易筆數已平倉筆數勝率不變、其餘欄與鍵序不變、格式同原檔', async function() {
            for (let fn of fns) {
                let textO = fs.readFileSync(path.resolve(fdLib, fn), 'utf8')
                let o = JSON.parse(textO)
                assert.strictEqual(textO, JSON.stringify(o, null, 2)) //原檔之格式(縮排2、無結尾換行)
                let text = fs.readFileSync(path.resolve(fdOut, fn), 'utf8')
                let w = JSON.parse(text)
                assert.strictEqual(text, JSON.stringify(w, null, 2)) //C3 輸出格式同原檔
                assert.deepStrictEqual(Object.keys(w), Object.keys(o)) //C3 鍵序不變
                assert.deepStrictEqual(Object.keys(w.settings), [...Object.keys(o.settings), 'unit'])
                assert.deepStrictEqual(w.settings, settingsU(o)) //C3
                let r = await replay(o, settingsU(o))
                assert.deepStrictEqual(noTimeTest(w.summary), noTimeTest(r.summary)) //C3 新口徑之摘要
                assert.strictEqual(w.fitness, calcFitness(w.settings, w.summary))
                for (let k of ['numTrade', 'numTradeFin', 'rWin']) {
                    assert.strictEqual(w.summary[k], o.summary[k], `${fn} ${k}`) //C4
                }
                for (let k of Object.keys(o).filter((k) => !['settings', 'summary', 'fitness'].includes(k))) {
                    assert.deepStrictEqual(w[k], o[k], `${fn} ${k}`) //C3 其餘欄不變
                }
                assert.notStrictEqual(w.summary.uTradeAllMax, o.summary.uTradeAllMax)
            }
        })

        it('C1/C6 已重算之庫再verify仍全部相符(以檔內unit重放)', async function() {
            let r = await rc(cfgU, { mode: 'verify', fdIn: fdOut, fdReport: path.resolve(fdTmp, 'rep-write-verify') })
            assert.deepStrictEqual(r.counts, { ok: fns.length })
        })

        it('C6 可中斷續跑: 先跑3檔再續跑, 只做其餘, 結果與一次跑完相同(timeTest除外); header記各項且不符即throw', async function() {
            let fdOutA = path.resolve(fdTmp, 'out-resume')
            let fdReport = path.resolve(fdTmp, 'rep-resume')
            let r1 = await rc(cfgU, { mode: 'write', fdOut: fdOutA, fdReport, limit: 3 })
            assert.strictEqual(r1.nRun, 3)
            assert.strictEqual(r1.complete, true)
            assert.strictEqual(r1.namesSame, true) //部分選取時以所選之檔為準
            assert.strictEqual(r1.ok, true)
            let h = JSON.parse(fs.readFileSync(path.resolve(fdReport, 'journal_write.jsonl'), 'utf8').split('\n')[0])
            assert.deepStrictEqual(Object.keys(h), ['header', 'mode', 'fdIn', 'fdOut', 'target', 'fdOhlc', 'fdParam', 'timeZone', 'thEqYr', 'versions']) //C6
            assert.deepStrictEqual(Object.keys(h.versions), ['w-trade-strategy', 'w-trade-solve', 'w-trade-backtest'])
            assert.ok(Object.values(h.versions).every((v) => /^\d+\.\d+\.\d+/.test(v)), JSON.stringify(h.versions))
            assert.deepStrictEqual([h.fdIn, h.fdOut, h.timeZone, h.thEqYr], [fdLib, fdOutA, base.timeZone, null])
            let r2 = await rc(cfgU, { mode: 'write', fdOut: fdOutA, fdReport })
            assert.strictEqual(r2.nFromJournal, 3) //C6 略過已完成者
            assert.strictEqual(r2.nRun, fns.length - 3)
            assert.strictEqual(r2.nRedo, 0)
            assert.strictEqual(r2.ok, true)
            assert.strictEqual(r2.namesSame, true)
            for (let fn of fns) {
                assert.deepStrictEqual(maskTime(readJ(fdOutA, fn)), maskTime(readJ(fdOut, fn)))
            }
            await assert.rejects(rc(cfgU, { mode: 'write', fdOut: fdOutA, fdReport, uIni: 20000 }), /header/) //C6 目標口徑不同
            await assert.rejects(rc(cfgU, { mode: 'write', fdOut: fdOutA, fdReport, thEqYr: 0.1 }), /header/) //C6 門檻不同
        })

        it('C6 續跑核對輸出檔: 輸出檔被刪或位元組不同者重做; 末行半截之journal丟棄後續跑; 輸出夾多出檔案時namesSame為false且ok為false', async function() {
            let fdOutD = path.resolve(fdTmp, 'out-redo')
            let fdReport = path.resolve(fdTmp, 'rep-redo')
            let r1 = await rc(cfgU, { mode: 'write', fdOut: fdOutD, fdReport })
            assert.strictEqual(r1.ok, true)
            fs.rmSync(path.resolve(fdOutD, fns[0]))
            fs.writeFileSync(path.resolve(fdOutD, fns[1]), JSON.stringify(readJ(fdOutD, fns[1])), 'utf8') //內容同而位元組不同
            let r2 = await rc(cfgU, { mode: 'write', fdOut: fdOutD, fdReport })
            assert.deepStrictEqual([r2.nRedo, r2.nRun, r2.nFromJournal, r2.ok, r2.namesSame], [2, 2, fns.length - 2, true, true]) //C6 重做
            for (let fn of [fns[0], fns[1]]) {
                let text = fs.readFileSync(path.resolve(fdOutD, fn), 'utf8')
                assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2))
                assert.deepStrictEqual(maskTime(JSON.parse(text)), maskTime(readJ(fdOut, fn)))
            }
            //末行半截
            let fpJ = path.resolve(fdReport, 'journal_write.jsonl')
            fs.appendFileSync(fpJ, `{"fn":"${fns[2]}","sta`, 'utf8')
            let r3 = await rc(cfgU, { mode: 'write', fdOut: fdOutD, fdReport })
            assert.deepStrictEqual([r3.journalTruncated, r3.nRun, r3.nFromJournal, r3.ok], [1, 0, fns.length, true])
            let textJ = fs.readFileSync(fpJ, 'utf8')
            assert.ok(textJ.endsWith('\n'))
            assert.doesNotThrow(() => textJ.trim().split('\n').forEach((l) => JSON.parse(l)))
            //輸出夾多出檔案
            fs.writeFileSync(path.resolve(fdOutD, 'zz_extra.json'), '{}', 'utf8')
            let r4 = await rc(cfgU, { mode: 'write', fdOut: fdOutD, fdReport })
            assert.deepStrictEqual([r4.complete, r4.nFailures, r4.namesSame, r4.ok], [true, 0, false, false]) //C6 write之ok須namesSame
        })

        it('C1/C3 檔內fitness為舊算法者照常重算, fitness以現行calcFitness重寫; 原庫不變', async function() {
            let fd = copyLib(path.resolve(fdTmp, 'lib-stale'))
            let d = readJ(fd, fns[0])
            d.fitness = d.fitness + 0.5
            fs.writeFileSync(path.resolve(fd, fns[0]), JSON.stringify(d, null, 2), 'utf8')
            let before = snapshot(fd)
            let fdOutS = path.resolve(fdTmp, 'out-stale')
            let r = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutS, fdReport: path.resolve(fdTmp, 'rep-stale') })
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.faithful.nFitnessStale, 1)
            let w = readJ(fdOutS, fns[0])
            assert.strictEqual(w.fitness, calcFitness(w.settings, w.summary)) //C3
            assert.deepStrictEqual(maskTime(w), maskTime(readJ(fdOut, fns[0])))
            assert.deepStrictEqual(snapshot(fd), before) //C10
        })

        it('C6 已為目標口徑之庫再寫出為already且逐位複製至fdOut; fitness非現行算法者不算already而重寫', async function() {
            let before = snapshot(fdOut)
            let fdCopy = path.resolve(fdTmp, 'out-copy')
            let r1 = await rc(cfgU, { mode: 'write', fdIn: fdOut, fdOut: fdCopy, fdReport: path.resolve(fdTmp, 'rep-copy') })
            assert.deepStrictEqual(r1.counts, { already: fns.length }) //C6 already
            assert.strictEqual(r1.ok, true)
            assert.deepStrictEqual(snapshot(fdCopy), before) //already者逐位複製
            assert.deepStrictEqual(snapshot(fdOut), before) //C10
            let fd = path.resolve(fdTmp, 'lib-already')
            fs.mkdirSync(fd, { recursive: true })
            for (let f of fns) {
                fs.copyFileSync(path.resolve(fdOut, f), path.resolve(fd, f))
            }
            let d = readJ(fd, fns[1])
            d.fitness = d.fitness + 0.25
            fs.writeFileSync(path.resolve(fd, fns[1]), JSON.stringify(d, null, 2), 'utf8')
            let snapA = snapshot(fd)
            let fdOut2 = path.resolve(fdTmp, 'out-already2')
            let r2 = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOut2, fdReport: path.resolve(fdTmp, 'rep-already2') })
            assert.deepStrictEqual(r2.counts, { already: fns.length - 1, ok: 1 })
            let w = readJ(fdOut2, fns[1])
            assert.strictEqual(w.fitness, calcFitness(w.settings, w.summary))
            assert.deepStrictEqual(snapshot(fd), snapA) //C10 來源夾逐位不變
        })

        it('C6/K4 檔內settings.unit之數字字串與同值之數字視為同一口徑(already, 逐位複製); 記錄欄asOf不同或缺asOf與source者不算already而重算並記目標之記錄欄', async function() {
            let fd = path.resolve(fdTmp, 'lib-already-str')
            fs.mkdirSync(fd, { recursive: true })
            for (let f of fns) {
                fs.copyFileSync(path.resolve(fdOut, f), path.resolve(fd, f))
            }
            let edit = (fn, f) => {
                let d = readJ(fd, fn)
                f(d)
                fs.writeFileSync(path.resolve(fd, fn), JSON.stringify(d, null, 2), 'utf8')
            }
            edit(fns[0], (d) => {
                Object.assign(d.settings.unit.rule, { stepSize: '0.1', minQty: ' 0.1 ', minNotional: '5e0' })
                d.settings.unit.buffer = '1e-1'
                d.settings.unit.units = '1'
            }) //同一口徑之數字字串寫法
            edit(fns[1], (d) => {
                d.settings.unit.rule.asOf = '2025-12-31T00:00:00'
            }) //記錄欄不同
            edit(fns[2], (d) => {
                delete d.settings.unit.rule.asOf
                delete d.settings.unit.rule.source
            }) //缺記錄欄
            let snapA = snapshot(fd)
            let fdOutA = path.resolve(fdTmp, 'out-already-str')
            let fdReport = path.resolve(fdTmp, 'rep-already-str')
            let r = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutA, fdReport })
            assert.deepStrictEqual(r.counts, { already: fns.length - 2, ok: 2 }) //K4 數字字串與同值之數字視為相同
            let st = Object.fromEntries(fs.readFileSync(path.resolve(fdReport, 'journal_write.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l)).map((e) => [e.fn, e.status]))
            assert.deepStrictEqual([st[fns[0]], st[fns[1]], st[fns[2]]], ['already', 'ok', 'ok'])
            assert.strictEqual(fs.readFileSync(path.resolve(fdOutA, fns[0]), 'utf8'), fs.readFileSync(path.resolve(fd, fns[0]), 'utf8')) //already者逐位複製(含原數字字串寫法)
            assert.strictEqual(readJ(fdOutA, fns[0]).settings.unit.rule.stepSize, '0.1')
            for (let fn of [fns[1], fns[2]]) {
                assert.deepStrictEqual(readJ(fdOutA, fn).settings.unit, unitR, fn) //重算而記目標之記錄欄與數值
            }
            assert.deepStrictEqual(snapshot(fd), snapA) //C10 來源夾逐位不變
        })

        //檔內settings.uIni之數字字串(K4、K7): w-trade-backtest 1.1.43起對settings.uIni收數字字串並轉型(給數字字串與給數字之訂單與摘要逐位相同), 給了而無效即reject(訊息不含輸入值); 故與settings.unit同規則: 與目標同值者視為相同
        let copyOutTo = (to) => {
            fs.mkdirSync(to, { recursive: true })
            for (let f of fns) {
                fs.copyFileSync(path.resolve(fdOut, f), path.resolve(to, f))
            }
            return to
        }
        let editIn = (fd, fn, f) => {
            let d = readJ(fd, fn)
            f(d)
            fs.writeFileSync(path.resolve(fd, fn), JSON.stringify(d, null, 2), 'utf8')
        }
        let initOf = (fdIn, mode) => ({ fdIn, fdOhlc: base.fds.ohlc, fdParam: base.fds.param, timeZone: base.timeZone, mode, target: { uIni: 10000, unit: normalizeUnit(unitR, 'unit') } })
        let statusOf = (fdReport, mode) => Object.fromEntries(fs.readFileSync(path.resolve(fdReport, `journal_${mode}.jsonl`), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l)).map((e) => [e.fn, e.status]))

        it('C6/K4 檔內settings.uIni之數字字串與同值之數字視為同一口徑(忠實重放通過, fitness為現行者為already並逐位複製含原字串寫法; fitness不同者依既有流程重算並落地為數值)', async function() {
            //前提: 回測套件對settings.uIni之數字字串轉型, 摘要與給數字者逐位相同(此前提不成立時, 以下各案之意義即失)
            let d0 = readJ(fdOut, fns[0])
            let sNum = noTimeTest((await replay(d0, d0.settings)).summary)
            let sStr = noTimeTest((await replay(d0, { ...d0.settings, uIni: ' 1e4 ' })).summary)
            assert.strictEqual(typeof sStr.uIni, 'number', '前提: summary.uIni為數值')
            assert.deepStrictEqual(sStr, sNum, '前提: 數字字串與數字之摘要逐位相同')
            let fd = copyOutTo(path.resolve(fdTmp, 'lib-uini-same'))
            editIn(fd, fns[0], (d) => {
                d.settings.uIni = '10000'
            }) //同值之數字字串
            editIn(fd, fns[1], (d) => {
                d.settings.uIni = ' 1e4 '
            }) //同值之另一寫法(去頭尾空白與指數記法, 與回測套件之收值一致)
            editIn(fd, fns[2], (d) => {
                d.settings.uIni = '10000'
                d.fitness = d.fitness + 0.25
            }) //同值之數字字串但fitness非現行者
            let snapA = snapshot(fd)
            //K4 核心逐檔: 同值之數字字串者為already
            let core = createCore(initOf(fd, 'dry'))
            for (let fn of [fns[0], fns[1]]) {
                let r0 = await core({ fn })
                assert.strictEqual(r0.status, 'already', `${fn} ${JSON.stringify(r0)}`)
            }
            //K4 聚合入口: write
            let fdOutA = path.resolve(fdTmp, 'out-uini-same')
            let fdReport = path.resolve(fdTmp, 'rep-uini-same')
            let r = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutA, fdReport })
            assert.deepStrictEqual(r.counts, { already: fns.length - 1, ok: 1 }) //K4 數字字串與同值之數字視為相同
            let st = statusOf(fdReport, 'write')
            assert.deepStrictEqual([st[fns[0]], st[fns[1]], st[fns[2]]], ['already', 'already', 'ok'])
            for (let fn of [fns[0], fns[1]]) {
                assert.strictEqual(fs.readFileSync(path.resolve(fdOutA, fn), 'utf8'), fs.readFileSync(path.resolve(fd, fn), 'utf8'), fn) //already者逐位複製(含原字串寫法)
            }
            assert.strictEqual(readJ(fdOutA, fns[0]).settings.uIni, '10000')
            assert.strictEqual(readJ(fdOutA, fns[1]).settings.uIni, ' 1e4 ')
            let w = readJ(fdOutA, fns[2])
            assert.strictEqual(w.settings.uIni, 10000) //重算者落地為數值(以目標為準)
            assert.strictEqual(w.fitness, calcFitness(w.settings, w.summary)) //fitness以現行算法重寫
            assert.deepStrictEqual(snapshot(fd), snapA) //C10 來源夾逐位不變
        })

        it('C1/C3/K4 檔內settings.uIni為不同於目標之數字字串者: 不以數字字串本身為mismatch(verify為ok), 依目標重算, 落地之settings.uIni為目標之數值, 輸出與以數值起算者相同(timeTest除外)', async function() {
            let fd = copyLib(path.resolve(fdTmp, 'lib-uini-diff'))
            editIn(fd, fns[0], (d) => {
                d.settings.uIni = String(d.settings.uIni)
            })
            editIn(fd, fns[1], (d) => {
                d.settings.uIni = ` ${d.settings.uIni} `
            })
            assert.deepStrictEqual([readJ(fd, fns[0]).settings.uIni, readJ(fd, fns[1]).settings.uIni], ['1000', ' 1000 '], '前提: 檔內為異於目標(10000)之數字字串')
            let snapA = snapshot(fd)
            let rv = await rc(base, { mode: 'verify', fdIn: fd, fdReport: path.resolve(fdTmp, 'rep-uini-diff-v') })
            assert.deepStrictEqual(rv.counts, { ok: fns.length }) //C1 忠實重放通過, 不以數字字串本身為mismatch
            assert.deepStrictEqual(rv.faithful, { nPass: fns.length, nMismatch: 0, mismatchFields: {}, nFitnessStale: 0 })
            let fdOutB = path.resolve(fdTmp, 'out-uini-diff')
            let rw2 = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutB, fdReport: path.resolve(fdTmp, 'rep-uini-diff-w') })
            assert.deepStrictEqual(rw2.counts, { ok: fns.length }) //K4 與目標不同值, 依目標重算(不當作already)
            for (let fn of [fns[0], fns[1]]) {
                let w = readJ(fdOutB, fn)
                assert.strictEqual(w.settings.uIni, 10000, fn) //C3 uIni換為目標(數值)
                assert.deepStrictEqual(maskTime(w), maskTime(readJ(fdOut, fn)), fn) //與以數值1000起算之輸出相同
            }
            assert.deepStrictEqual(snapshot(fd), snapA) //C10 來源夾逐位不變

            //鑑別前提: 上列之檔本來即與目標之unit不同(未給unit), 不論uIni之值為何皆非already; 故另取已在目標口徑(unit相同)之庫, 只把uIni改為不同值(字串與數字各一, summary與fitness依該uIni重放更新使忠實重放通過), 此時是否重算唯繫於uIni之值
            let fd2 = copyOutTo(path.resolve(fdTmp, 'lib-uini-diff2'))
            for (let [fn, u] of [[fns[2], '2500'], [fns[3], 2500]]) {
                let d = readJ(fd2, fn)
                d.settings.uIni = u
                d.summary = (await replay(d, d.settings)).summary
                d.fitness = calcFitness(d.settings, d.summary)
                fs.writeFileSync(path.resolve(fd2, fn), JSON.stringify(d, null, 2), 'utf8')
            }
            assert.deepStrictEqual([readJ(fd2, fns[2]).settings.unit, readJ(fd2, fns[3]).settings.unit], [unitR, unitR], '前提: unit與目標相同(僅uIni之值不同)')
            let snapA2 = snapshot(fd2)
            let rv2 = await rc(base, { mode: 'verify', fdIn: fd2, fdReport: path.resolve(fdTmp, 'rep-uini-diff2-v') })
            assert.deepStrictEqual(rv2.counts, { ok: fns.length }) //C1 忠實重放通過
            let fdOutB2 = path.resolve(fdTmp, 'out-uini-diff2')
            let rw3 = await rc(cfgU, { mode: 'write', fdIn: fd2, fdOut: fdOutB2, fdReport: path.resolve(fdTmp, 'rep-uini-diff2-w') })
            assert.deepStrictEqual(rw3.counts, { already: fns.length - 2, ok: 2 }) //K4 uIni之值不同(字串與數字皆然)者依目標重算, 不當作already
            for (let fn of [fns[2], fns[3]]) {
                let w = readJ(fdOutB2, fn)
                assert.strictEqual(w.settings.uIni, 10000, fn)
                assert.deepStrictEqual(maskTime(w), maskTime(readJ(fdOut, fn)), fn) //與目標口徑之輸出相同
            }
            assert.deepStrictEqual(snapshot(fd2), snapA2) //C10 來源夾逐位不變
        })

        it('C1/C5/C8/V19/V20 檔內settings.uIni為無效值(非數字字串、非正數、非數值型別)者: 忠實重放被回測套件拒絕而記error(訊息V19格式、不含輸入值), 不中斷整批(verify與dry跑完並列出全部), write即中止且不寫該檔', async function() {
            let secret = 'ZZ-secret-uini'
            let msg = 'invalid settings.uIni: must be a positive number'
            //核心逐檔: 各種無效值皆為error, 不拋出
            let fdC = path.resolve(fdTmp, 'lib-uini-badvals')
            fs.mkdirSync(fdC, { recursive: true })
            let src = readJ(fdOut, fns[0])
            let bads = [secret, '', ' ', '0', '-5', '10000abc', 0, -1, true, {}, []]
            let core = createCore(initOf(fdC, 'dry'))
            for (let [i, v] of bads.entries()) {
                fs.writeFileSync(path.resolve(fdC, `bad${i}.json`), JSON.stringify({ ...src, settings: { ...src.settings, uIni: v } }, null, 2), 'utf8')
                let r0 = await core({ fn: `bad${i}.json` })
                assert.deepStrictEqual([r0.status, r0.detail], ['error', msg], JSON.stringify(v)) //C8 例外一律以status error回傳
            }
            //聚合入口: 庫內有一隻無效值
            let fdB = copyOutTo(path.resolve(fdTmp, 'lib-uini-bad'))
            editIn(fdB, fns[0], (d) => {
                d.settings.uIni = secret
            })
            let snapB = snapshot(fdB)
            let noSecret = (fdReport) => {
                for (let f of fs.readdirSync(fdReport)) {
                    assert.ok(!fs.readFileSync(path.resolve(fdReport, f), 'utf8').includes(secret), `${f} 含輸入值`) //V20
                }
            }
            for (let [mode, okStatus] of [['verify', 'ok'], ['dry', 'already']]) {
                let fdReport = path.resolve(fdTmp, `rep-uini-bad-${mode}`)
                let r = await rc(cfgU, { mode, fdIn: fdB, fdReport })
                assert.deepStrictEqual(r.counts, { [okStatus]: fns.length - 1, error: 1 }, mode) //C1 不中斷: 其餘各檔照常處理
                assert.deepStrictEqual([r.nRun, r.aborted, r.crashed], [fns.length, false, null], mode) //不中斷: 全部逐檔處理完(complete須全部ok或already, 有不合格者為false)
                assert.strictEqual(r.ok, false)
                assert.strictEqual(r.nFailures, 1)
                assert.deepStrictEqual([r.failures[0].fn, r.failures[0].status, r.failures[0].detail], [fns[0], 'error', msg])
                assert.strictEqual(fs.readFileSync(path.resolve(fdReport, `journal_${mode}.jsonl`), 'utf8').trim().split('\n').length, fns.length + 1, mode) //全部逐檔記入
                noSecret(fdReport)
            }
            //C5 write遇不合格即中止, 不合格之檔不寫
            let fdOutC = path.resolve(fdTmp, 'out-uini-bad')
            let fdReportW = path.resolve(fdTmp, 'rep-uini-bad-w')
            let rW = await rc(cfgU, { mode: 'write', fdIn: fdB, fdOut: fdOutC, fdReport: fdReportW, takeLimit: 1 })
            assert.strictEqual(rW.aborted, true)
            assert.strictEqual(rW.ok, false)
            assert.match(rW.abortReason, /error/)
            assert.deepStrictEqual(listJson(fdOutC), []) //依檔名排序, 第1檔即無效值者, 不寫
            noSecret(fdReportW)
            assert.deepStrictEqual(snapshot(fdB), snapB) //C10 來源夾逐位不變
        })

        it('C6 縮小選取範圍之續跑: 先寫3檔再以同一journal只選前2檔續跑, namesSame為true(輸出夾之檔皆屬journal已記者且涵蓋所選)', async function() {
            let fdOutS = path.resolve(fdTmp, 'out-shrink')
            let fdReport = path.resolve(fdTmp, 'rep-shrink')
            let r1 = await rc(cfgU, { mode: 'write', fdOut: fdOutS, fdReport, limit: 3 })
            assert.deepStrictEqual([r1.ok, r1.namesSame], [true, true])
            let r2 = await rc(cfgU, { mode: 'write', fdOut: fdOutS, fdReport, limit: 2 })
            assert.deepStrictEqual([r2.nRun, r2.nFromJournal, r2.complete, r2.namesSame, r2.ok], [0, 2, true, true, true]) //C6
            assert.strictEqual(listJson(fdOutS).length, 3)
        })

        it('C6 部分選取時namesSame之兩個條件: 輸出夾有非journal所記之檔 ⇒ false; 本次所選之輸出檔於執行中被刪 ⇒ false', async function() {
            //輸出夾有非journal所記之檔(部分選取, 不受全庫檔數之條件遮蔽)
            let fdOutX = path.resolve(fdTmp, 'out-ns-extra')
            let fdReportX = path.resolve(fdTmp, 'rep-ns-extra')
            let r1 = await rc(cfgU, { mode: 'write', fdOut: fdOutX, fdReport: fdReportX, limit: 3 })
            assert.deepStrictEqual([r1.ok, r1.namesSame], [true, true])
            fs.writeFileSync(path.resolve(fdOutX, 'zz_extra.json'), '{}', 'utf8')
            let r2 = await rc(cfgU, { mode: 'write', fdOut: fdOutX, fdReport: fdReportX, limit: 3 })
            assert.deepStrictEqual([r2.complete, r2.nFailures, r2.namesSame, r2.ok], [true, 0, false, false]) //C6 輸出夾之檔須皆屬journal已記者
            //本次所選之輸出檔於執行中被刪(他行程所為之模擬; 末次進度回呼時刪除)
            let fdOutD = path.resolve(fdTmp, 'out-ns-del')
            let r3 = await rc(cfgU, {
                mode: 'write',
                fdOut: fdOutD,
                fdReport: path.resolve(fdTmp, 'rep-ns-del'),
                limit: 3,
                onProgress: (p) => {
                    if (p.i === p.n) {
                        fs.rmSync(path.resolve(fdOutD, fns[0]), { force: true })
                    }
                },
            })
            assert.deepStrictEqual([r3.complete, r3.nFailures, r3.namesSame, r3.ok], [true, 0, false, false]) //C6 須涵蓋本次所選
        })

        it('C6 來源檔於兩次執行之間被改動(修改時刻改變)者, 續跑時重做(仍經忠實重放); 未改動者略過', async function() {
            let fd = copyLib(path.resolve(fdTmp, 'lib-src'))
            let fdOutC = path.resolve(fdTmp, 'out-src')
            let fdReport = path.resolve(fdTmp, 'rep-src')
            let r1 = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutC, fdReport })
            assert.strictEqual(r1.ok, true)
            let js = fs.readFileSync(path.resolve(fdReport, 'journal_write.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l))
            let st0 = fs.statSync(path.resolve(fd, fns[0]))
            assert.deepStrictEqual([js.find((e) => e.fn === fns[0]).srcBytes, js.find((e) => e.fn === fns[0]).srcMtimeMs], [st0.size, st0.mtimeMs]) //C6 journal記來源檔之大小與修改時刻
            let tOld = new Date(Date.now() - 3600000)
            fs.utimesSync(path.resolve(fd, fns[0]), tOld, tOld) //只改修改時刻(內容不變)
            let snapS = snapshot(fd)
            let r2 = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutC, fdReport })
            assert.deepStrictEqual([r2.nRedo, r2.nRun, r2.nFromJournal, r2.ok, r2.namesSame], [1, 1, fns.length - 1, true, true]) //C6 來源已變者重做
            assert.deepStrictEqual(maskTime(readJ(fdOutC, fns[0])), maskTime(readJ(fdOut, fns[0])))
            assert.deepStrictEqual(snapshot(fd), snapS) //C10 來源夾逐位不變
            //來源夾少了一檔後之全庫續跑: 輸出夾多出之檔雖為journal已記者, 檔數與來源不同 ⇒ namesSame為false
            fs.rmSync(path.resolve(fd, fns[fns.length - 1]))
            let r3 = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutC, fdReport })
            assert.deepStrictEqual([r3.complete, r3.nFailures, r3.namesSame, r3.ok], [true, 0, false, false]) //C6 全庫時檔名集合須相同
        })

    })

    it('C9 目標uIni小於最大持倉名義(單一策略不設門檻): write照常完成全部檔, 只統計超過uIni之隻數與最大者並列清單', async function() {
        let before = snapshot(fdLib)
        let fdOut = path.resolve(fdTmp, 'out-tiny')
        let fdReport = path.resolve(fdTmp, 'rep-tiny')
        let r = await rc(cfgU, { mode: 'write', fdOut, uIni: 1, fdReport })
        assert.strictEqual(r.ok, true) //C9 不中止
        assert.strictEqual(r.aborted, false)
        assert.deepStrictEqual(r.counts, { ok: fns.length })
        assert.strictEqual(r.nFailures, 0) //C9 不列為不合格
        assert.deepStrictEqual(listJson(fdOut), fns) //C9 不剔除
        let us = fns.map((fn) => readJ(fdOut, fn).summary.uTradeAllMax)
        let ns = fns.map((fn) => readJ(fdOut, fn).summary.numTradeAllMax)
        assert.ok(us.every((u) => u > 1), '前提: 全部之最大持倉名義大於uIni')
        assert.deepStrictEqual([r.overUIni.uIni, r.overUIni.n, r.overUIni.maxUTradeAllMax, r.overUIni.maxUnits], [1, fns.length, Math.max(...us), Math.max(...ns)]) //C9 隻數、最大者、最大單位數
        assert.deepStrictEqual(r.overUIni.top.map((x) => x.uTradeAllMax), [...us].sort((a, b) => b - a).slice(0, 50)) //C9 由大至小
        let full = JSON.parse(fs.readFileSync(path.resolve(fdReport, 'overUIni_write.json'), 'utf8'))
        assert.strictEqual(full.length, fns.length) //C9 全部清單
        assert.ok(full.every((x) => fns.includes(x.fn) && Number.isInteger(x.units)))
        assert.deepStrictEqual([r.unitsMaxAfter.n, r.unitsMaxAfter.max], [fns.length, Math.max(...ns)])
        assert.deepStrictEqual(snapshot(fdLib), before) //C10
        //每單2單位時: 同時持倉之單位數 = 同時持倉筆數 × 2
        let r2 = await rc(cfgU, { mode: 'dry', uIni: 1, unit: { ...unitR, units: 2 }, fdReport: path.resolve(fdTmp, 'rep-tiny-u2') })
        assert.strictEqual(r2.overUIni.maxUnits, 2 * Math.max(...ns)) //C9 單位數
        //最大單位數為最大者(非高分位): 單位數最大之一隻只放1份、其餘較小者各放3份(另名), 使分布之p95小於最大
        let nMax = Math.max(...ns)
        let iMax = ns.indexOf(nMax)
        let small = fns.filter((fn, i) => ns[i] < nMax)
        assert.ok(small.length >= 1, '鑑別前提: 有單位數小於最大者之策略')
        let fdP = path.resolve(fdTmp, 'lib-p95')
        fs.mkdirSync(fdP, { recursive: true })
        fs.copyFileSync(path.resolve(fdLib, fns[iMax]), path.resolve(fdP, fns[iMax]))
        let want = [nMax]
        for (let fn of small) {
            for (let k = 0; k < 3; k++) {
                fs.copyFileSync(path.resolve(fdLib, fn), path.resolve(fdP, `${fn.replace(/\.json$/, '')}_d${k}.json`))
                want.push(ns[fns.indexOf(fn)])
            }
        }
        assert.ok(want.length >= 11 && quantilesOf(want).p95 < nMax, `鑑別前提: p95(${quantilesOf(want).p95})小於最大(${nMax})`)
        let r3 = await rc(cfgU, { mode: 'dry', fdIn: fdP, uIni: 1, fdReport: path.resolve(fdTmp, 'rep-p95') })
        assert.deepStrictEqual([r3.overUIni.maxUnits, r3.unitsMaxAfter.max, r3.unitsMaxAfter.n], [nMax, nMax, want.length]) //C9 最大單位數取最大者
    })

    describe('C10 寫出之安全(每案皆拒且原策略庫逐位不變)', function() {

        let fdS = null

        before(function() {
            fdS = copyLib(path.resolve(fdTmp, 'lib-safe'))
        })

        it('fdOut與fdIn為同一路徑(含..之寫法)即拒(訊息不帶路徑V20), 且未建立fdReport', async function() {
            let fdReport = path.resolve(fdTmp, 'rep-safe-same')
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: fdS, fdReport }, (e) => /同一夾/.test(e.message) && !e.message.includes(fdS) && !e.message.includes(fdReport), fdS)
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: path.join(fdS, '..', path.basename(fdS)), fdReport }, /同一夾/, fdS)
            assert.strictEqual(fs.existsSync(fdReport), false)
        })

        it('fdOut為fdIn之大小寫別名即拒(Windows)', async function() {
            if (process.platform !== 'win32') {
                this.skip()
            }
            let alt = path.join(path.dirname(fdS), path.basename(fdS).toUpperCase())
            assert.notStrictEqual(alt, fdS)
            assert.ok(fs.existsSync(alt), '前提: 檔案系統不分大小寫')
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: alt, fdReport: path.resolve(fdTmp, 'rep-safe-case') }, /同一夾/, fdS)
        })

        it('fdOut為指向fdIn之目錄連結(或其下尚不存在之子夾)即拒', async function() {
            let link = path.resolve(fdTmp, 'link-safe')
            fs.symlinkSync(fdS, link, process.platform === 'win32' ? 'junction' : 'dir')
            links.push(link)
            try {
                assert.deepStrictEqual(listJson(link), listJson(fdS), '前提: 連結指向fdIn')
                await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: link, fdReport: path.resolve(fdTmp, 'rep-safe-link') }, /同一夾/, fdS)
                await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: path.resolve(link, 'sub'), fdReport: path.resolve(fdTmp, 'rep-safe-link2') }, /上下層/, fdS)
                await rejectsKeep(cfgU, { mode: 'write', fdIn: link, fdOut: fdS, fdReport: path.resolve(fdTmp, 'rep-safe-link3') }, /同一夾/, fdS)
            }
            finally {
                removeLink(link)
                links = links.filter((l) => l !== link)
            }
            assert.deepStrictEqual(listJson(fdS), fns, '拆連結後fdIn完好')
        })

        it('fdOut位於fdIn之內即拒', async function() {
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: path.resolve(fdS, 'out'), fdReport: path.resolve(fdTmp, 'rep-safe-in') }, /上下層/, fdS)
            assert.strictEqual(fs.existsSync(path.resolve(fdS, 'out')), false)
        })

        it('fdOut為fdIn之上層即拒', async function() {
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: path.dirname(fdS), fdReport: path.resolve(fdTmp, 'rep-safe-up') }, /上下層/, fdS)
        })

        it('fdReport等於或位於fdIn之內即拒(verify亦檢)', async function() {
            let fdOut = path.resolve(fdTmp, 'out-safe-rep')
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut, fdReport: fdS }, /fdReport/, fdS)
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut, fdReport: path.resolve(fdS, 'meta') }, /fdReport/, fdS)
            await rejectsKeep(base, { mode: 'verify', fdIn: fdS, fdReport: path.resolve(fdS, 'meta') }, /fdReport/, fdS)
            await rejectsKeep(cfgU, { mode: 'dry', fdIn: fdS, fdReport: fdS }, /fdReport/, fdS)
            assert.strictEqual(fs.existsSync(fdOut), false)
        })

        it('fdReport等於或位於fdOut之內即拒', async function() {
            let fdOut = path.resolve(fdTmp, 'out-safe-rep2')
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut, fdReport: fdOut }, /fdReport/, fdS)
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut, fdReport: path.resolve(fdOut, 'meta') }, /fdReport/, fdS)
            assert.strictEqual(fs.existsSync(fdOut), false)
        })

        it('首次執行時fdOut已含*.json即拒(resume:false亦同), fdOut之既有檔不變', async function() {
            let fdOut = path.resolve(fdTmp, 'out-safe-nonempty')
            fs.mkdirSync(fdOut, { recursive: true })
            fs.writeFileSync(path.resolve(fdOut, 'keep.json'), '{"a":1}', 'utf8')
            let snapOut = snapshot(fdOut)
            let fdReport = path.resolve(fdTmp, 'rep-safe-nonempty')
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut, fdReport }, /已含\*\.json/, fdS)
            assert.deepStrictEqual(snapshot(fdOut), snapOut)
            assert.strictEqual(fs.existsSync(path.resolve(fdReport, 'report_write.json')), false) //起跑前之檢核失敗不寫報告
            assert.strictEqual(fs.existsSync(path.resolve(fdReport, 'recompute.lock')), false)
            //已有journal而resume:false
            let fdOutB = path.resolve(fdTmp, 'out-safe-nonempty2')
            let fdReportB = path.resolve(fdTmp, 'rep-safe-nonempty2')
            let snapB = snapshot(fdS)
            let r = await rc(cfgU, { mode: 'write', fdIn: fdS, fdOut: fdOutB, fdReport: fdReportB, limit: 2 })
            assert.strictEqual(r.ok, true)
            assert.deepStrictEqual(snapshot(fdS), snapB)
            await rejectsKeep(cfgU, { mode: 'write', fdIn: fdS, fdOut: fdOutB, fdReport: fdReportB, resume: false }, /已含\*\.json/, fdS)
        })

        it('建立fdOut之後再核一次: 續跑時fdOut於檢查之後被換成指向fdIn之目錄連結(先查後做)即拒, 未寫入任何檔, 原策略庫逐位不變', async function() {
            let fdOutJ = path.resolve(fdTmp, 'out-safe-toctou')
            let fdMoved = path.resolve(fdTmp, 'out-safe-toctou-moved')
            let fdReport = path.resolve(fdTmp, 'rep-safe-toctou')
            let r1 = await rc(cfgU, { mode: 'write', fdIn: fdS, fdOut: fdOutJ, fdReport, limit: 2 })
            assert.strictEqual(r1.ok, true)
            let before = snapshot(fdS)
            let made = false
            try {
                await assert.rejects(recomputeStrategies(cfgU, { mode: 'write', fdIn: fdS, fdOut: fdOutJ, fdReport, takeLimit: 2 }, {
                    hooks: {
                        beforeEnsureFdOut: () => {
                            fs.renameSync(fdOutJ, fdMoved)
                            fs.symlinkSync(fdS, fdOutJ, process.platform === 'win32' ? 'junction' : 'dir')
                            links.push(fdOutJ)
                            made = true
                        },
                    },
                }), /同一夾/)
            }
            finally {
                if (made) {
                    removeLink(fdOutJ)
                    links = links.filter((l) => l !== fdOutJ)
                    fs.renameSync(fdMoved, fdOutJ)
                }
            }
            assert.ok(made, '前提: 鉤子已把fdOut換成連結')
            assert.deepStrictEqual(snapshot(fdS), before) //C10
            assert.strictEqual(fs.existsSync(path.resolve(fdReport, 'recompute.lock')), false)
        })

        it('實體路徑取不到(realpath拋錯)即拒絕執行並說明, 不建立任何夾', async function() {
            let depsE = {
                realpath: () => {
                    let e = new Error('simulated')
                    e.code = 'EISDIR'
                    throw e
                },
            }
            let fdOut = path.resolve(fdTmp, 'out-safe-realpath')
            let fdReport = path.resolve(fdTmp, 'rep-safe-realpath')
            let before = snapshot(fdS)
            await assert.rejects(recomputeStrategies(cfgU, { mode: 'write', fdIn: fdS, fdOut, fdReport, takeLimit: 2 }, { pathDeps: depsE }), (e) => /無法取得.*之實體路徑\(EISDIR\)/.test(e.message) && !e.message.includes(fdOut) && !e.message.includes('simulated')) //V20 只帶錯誤碼, 不帶路徑與原生訊息
            assert.deepStrictEqual(snapshot(fdS), before)
            assert.deepStrictEqual([fs.existsSync(fdOut), fs.existsSync(fdReport)], [false, false])
        })

    })

    describe('C10 別名之判定法(pathRelation)', function() {

        let fdA = null
        let fdB = null
        let link = null

        before(function() {
            fdA = path.resolve(fdTmp, 'pr-a')
            fdB = path.resolve(fdTmp, 'pr-a_bu')
            fs.mkdirSync(fdA, { recursive: true })
            fs.mkdirSync(fdB, { recursive: true })
            fs.writeFileSync(path.resolve(fdA, 'x.json'), '{}', 'utf8')
            link = path.resolve(fdTmp, 'pr-link')
            fs.symlinkSync(fdA, link, process.platform === 'win32' ? 'junction' : 'dir')
            links.push(link)
        })

        after(function() {
            removeLink(link)
            links = links.filter((l) => l !== link)
            assert.ok(fs.existsSync(path.resolve(fdA, 'x.json')), '拆連結後目標完好')
        })

        it('同一夾之寫法(..、尾端斜線、大小寫與磁碟機代號大小寫〔Windows〕)皆為same; 名稱互為前綴之兩夾無關係; 上下層', function() {
            assert.strictEqual(relationOf(fdA, path.join(fdA, 'x', '..')), 'same')
            assert.strictEqual(relationOf(fdA, fdA + path.sep), 'same')
            if (process.platform === 'win32') {
                assert.strictEqual(relationOf(fdA, path.join(path.dirname(fdA), path.basename(fdA).toUpperCase())), 'same')
                let dl = fdA[0] === fdA[0].toUpperCase() ? fdA[0].toLowerCase() : fdA[0].toUpperCase()
                assert.strictEqual(relationOf(fdA, dl + fdA.slice(1)), 'same')
            }
            assert.deepStrictEqual([relationOf(fdA, fdB), relationOf(fdB, fdA)], [null, null]) //名稱互為前綴(pr-a 與 pr-a_bu)
            assert.deepStrictEqual([relationOf(path.resolve(fdA, 'sub', 'y'), fdA), relationOf(fdA, path.resolve(fdA, 'sub'))], ['aInB', 'bInA'])
        })

        it('只用正規路徑(停用目錄本體之比對): 目錄連結之別名與其下尚不存在之子夾仍判得出', function() {
            let deps = {
                stat: () => {
                    throw new Error('disabled')
                },
            }
            assert.strictEqual(idOf(link, deps), null, '前提: 目錄本體之比對已停用')
            assert.strictEqual(relationOf(link, fdA, deps), 'same')
            assert.strictEqual(relationOf(path.resolve(link, 'sub'), fdA, deps), 'aInB')
        })

        it('只用目錄本體(停用實體路徑之解析): 目錄連結之別名與其下尚不存在之子夾仍判得出', function() {
            let deps = { realpath: (p) => p }
            assert.notStrictEqual(canonOf(link, deps), canonOf(fdA, deps), '前提: 正規路徑已無法解析連結')
            assert.strictEqual(relationOf(link, fdA, deps), 'same')
            assert.strictEqual(relationOf(path.resolve(link, 'sub'), fdA, deps), 'aInB')
        })

        it('檔案識別為0者不以識別比對(不因此把兩個不同之夾判為同一夾)', function() {
            let deps = {
                stat: (p) => ({ dev: fs.statSync(p, { bigint: true }).dev, ino: 0n }),
            }
            assert.strictEqual(idOf(fdA, deps), null)
            assert.strictEqual(relationOf(fdA, fdB, deps), null)
            assert.strictEqual(relationOf(link, fdA, deps), 'same') //正規路徑仍判得出別名
        })

        it('實體路徑取不到即throw(不退回字串比較)', function() {
            let deps = {
                realpath: () => {
                    let e = new Error('simulated')
                    e.code = 'EISDIR'
                    throw e
                },
            }
            assert.throws(() => relationOf(fdA, fdB, deps), /無法取得.*之實體路徑\(EISDIR\)/)
        })

    })

    describe('C11 鎖檔', function() {

        let fdPack = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
        let pidDead = null
        let nLock = 0
        let newRep = () => {
            let fd = path.resolve(fdTmp, `rep-lock-${nLock++}`)
            fs.mkdirSync(fd, { recursive: true })
            return fd
        }
        let fpLockOf = (fd) => path.resolve(fd, 'recompute.lock')
        let old = () => new Date(Date.now() - 600000)
        //leftovers, 取鎖過程之暫存檔(.tmp)與接手殘留鎖之保護檔(.takeover)皆不得留下
        let leftovers = (fd) => fs.readdirSync(fd).filter((f) => f.endsWith('.tmp') || f.endsWith('.takeover'))
        //race, n個子行程於同一時刻取同一fdReport之鎖, 取得者持有holdMs
        let race = (fd, n, holdMs) => {
            let startAt = Date.now() + 2500
            return Promise.all([...Array(n)].map(() => new Promise((resolve) => {
                let cp = spawn(process.execPath, [path.join(fdPack, 'test', 'tools', 'lockChild.mjs'), fd, String(startAt), String(holdMs)], { cwd: fdPack, windowsHide: true })
                let out = ''
                cp.stdout.on('data', (b) => {
                    out += b
                })
                cp.on('close', () => {
                    resolve(JSON.parse(out.trim().split('\n').pop()))
                })
            })))
        }

        before(function() {
            let child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true })
            pidDead = Number(child.stdout)
            assert.ok(Number.isInteger(pidDead) && pidDead > 0)
        })

        it('鎖檔之行程仍在即拒(不動鎖檔, 訊息附鎖檔名與處置、不帶路徑V20); 行程已不存在者接手; 結束後釋放', async function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            let held = JSON.stringify({ pid: process.pid, token: 't', mode: 'write', at: 'x' })
            fs.writeFileSync(fpLock, held, 'utf8')
            await assert.rejects(rc(base, { mode: 'verify', fdReport }), (err) => /正由另一個重算行程\(pid \d+\)使用/.test(err.message) && err.message.includes('recompute.lock') && !err.message.includes(fdReport) && /手動刪除該鎖檔/.test(err.message))
            assert.strictEqual(fs.readFileSync(fpLock, 'utf8'), held) //不動他人之鎖檔
            assert.strictEqual(fs.existsSync(path.resolve(fdReport, 'journal_verify.jsonl')), false)
            fs.writeFileSync(fpLock, JSON.stringify({ pid: pidDead, token: 't', mode: 'write', at: 'x' }), 'utf8')
            let r = await rc(base, { mode: 'verify', fdReport, limit: 2 })
            assert.deepStrictEqual([r.ok, r.staleLock], [true, true]) //C11 殘留接手
            assert.strictEqual(fs.existsSync(fpLock), false) //C11 釋放
            assert.deepStrictEqual(leftovers(fdReport), [])
        })

        it('內容無法讀出(空檔或壞內容)之鎖檔: 修改時刻很新即視為使用中而拒; 修改時刻已久才視為殘留而接手', function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            for (let raw of ['', 'x{']) {
                fs.writeFileSync(fpLock, raw, 'utf8')
                assert.throws(() => acquireRecomputeLock(fdReport), /正由另一個重算行程使用\(內容無法讀出且修改時刻在\d+秒內\)/) //C11 新者視為使用中
                assert.strictEqual(fs.readFileSync(fpLock, 'utf8'), raw)
                fs.utimesSync(fpLock, old(), old())
                let lock = acquireRecomputeLock(fdReport)
                assert.strictEqual(lock.staleLock, true) //C11 舊者視為殘留
                assert.strictEqual(JSON.parse(fs.readFileSync(fpLock, 'utf8')).token, lock.token) //新鎖一出現即有完整內容
                assert.strictEqual(releaseRecomputeLock(lock), true)
                assert.strictEqual(fs.existsSync(fpLock), false)
            }
            assert.deepStrictEqual(leftovers(fdReport), [])
        })

        it('釋放只刪自己之鎖(token不同即不刪)', function() {
            let fdReport = newRep()
            let lock = acquireRecomputeLock(fdReport)
            assert.strictEqual(releaseRecomputeLock({ ...lock, token: 'other' }), false)
            assert.ok(fs.existsSync(lock.fpLock))
            assert.strictEqual(releaseRecomputeLock(lock), true)
        })

        it('接手殘留鎖之競態: 判定殘留之後、取保護檔之前他行程已先接手並建立新鎖 ⇒ 本次核對鎖檔已非所判定之殘留鎖而拒; 他行程之鎖全程完好', function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            fs.writeFileSync(fpLock, JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' }), 'utf8')
            let lockA = null
            assert.throws(() => acquireRecomputeLock(fdReport, {}, {
                beforeTakeover: () => {
                    lockA = acquireRecomputeLock(fdReport) //模擬他行程先接手(同一殘留鎖)
                },
            }), /他行程已先接手殘留鎖檔/)
            assert.ok(lockA && lockA.staleLock, '前提: 他行程已接手')
            assert.strictEqual(JSON.parse(fs.readFileSync(fpLock, 'utf8')).token, lockA.token) //C11 他行程之鎖完好
            assert.deepStrictEqual(leftovers(fdReport), [])
            assert.strictEqual(releaseRecomputeLock(lockA), true)
            assert.strictEqual(fs.existsSync(fpLock), false)
        })

        it('接手殘留鎖時鎖檔全程存在(以暫存檔改名覆蓋, 不先移走), 且保護檔使同時接手者只有一個進入: 持有保護檔期間他行程之建立與接手皆拒', function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            let rawStale = JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' })
            fs.writeFileSync(fpLock, rawStale, 'utf8')
            let seen = null
            let lock = acquireRecomputeLock(fdReport, {}, {
                beforeReplace: () => {
                    seen = {
                        exists: fs.existsSync(fpLock), //C11 覆蓋前鎖檔仍在(他行程之建立不會成功)
                        raw: fs.readFileSync(fpLock, 'utf8'),
                        guard: fs.existsSync(path.resolve(fdReport, 'recompute.lock.takeover')),
                        tmp: fs.readdirSync(fdReport).some((f) => f.endsWith('.tmp')), //新鎖之內容已先寫入暫存檔(改名覆蓋之前)
                    }
                    assert.throws(() => acquireRecomputeLock(fdReport), /他行程正接手殘留鎖檔/) //C11 他行程亦欲接手 ⇒ 保護檔已存在而拒
                    assert.strictEqual(fs.readFileSync(fpLock, 'utf8'), rawStale) //拒者不動鎖檔
                },
            })
            assert.deepStrictEqual(seen, { exists: true, raw: rawStale, guard: true, tmp: true })
            assert.strictEqual(lock.staleLock, true)
            assert.strictEqual(JSON.parse(fs.readFileSync(fpLock, 'utf8')).token, lock.token) //新鎖已覆蓋
            assert.deepStrictEqual(leftovers(fdReport), []) //保護檔與暫存檔皆不留
            assert.strictEqual(releaseRecomputeLock(lock), true)
        })

        it('接手殘留鎖: 保護檔已存在(他行程正接手, 或當機所遺)即拒, 鎖檔與保護檔皆不動(偏安全, 訊息附處置)', function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            let fpGuard = path.resolve(fdReport, 'recompute.lock.takeover')
            let rawStale = JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' })
            fs.writeFileSync(fpLock, rawStale, 'utf8')
            fs.writeFileSync(fpGuard, 'g', 'utf8')
            assert.throws(() => acquireRecomputeLock(fdReport), (e) => /他行程正接手殘留鎖檔\(保護檔recompute\.lock\.takeover已存在/.test(e.message) && /手動刪除該保護檔/.test(e.message) && !e.message.includes(fdReport))
            assert.deepStrictEqual([fs.readFileSync(fpLock, 'utf8'), fs.readFileSync(fpGuard, 'utf8')], [rawStale, 'g'])
            fs.rmSync(fpGuard)
            let lock = acquireRecomputeLock(fdReport) //處置後可接手
            assert.strictEqual(lock.staleLock, true)
            assert.strictEqual(releaseRecomputeLock(lock), true)
        })

        it('接手殘留鎖: 判定之後鎖檔被移除(他行程釋放或手動刪除) ⇒ 以原子建立取得(staleLock); 他行程於其間已建立新鎖 ⇒ 拒', function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            fs.writeFileSync(fpLock, JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' }), 'utf8')
            let lock = acquireRecomputeLock(fdReport, {}, {
                beforeTakeover: () => {
                    fs.rmSync(fpLock)
                },
            })
            assert.strictEqual(lock.staleLock, true)
            assert.strictEqual(JSON.parse(fs.readFileSync(fpLock, 'utf8')).token, lock.token)
            assert.strictEqual(releaseRecomputeLock(lock), true)
            //移除之後他行程已建立新鎖
            fs.writeFileSync(fpLock, JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' }), 'utf8')
            let held = JSON.stringify({ pid: process.pid, token: 'other', at: 'x' })
            assert.throws(() => acquireRecomputeLock(fdReport, {}, {
                beforeTakeover: () => {
                    fs.writeFileSync(fpLock, held, 'utf8')
                },
            }), /他行程已先接手殘留鎖檔/) //鎖檔已為他行程之新鎖(pid仍在)
            assert.strictEqual(fs.readFileSync(fpLock, 'utf8'), held)
            fs.rmSync(fpLock)
            assert.deepStrictEqual(leftovers(fdReport), [])
        })

        it('鎖檔無法讀取(如其位置為資料夾)即視為使用中而拒, 不接手', function() {
            let fdReport = newRep()
            let fpLock = fpLockOf(fdReport)
            fs.mkdirSync(fpLock)
            assert.throws(() => acquireRecomputeLock(fdReport), /正由另一個重算行程使用\(鎖檔無法讀取\)/)
            assert.ok(fs.statSync(fpLock).isDirectory())
            fs.rmdirSync(fpLock)
            assert.deepStrictEqual(leftovers(fdReport), [])
        })

        it('多個子行程同時建立鎖檔: 恰一個取得, 其餘皆拒; 不留暫存檔', async function() {
            let fdReport = newRep()
            let rs = await race(fdReport, 6, 3000)
            assert.strictEqual(rs.filter((x) => x.got).length, 1, JSON.stringify(rs)) //C11
            assert.ok(rs.filter((x) => !x.got).every((x) => /正由另一個重算行程/.test(x.err)), JSON.stringify(rs))
            assert.deepStrictEqual(rs.filter((x) => x.got).map((x) => [x.staleLock, x.released]), [[false, true]])
            assert.strictEqual(fs.existsSync(fpLockOf(fdReport)), false)
            assert.deepStrictEqual(leftovers(fdReport), [])
        })

        it('多個子行程同時接手同一殘留鎖: 恰一個取得(staleLock恆為true, 因鎖檔全程存在而不會被他行程搶先建立), 其餘皆拒; 不留暫存檔與保護檔', async function() {
            let fdReport = newRep()
            fs.writeFileSync(fpLockOf(fdReport), JSON.stringify({ pid: pidDead, token: 'stale', at: 'x' }), 'utf8')
            let rs = await race(fdReport, 6, 3000)
            assert.strictEqual(rs.filter((x) => x.got).length, 1, JSON.stringify(rs)) //C11
            assert.deepStrictEqual(rs.filter((x) => x.got).map((x) => [x.staleLock, x.released]), [[true, true]])
            assert.ok(rs.filter((x) => !x.got).every((x) => /正由另一個重算行程/.test(x.err)), JSON.stringify(rs))
            assert.strictEqual(fs.existsSync(fpLockOf(fdReport)), false)
            assert.deepStrictEqual(leftovers(fdReport), [])
        })

    })

    it('C12/C10 寫出途中例外: 寫部分報告(crashed)後拋出並釋放鎖檔; 原庫不變; 排除後續跑清除殘留暫存檔並完成', async function() {
        let before = snapshot(fdLib)
        let fdOutC = path.resolve(fdTmp, 'out-crash')
        let fdReport = path.resolve(fdTmp, 'rep-crash')
        let r1 = await rc(cfgU, { mode: 'write', fdOut: fdOutC, fdReport, limit: 1 })
        assert.strictEqual(r1.ok, true)
        //以同名子夾擋住第2檔之改名(暫存檔寫完而改名失敗)
        let fpBlock = path.resolve(fdOutC, fns[1])
        fs.mkdirSync(fpBlock)
        fs.writeFileSync(path.resolve(fpBlock, 'keep.txt'), 'x', 'utf8')
        await assert.rejects(rc(cfgU, { mode: 'write', fdOut: fdOutC, fdReport }))
        let rep = JSON.parse(fs.readFileSync(path.resolve(fdReport, 'report_write.json'), 'utf8'))
        assert.ok(typeof rep.crashed === 'string' && rep.crashed.length > 0, 'C12 標crashed')
        assert.deepStrictEqual([rep.complete, rep.ok], [false, false])
        assert.strictEqual(fs.existsSync(path.resolve(fdReport, 'recompute.lock')), false) //C11 例外亦釋放
        assert.ok(fs.existsSync(path.resolve(fdOutC, `${fns[1]}.tmp-recompute`)), '前提: 留有暫存檔')
        assert.deepStrictEqual(snapshot(fdLib), before) //C10
        fs.rmSync(fpBlock, { recursive: true, force: true })
        fs.writeFileSync(path.resolve(fdOutC, 'zz_orphan.json.tmp-recompute'), 'x', 'utf8') //不會被重寫之殘留暫存檔(須由開始時之清除移除)
        let r2 = await rc(cfgU, { mode: 'write', fdOut: fdOutC, fdReport })
        assert.deepStrictEqual([r2.ok, r2.namesSame, r2.crashed], [true, true, null])
        assert.deepStrictEqual(fs.readdirSync(fdOutC).sort(), fns) //C10 殘留暫存檔已清除
        assert.deepStrictEqual(snapshot(fdLib), before) //C10 續跑後原庫亦不變
    })

    it('C13 檔名與檔內交易次數級距不一致之舊檔: 只列nameMismatch(不擋), 輸出沿用原檔名; onProgress拋錯只計數不中斷', async function() {
        let fd = copyLib(path.resolve(fdTmp, 'lib-nm'))
        let fnBad = `${fns[0].split('_')[0]}_0_namemismatch.json`
        fs.copyFileSync(path.resolve(fd, fns[0]), path.resolve(fd, fnBad))
        let before = snapshot(fd)
        let onProgressBoom = () => {
            throw new Error('progress boom')
        }
        let r = await rc(base, { mode: 'verify', fdIn: fd, fdReport: path.resolve(fdTmp, 'rep-nm'), onProgress: onProgressBoom })
        assert.deepStrictEqual([r.ok, r.nFailures, r.counts.ok], [true, 0, fns.length + 1])
        assert.deepStrictEqual(r.nameMismatch, { n: 1, list: [fnBad] })
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(fdTmp, 'rep-nm', 'nameMismatch_verify.json'), 'utf8')), [fnBad])
        assert.ok(r.progressErrors >= 1, 'C13 onProgress拋錯計數')
        let fdOutN = path.resolve(fdTmp, 'out-nm')
        let rw = await rc(cfgU, { mode: 'write', fdIn: fd, fdOut: fdOutN, fdReport: path.resolve(fdTmp, 'rep-nm-w') })
        assert.deepStrictEqual([rw.ok, rw.namesSame, rw.nameMismatch.n], [true, true, 1])
        assert.ok(listJson(fdOutN).includes(fnBad)) //輸出沿用原檔名
        assert.deepStrictEqual(snapshot(fd), before) //C10
    })

    it('C2/V19/V20 選項檢核: write未給fdOut、dry無目標unit、mode無效、files無效或含不存在者、unit無效、takeLimit與limit非整數、write關閉stopOnError、thEqYr非有效數字、uIni非有效正數皆throw(V19格式, 訊息不含輸入值)', async function() {
        let fdReport = path.resolve(fdTmp, 'rep-x')
        await assert.rejects(rc(cfgU, { mode: 'write', fdReport }), (e) => e.message.startsWith('invalid opt.fdOut: must be a folder path string when mode is write'))
        await assert.rejects(rc(cfgU, { mode: 'write', fdOut: 123, fdReport }), /^Error: invalid opt\.fdOut: must be/)
        await assert.rejects(rc(base, { mode: 'dry', fdReport }), (e) => e.message.startsWith('invalid opt.unit: must be an object when mode is dry or write'))
        let secret = 'ZZ-secret-9731'
        await assert.rejects(rc(base, { mode: secret, fdReport }), (e) => e.message === `invalid opt.mode: must be one of 'verify', 'dry', 'write'` && !e.message.includes('ZZ-secret'))
        await assert.rejects(rc(base, { mode: 'verify', files: [`${secret}.json`], fdReport }), (e) => e.message === 'invalid opt.files: must be file names that exist in fdIn')
        await assert.rejects(rc(base, { mode: 'verify', fdIn: path.resolve(fdTmp, `${secret}-none`), fdReport }), (e) => e.message === 'invalid opt.fdIn: must be an existing folder')
        await assert.rejects(rc(cfgU, { mode: 'dry', unit: { rule: ruleR, units: 0 }, fdReport }), (e) => e.message === 'invalid opt.unit.units: must be a positive integer')
        for (let tl of [0, -1, 1.5, '2x', '1.5', '0', '', ' ', true, null, NaN, {}]) {
            await assert.rejects(rc(base, { mode: 'verify', takeLimit: tl, fdReport }), (e) => e.message === 'invalid opt.takeLimit: must be a positive integer', String(tl))
        }
        for (let lm of ['200x', '1.5', '-1', -1, 1.5, '', ' ', true, null, NaN]) {
            await assert.rejects(rc(base, { mode: 'verify', limit: lm, fdReport }), (e) => e.message === 'invalid opt.limit: must be a non-negative integer', String(lm)) //打錯不得默默改跑全庫
        }
        for (let fl of [[], 'a.json', [1]]) {
            await assert.rejects(rc(base, { mode: 'verify', files: fl, fdReport }), (e) => e.message === 'invalid opt.files: must be a non-empty array of file name strings', JSON.stringify(fl))
        }
        await assert.rejects(rc(cfgU, { mode: 'write', fdOut: path.resolve(fdTmp, 'out-x'), stopOnError: false, fdReport }), /^Error: invalid opt\.stopOnError: must be true or unset when mode is write/)
        for (let th of ['0.1x', '', ' ', true, [], NaN, Infinity, {}, '0x10']) {
            await assert.rejects(rc(cfgU, { mode: 'dry', thEqYr: th, fdReport }), (e) => e.message === 'invalid opt.thEqYr: must be a valid number', String(th))
        }
        for (let ui of [secret, '', ' ', 0, -1, '-1', '0', NaN, Infinity, true, {}, []]) {
            await assert.rejects(rc(cfgU, { mode: 'dry', uIni: ui, fdReport }), (e) => e.message === 'invalid opt.uIni: must be a positive number', String(ui))
        }
        let cfgBadUIni = normalizeCfg({ ...base, settings: { ...base.settings, uIni: secret } }) //未給unit時settings原樣(不檢)
        await assert.rejects(rc(cfgBadUIni, { mode: 'dry', unit: unitR, fdReport }), (e) => e.message === 'invalid cfg.settings.uIni: must be a positive number' && !e.message.includes('ZZ-secret')) //目標取自cfg.settings時亦檢
        assert.strictEqual(fs.existsSync(path.resolve(fdTmp, 'out-x')), false)
    })

    it('C2/K4 數字字串之選項收受並轉為數值(uIni、unit之rule三欄與buffer與units、thEqYr、takeLimit、limit): 統計、journal之header與寫出之檔皆與給數值者相同', async function() {
        let before = snapshot(fdLib)
        let unitS = { rule: { ...ruleR, stepSize: '0.1', minQty: ' 0.1 ', minNotional: '5e0' }, buffer: '1e-1', units: '1' }
        let optN = { uIni: 10000, unit: unitR, thEqYr: 0.1, takeLimit: 2, limit: 3 }
        let optS = { uIni: ' 1e4 ', unit: unitS, thEqYr: '0.1', takeLimit: '2', limit: '3' }
        let fdOutN = path.resolve(fdTmp, 'out-numN')
        let fdOutS = path.resolve(fdTmp, 'out-numS')
        let rN = await rc(cfgU, { mode: 'write', fdOut: fdOutN, fdReport: path.resolve(fdTmp, 'rep-numN'), ...optN })
        let rS = await rc(cfgU, { mode: 'write', fdOut: fdOutS, fdReport: path.resolve(fdTmp, 'rep-numS'), ...optS })
        assert.deepStrictEqual([rS.ok, rS.nSelected, rS.nRun, rS.thEqYr], [true, 3, 3, 0.1])
        assert.deepStrictEqual(rS.target, { uIni: 10000, unit: unitR }) //K4 目標口徑為數值
        assert.strictEqual(typeof rS.target.uIni, 'number')
        for (let k of ['counts', 'faithful', 'diffFields', 'eqYrBefore', 'eqYrAfter', 'eqYrDelta', 'cross', 'uTradeAllMaxAfter', 'unitsMaxAfter', 'overUIni', 'nameMismatch', 'namesSame']) {
            assert.deepStrictEqual(rS[k], rN[k], k)
        }
        let hS = JSON.parse(fs.readFileSync(path.resolve(fdTmp, 'rep-numS', 'journal_write.jsonl'), 'utf8').split('\n')[0])
        assert.deepStrictEqual([hS.target, hS.thEqYr], [{ uIni: 10000, unit: unitR }, 0.1]) //K4 header記數值
        assert.deepStrictEqual(listJson(fdOutS), listJson(fdOutN))
        for (let fn of listJson(fdOutS)) {
            let w = readJ(fdOutS, fn)
            assert.deepStrictEqual(maskTime(w), maskTime(readJ(fdOutN, fn)), fn)
            assert.deepStrictEqual(w.settings.unit, unitR) //K4 檔內rule三欄、buffer、units為數值
            assert.strictEqual(w.settings.uIni, 10000)
        }
        //數字字串之uIni於cfg.settings(未給unit而由opt.unit給目標)時亦轉為數值
        let cfgStr = normalizeCfg({ ...base, settings: { ...base.settings, uIni: '10000' } })
        let rC = await rc(cfgStr, { mode: 'dry', unit: unitS, limit: 2, fdReport: path.resolve(fdTmp, 'rep-numC') })
        assert.deepStrictEqual(rC.target, { uIni: 10000, unit: unitR })
        //takeLimit之數字字串轉為數值後傳給parfor(未轉型時parfor以非整數而默默改用核數 - 1)
        let seen = []
        let spy = (url, jobs, o) => {
            seen.push(o.takeLimit)
            return parfor(url, jobs, o)
        }
        await recomputeStrategies(cfgU, { mode: 'verify', takeLimit: '2', limit: 2, fdReport: path.resolve(fdTmp, 'rep-numT1') }, { parfor: spy })
        await recomputeStrategies(cfgU, { mode: 'verify', limit: 2, fdReport: path.resolve(fdTmp, 'rep-numT2') }, { parfor: spy })
        await recomputeStrategies(cfgU, { mode: 'verify', takeLimit: 1, limit: 2, fdReport: path.resolve(fdTmp, 'rep-numT3') }, { parfor: spy })
        assert.deepStrictEqual(seen, [2, 2, 1])
        assert.deepStrictEqual(snapshot(fdLib), before) //C10
    })

    it('C4 r8之分支: 新口徑重放之交易筆數、已平倉筆數或勝率改變即r8並列欄名(以注入之回測函數觸發; 未注入者為ok)', async function() {
        let init = { fdIn: fdLib, fdOhlc: base.fds.ohlc, fdParam: base.fds.param, timeZone: base.timeZone, mode: 'dry', target: { uIni: 10000, unit: normalizeUnit(unitR, 'unit') } }
        let r0 = await createCore(init)({ fn: fns[0] })
        assert.strictEqual(r0.status, 'ok')
        let bump = (k, f) => async (ott, data, fgs) => {
            let r = await runStrategy(ott, data, fgs)
            return data.settings.unit ? { ...r, summary: { ...r.summary, [k]: f(r.summary[k]) } } : r
        }
        let r1 = await createCore(init, { runStrategy: bump('numTradeFin', (v) => v + 1) })({ fn: fns[0] })
        assert.deepStrictEqual([r1.status, r1.diffFields], ['r8', ['numTradeFin']])
        let r2 = await createCore(init, { runStrategy: bump('rWin', () => '0.01%') })({ fn: fns[0] })
        assert.deepStrictEqual([r2.status, r2.diffFields], ['r8', ['rWin']])
    })

    it('C4/C1 checkInvariant與diffSummary', function() {
        let d = readJ(fdLib, fns[0])
        let sm = d.summary
        assert.deepStrictEqual(checkInvariant(d, settingsU(d), { ...sm, uTradeAllMax: 123 }), []) //C4 名義改變不算
        assert.deepStrictEqual(checkInvariant(d, settingsU(d), { ...sm, numTradeFin: sm.numTradeFin + 1 }), ['numTradeFin'])
        assert.deepStrictEqual(checkInvariant(d, settingsU(d), { ...sm, rWin: '0.01%' }), ['rWin'])
        assert.deepStrictEqual(checkInvariant(d, settingsU(d), { ...sm, numTrade: sm.numTrade * 10 + 7 }), ['numTrade', '(fileName)']) //C4 跨級距 ⇒ 檔名改變
        assert.deepStrictEqual(diffSummary({ timeTest: 'a', x: 1, y: [1, 2] }, { timeTest: 'b', x: 1, y: [1, 3], z: 0 }), ['y', 'z']) //C1 timeTest不比、缺欄列入
        assert.deepStrictEqual(quantilesOf([3, 1, 2]), { n: 3, min: 1, p05: 1, p25: 2, p50: 2, p75: 3, p95: 3, max: 3, mean: 2 })
    })

})
