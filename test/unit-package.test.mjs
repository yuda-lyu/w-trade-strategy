import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { execFileSync, execSync } from 'child_process'
import { isBuiltin } from 'module'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'
import { mjsFilesOf, examplesOf, runExample } from './tools/jsdocExamples.mjs'


//unit-package.test.mjs — 套件結構與發布面守門:package.json、依賴對帳、按需引入、npm 打包清單、範例 g.mjs、JSDoc 覆蓋與範例實跑、發布內容去識別
//
// 【佈局】原始碼全在 src/(聚合入口 src/WTradeStrategy.mjs);套件根另有 g.mjs(範例)、toolg/(編譯與文件工具)、test/;下文路徑除註明外皆相對套件根
// ① 發布面:scripts 為 test 與 deploy;不設 exports / files / type;main 指 dist UMD;不提供 .npmignore;.gitignore 列 CLAUDE*.md、tmp、test/_tmp、node_modules 且不排除 sgud / src / dist / test/tools;根目錄範本檔齊備;LICENSE 為 MIT 且署名同作者
// ② 依賴對帳:src/ 實際 import 之 npm 套件 ⊆ dependencies ∪ { lodash-es, dayjs }(後二者由 wsemi 之依賴帶入);自有套件一律 src 深層路徑;lodash-es 單函數路徑;node 內建模組無 node: 前綴;toolg/ 只用 w-package-tools;toolg/gDistRollup.mjs 之 external 與 globals 同組、不含自有套件(列為 external 則 dist 執行失敗)、涵蓋 src 之 node 內建模組與第三方裸引用
// ③ npm 打包清單(npm pack --dry-run):含 sgud/ 四份、test/tools/ 全部檔、聚合入口、README、LICENSE、package.json、toolg/;不含 CLAUDE*.md、tmp、test/_tmp、node_modules
// ④ 範例 g.mjs 離線可直接執行(不連網、結束刪工作目錄),輸出與檔末 // => 逐行相符,README 之 Example 含 g.mjs 全文;README 之測試表列出每個測試檔
// ⑤ JSDoc:src/ 每個匯出(含 export { … } 與 export default 之宣告)皆有 JSDoc;函式另有 @param(有參數者)、@returns、@example;可離線之 @example 實跑,輸出與 // => 逐行相符(首行 need test in nodejs. 者不跑)
// ⑥ 發布內容(src、test、README、sgud、g.mjs、toolg、package.json)不含通用機敏樣式:磁碟機絕對路徑、使用者家目錄路徑、IPv4 位址、權杖與私鑰樣式(使用端之專案名 / 目錄名 / 腳本名不列於本檔, 其偵測由發布前之私有檢查負責)
// 執行:在套件根 node <mocha> test/unit-package.test.mjs(暫存 test/_tmp/package-<pid>_*,測完即刪;不連網)


let ROOT = FD_PACK.replace(/\\/g, '/')
let SELF = 'test/unit-package.test.mjs'
let read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let relOf = (fp) => path.relative(ROOT, fp).replace(/\\/g, '/')
let pkg = JSON.parse(read('package.json'))

//specifiersOf, 檔案之 import 指定詞(靜態 import / export … from / 字串常值之動態 import)
let specifiersOf = (text) => {
    let out = []
    for (let m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*(['"])([^'"\n]+)\1/g)) {
        out.push(m[2])
    }
    for (let m of text.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"\n]+)\1/g)) {
        out.push(m[2])
    }
    for (let m of text.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) {
        out.push(m[2])
    }
    return out
}
let pkgNameOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])
let bareOf = (files) => {
    let set = new Map()
    for (let f of files) {
        for (let s of specifiersOf(read(f))) {
            if (!s.startsWith('.') && !s.startsWith('/') && !/^file:/.test(s)) {
                if (!set.has(s)) {
                    set.set(s, new Set())
                }
                set.get(s).add(f)
            }
        }
    }
    return set
}
let srcFiles = () => mjsFilesOf(path.join(FD_PACK, 'src')).map(relOf)
let testFiles = () => mjsFilesOf(path.join(FD_PACK, 'test')).map(relOf).filter((f) => !f.startsWith('test/_tmp/'))

//exportsOf, 一檔之匯出名(export { a, b as c } 之對外名、export default 之識別字、export let/const/function 之名)與其宣告行之 JSDoc
let exportsOf = (text) => {
    let ls = text.replace(/\r\n/g, '\n').split('\n')
    let names = new Set()
    let defaultName = null
    for (let m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (let s of m[1].split(',')) {
            let t = s.trim()
            if (!t) {
                continue
            }
            let [orig, alias] = t.split(/\s+as\s+/)
            names.add((alias || orig).trim())
        }
    }
    let dm = /^export default ([A-Za-z_$][\w$]*)\s*$/m.exec(text)
    if (dm) {
        defaultName = dm[1]
    }
    for (let m of text.matchAll(/^export (?:let|const|function|async function) ([A-Za-z_$][\w$]*)/gm)) {
        names.add(m[1])
    }
    //宣告行與 JSDoc
    let out = []
    let want = new Set([...names, ...(defaultName ? [defaultName] : [])])
    for (let i = 0; i < ls.length; i++) {
        let m = /^(?:export )?(?:(let|const) ([A-Za-z_$][\w$]*)\s*=|(async )?function ([A-Za-z_$][\w$]*)\s*\()/.exec(ls[i])
        if (!m) {
            continue
        }
        let name = m[2] || m[4]
        if (!want.has(name)) {
            continue
        }
        let rest = ls[i].slice(m[0].length)
        let kind = m[4] ? 'function' : 'const'
        let hasParams = false
        if (m[2]) {
            let fm = /^\s*(?:async\s*)?(?:\(([^)]?)|([A-Za-z_$][\w$]*)\s*=>|function\b[^(]*\(([^)]?))/.exec(rest)
            if (fm) {
                kind = 'function'
                hasParams = !!(fm[1] || fm[2] || fm[3])
            }
        }
        else {
            hasParams = !/^\s*\)/.test(rest)
        }
        let doc = null
        if (i > 0 && ls[i - 1].trim() === '*/') {
            let j = i - 2
            while (j >= 0 && !ls[j].trim().startsWith('/**')) {
                j--
            }
            if (j >= 0) {
                doc = ls.slice(j + 1, i - 1).map((l) => l.replace(/^\s*\* ?/, '')).join('\n')
            }
        }
        out.push({ name, kind, hasParams, doc, line: i + 1, isDefault: name === defaultName && !names.has(name) })
        want.delete(name)
    }
    return { blocks: out, missing: [...want] }
}

//SENSITIVE_PATTERNS, 公開庫之通用機敏樣式(磁碟機絕對路徑 / 使用者家目錄路徑 / IPv4 位址 / 權杖與私鑰樣式)
//  只守通用樣式; 使用端之專案名 / 目錄名 / 腳本名一律不列於此(列了即把名稱公開), 其偵測由發布前之私有檢查負責
//  業務詞(量化、交易、ETHUSDT 等公開交易對)為本套件領域, 不在此列
let SENSITIVE_PATTERNS = [
    ['磁碟機絕對路徑', /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/],
    ['使用者家目錄路徑', /[\\/](?:Users|home)[\\/][A-Za-z0-9._-]+[\\/]/],
    ['IPv4 位址', /(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])/],
    ['權杖 / 私鑰樣式', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bnpm_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]
let INSTALLED = /[\\/]node_modules[\\/]/.test(ROOT)


describe('unit-package', function() {

    this.timeout(300000)

    before(function() {
        if (INSTALLED) {
            this.skip()
        }
    })

    describe('① package.json 與發布面', () => {

        it('scripts 為 test(mocha --no-parallel)與 deploy, 不增設其他指令', () => {
            assert.deepStrictEqual(Object.keys(pkg.scripts), ['test', 'deploy'])
            assert.strictEqual(pkg.scripts.test, 'mocha --no-parallel "test/*.test.mjs" --timeout 180000')
            assert.strictEqual(pkg.scripts.deploy, 'gh-pages -d docs')
        })

        it('欄位: name、semver、main 指 dist UMD、不設 exports / files / type、repository / keywords / author / license;LICENSE 為 MIT 且署名同作者', () => {
            assert.strictEqual(pkg.name, 'w-trade-strategy')
            assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
            assert.strictEqual(pkg.main, 'dist/w-trade-strategy.umd.js')
            for (let k of ['exports', 'files', 'type']) {
                assert.strictEqual(pkg[k], undefined, `不設 ${k}`)
            }
            assert.deepStrictEqual([pkg.repository.type, pkg.repository.url], ['git', 'git+https://github.com/yuda-lyu/w-trade-strategy.git'])
            assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 3 && typeof pkg.author === 'string' && pkg.author.length > 0)
            assert.strictEqual(pkg.license, 'MIT')
            let lic = read('LICENSE')
            assert.ok(lic.startsWith('MIT License') && lic.includes(`Copyright (c) 2026 ${pkg.author}`), 'LICENSE 須為 MIT 並署名作者')
        })

        it('不提供 .npmignore;.gitignore 列 CLAUDE*.md、tmp、test/_tmp、node_modules, 不排除 sgud / src / dist / test/tools', () => {
            assert.strictEqual(fs.existsSync(path.join(ROOT, '.npmignore')), false)
            let gi = read('.gitignore').split(/\r?\n/).map((l) => l.trim())
            for (let k of ['CLAUDE*.md', 'tmp', 'test/_tmp', 'node_modules']) {
                assert.ok(gi.includes(k), `.gitignore 須列 ${k}`)
            }
            assert.ok(!gi.some((l) => /^!?\/?sgud/.test(l) || l === '!CLAUDE.md'))
            assert.ok(!gi.some((l) => /^\/?(src|dist|toolg|docs)\/?$/.test(l) || /^\/?test(\/tools)?\/?$/.test(l)))
        })

        it('根目錄範本檔與 toolg/ 標準六支齊備;sgud 四檔齊備', () => {
            for (let f of ['.editorconfig', '.eslintignore', '.eslintrc.js', '.jsdoc', 'babel.config.js', 'SECURITY.md', 'LICENSE', 'README.md', 'script.txt', 'g.mjs', 'package.json']) {
                assert.ok(fs.existsSync(path.join(ROOT, f)), `套件根須有 ${f}`)
            }
            assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'toolg')).sort(), ['addVersion.mjs', 'cleanFolder.mjs', 'gDistRollup.mjs', 'gDocsExams.mjs', 'genDocsDist.mjs', 'modifyReadme.mjs'])
            let g = read('toolg/gDistRollup.mjs')
            assert.ok(g.includes('let fdSrc = \'./src\'') && g.includes('let fdTar = \'./dist\'') && g.includes('fns: \'WTradeStrategy.mjs\''))
            for (let f of ['sgud/exp/experience.md', 'sgud/proc/process.md', 'sgud/rule/rulebook.md', 'sgud/state/state.md']) {
                assert.ok(fs.existsSync(path.join(ROOT, f)), `須有 ${f}`)
            }
        })

    })

    describe('② 依賴對帳與按需引入', () => {

        it('src/ 之 npm 套件 ⊆ dependencies ∪ {lodash-es, dayjs};自有套件皆 src 深層路徑;dependencies 所列皆被 src 使用;devDependencies 只 w-package-tools', () => {
            let bare = bareOf(srcFiles())
            let pkgs = new Set([...bare.keys()].filter((s) => !isBuiltin(s)).map(pkgNameOf))
            let allowed = new Set([...Object.keys(pkg.dependencies), 'lodash-es', 'dayjs'])
            assert.deepStrictEqual([...pkgs].filter((p) => !allowed.has(p)), [], 'src 引用了未宣告之套件')
            assert.deepStrictEqual(Object.keys(pkg.dependencies).filter((p) => !pkgs.has(p)), [], 'dependencies 有未被 src 使用者')
            //wsemi 之 package.json 自套件根向上找 node_modules(套件目錄本身無 node_modules 時, 自上層目錄逐層尋找)
            let fpWsemi = null
            for (let dir = ROOT; ; dir = path.dirname(dir)) {
                let f = path.join(dir, 'node_modules', 'wsemi', 'package.json')
                if (fs.existsSync(f)) {
                    fpWsemi = f
                    break
                }
                if (path.dirname(dir) === dir) {
                    break
                }
            }
            assert.ok(fpWsemi, '前提: 可找到已安裝之 wsemi')
            let wsemi = JSON.parse(fs.readFileSync(fpWsemi, 'utf8'))
            assert.ok(wsemi.dependencies['lodash-es'] && wsemi.dependencies.dayjs, '前提: wsemi 之依賴含 lodash-es 與 dayjs')
            assert.deepStrictEqual(Object.keys(pkg.devDependencies), ['w-package-tools'])
            for (let [k, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
                assert.match(v, /^\^\d+\.\d+\.\d+$/, `${k} 之版本範圖須為 semver(^x.y.z)`)
            }
            //自有套件(w-*)與 wsemi 皆深層路徑, 不得引用套件根
            let bad = []
            for (let [s, fs_] of bare) {
                if (/^(w-[a-z-]+|wsemi)$/.test(s)) {
                    bad.push(`${s} ← ${[...fs_].join(',')}`)
                }
                if (/^(w-[a-z-]+)\//.test(s) && !/^w-[a-z-]+\/src\//.test(s)) {
                    bad.push(`${s} ← ${[...fs_].join(',')}(須 src/ 深層路徑)`)
                }
            }
            assert.deepStrictEqual(bad, [])
            let tool = bareOf(fs.readdirSync(path.join(ROOT, 'toolg')).map((f) => `toolg/${f}`))
            assert.deepStrictEqual([...new Set([...tool.keys()].map(pkgNameOf))], ['w-package-tools'])
            assert.deepStrictEqual([...bareOf(['g.mjs']).keys()], ['fs'])
            assert.doesNotThrow(() => import.meta.resolve('mocha'))
        })

        it('按需引入: lodash-es 一律單函數路徑且可解析, wsemi 一律 wsemi/src/<函數>.mjs;node 內建模組無 node: 前綴', () => {
            let bad = []
            let n = 0
            for (let [s, fs_] of bareOf(srcFiles())) {
                if (s.startsWith('lodash-es/')) {
                    n++
                    assert.ok(/^lodash-es\/[A-Za-z0-9]+\.js$/.test(s), `單函數路徑形: ${s}`)
                    assert.doesNotThrow(() => import.meta.resolve(s), `可解析: ${s}`)
                }
                if (s.startsWith('wsemi/')) {
                    assert.ok(/^wsemi\/src\/[A-Za-z0-9]+\.mjs$/.test(s), `wsemi 單函數路徑形: ${s}`)
                }
                if (s.startsWith('node:')) {
                    bad.push(`${s} ← ${[...fs_].join(',')}`)
                }
            }
            assert.deepStrictEqual(bad, [])
            assert.ok(n >= 10, `單函數路徑數過少: ${n}`)
        })

        it('dist 打包寫法(toolg/gDistRollup.mjs): external 與 globals 同組、不含自有套件 / wsemi / lodash-es(UMD 對 ESM 外部模組取得命名空間物件, 列為 external 則 dist 執行失敗), src 之 node 內建模組與第三方裸引用皆已列入', () => {
            let g = read('toolg/gDistRollup.mjs').replace(/\r\n/g, '\n').replace(/\/\/.*$/gm, '')
            let blockOf = (name, open, close) => {
                let i = g.search(new RegExp(`\\b${name}\\s*:\\s*\\${open}`))
                assert.ok(i >= 0, `gDistRollup 須有 ${name}`)
                let j = g.indexOf(close, i)
                return g.slice(i, j)
            }
            let extBlock = blockOf('external', '[', ']')
            let ext = [...extBlock.matchAll(/(['"])([^'"\n]+)\1/g)].map((m) => m[2])
            let glb = [...blockOf('globals', '{', '}').matchAll(/(['"])([^'"\n]+)\1\s*:/g)].map((m) => m[2])
            assert.ok(/^[\s,[\]]*$/.test(extBlock.replace(/^external\s*:/, '').replace(/(['"])[^'"\n]*\1/g, '')), 'external 只含字串(不含正則, 否則 globals 無法對應)')
            assert.deepStrictEqual([...ext].sort(), [...glb].sort(), 'external 與 globals 須同組')
            assert.deepStrictEqual(ext.filter((s) => /^(w-|wsemi|lodash-es)/.test(s)), [], '自有套件 / wsemi / lodash-es 須打包進 dist, 不列 external')
            let want = new Set()
            for (let [s] of bareOf(srcFiles())) {
                if (isBuiltin(s) || s.startsWith('node:')) {
                    want.add(s)
                }
                else if (!/^(w-[a-z-]+|wsemi|lodash-es)\//.test(s)) {
                    want.add(s)
                }
            }
            assert.deepStrictEqual([...want].filter((s) => !ext.includes(s)), [], 'src 之 node 內建模組與第三方裸引用須列入 external 與 globals')
            assert.ok(g.includes('runin: \'nodejs\''), 'runin 須為 nodejs')
        })

    })

    describe('③ npm 打包清單', () => {

        it('npm pack --dry-run: 含 sgud/ 四份、test/tools/ 全部檔、聚合入口、README、LICENSE、package.json、toolg/;不含 CLAUDE*.md、tmp、test/_tmp、node_modules', () => {
            let raw = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
            let parsed = JSON.parse(raw)
            let info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
            let packed = info.files.map((x) => x.path.replace(/\\/g, '/'))
            assert.ok(packed.length >= 40, `打包清單過少: ${packed.length}`)
            for (let f of ['sgud/exp/experience.md', 'sgud/proc/process.md', 'sgud/rule/rulebook.md', 'sgud/state/state.md', 'src/WTradeStrategy.mjs', 'src/createPipeline.mjs', 'README.md', 'LICENSE', 'package.json', 'g.mjs', 'toolg/gDistRollup.mjs']) {
                assert.ok(packed.includes(f), `打包清單須含 ${f}`)
            }
            let tools = fs.readdirSync(path.join(ROOT, 'test', 'tools'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `test/tools/${e.name}`)
            assert.ok(tools.length >= 3)
            for (let f of tools) {
                assert.ok(packed.includes(f), `打包清單須含 ${f}`)
            }
            assert.deepStrictEqual(packed.filter((f) => /(^|\/)CLAUDE[^/]*\.md$/.test(f)), [])
            assert.deepStrictEqual(packed.filter((f) => /^(tmp|test\/_tmp|node_modules)\//.test(f)), [])
            assert.deepStrictEqual(packed.filter((f) => /(^|\/)\.npmignore$/.test(f)), [])
        })

    })

    describe('④ 範例 g.mjs 與 README', () => {

        it('g.mjs 離線可直接執行(不連網、結束刪工作目錄), 輸出與檔末 // => 逐行相符;README 之 Example 含 g.mjs 全文', function() {
            this.timeout(240000)
            let g = read('g.mjs').replace(/\r\n/g, '\n')
            let rd = read('README.md').replace(/\r\n/g, '\n')
            assert.ok(g.length > 1500 && rd.includes(g.trimEnd()), 'README 之 Example 須含 g.mjs 全文')
            let lines = g.split('\n')
            let at = lines.findIndex((l) => l.startsWith('// => '))
            assert.ok(at > 0, 'g.mjs 檔末須附 // => 輸出')
            let want = lines.slice(at).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ => ?/, '').replace(/^\/\/ ?/, ''))
            let tmp = makeTmp('package-g')
            try {
                let out = execFileSync(process.execPath, [path.join(ROOT, 'g.mjs')], { cwd: tmp.dir, encoding: 'utf8', timeout: 200000 })
                assert.deepStrictEqual(out.replace(/\r\n/g, '\n').trimEnd().split('\n'), want)
                assert.strictEqual(fs.existsSync(path.join(tmp.dir, '_test_strategy')), false, '範例結束須清掉工作目錄')
            }
            finally {
                tmp.cleanup()
            }
        })

        it('README 之測試表列出 test/ 下每一個測試檔(unit-*.test.mjs), 且不列不存在者', () => {
            let rd = read('README.md')
            let have = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /^unit-.*\.test\.mjs$/.test(f)).map((f) => f.replace(/\.test\.mjs$/, ''))
            let i0 = rd.search(/^## \d+\. 測試/m)
            assert.ok(i0 >= 0, 'README 須有「## N. 測試」節')
            let rest = rd.slice(i0 + 1)
            let i1 = rest.search(/^## /m)
            let sec = i1 >= 0 ? rest.slice(0, i1) : rest
            let listed = [...sec.matchAll(/`(unit-[A-Za-z0-9]+)`/g)].map((m) => m[1])
            assert.deepStrictEqual(have.filter((f) => !listed.includes(f)), [], 'README 測試表漏列')
            assert.deepStrictEqual(listed.filter((f) => !have.includes(f)), [], 'README 測試表列了不存在之測試檔')
        })

    })

    describe('⑤ JSDoc 覆蓋與範例', () => {

        let blocks = null
        let getBlocks = () => {
            if (blocks) {
                return blocks
            }
            blocks = []
            for (let fp of mjsFilesOf(path.join(FD_PACK, 'src'))) {
                let { blocks: bs, missing } = exportsOf(fs.readFileSync(fp, 'utf8'))
                assert.deepStrictEqual(missing, [], `${relOf(fp)} 之匯出名找不到宣告行: ${missing.join(',')}`)
                for (let b of bs) {
                    blocks.push({ ...b, file: fp, rel: relOf(fp) })
                }
            }
            return blocks
        }

        it('src/ 每個匯出皆有 JSDoc;函式另有 @param(有參數者)、@returns、@example', () => {
            let bs = getBlocks()
            let bad = []
            for (let b of bs) {
                let where = `${b.rel}:${b.line} ${b.name}`
                if (b.doc === null || !b.doc.trim()) {
                    bad.push(`${where} 無 JSDoc`)
                    continue
                }
                if (b.kind === 'const') {
                    continue
                }
                if (b.hasParams && !/@param /.test(b.doc)) {
                    bad.push(`${where} 缺 @param`)
                }
                if (!/@returns /.test(b.doc)) {
                    bad.push(`${where} 缺 @returns`)
                }
                if (!/@example\b/.test(b.doc)) {
                    bad.push(`${where} 缺 @example`)
                }
            }
            assert.deepStrictEqual(bad, [])
            assert.ok(bs.filter((b) => b.kind === 'function').length >= 40, `函式匯出過少(掃描範圍壞了?): ${bs.filter((b) => b.kind === 'function').length}`)
            assert.ok(bs.filter((b) => b.kind === 'const').length >= 10, '常數匯出過少(掃描範圖壞了?)')
        })

        it('判準自檢: exportsOf 抓得到 export { } / export default / export let 之宣告與 JSDoc', () => {
            let t = '/**\n * d\n * @param {Number} a x\n * @returns {Number} y\n * @example\n * console.log(f(1))\n * // => 1\n */\nlet f = (a) => a\nlet g = () => 1\nlet C = 1\nexport { f, g }\nexport default C\n'
            let r = exportsOf(t)
            assert.deepStrictEqual(r.missing, [])
            assert.deepStrictEqual(r.blocks.map((b) => [b.name, b.kind, b.hasParams, b.doc !== null, b.isDefault]), [['f', 'function', true, true, false], ['g', 'function', false, false, false], ['C', 'const', false, false, true]])
            assert.deepStrictEqual(examplesOf(r.blocks[0].doc), { code: 'console.log(f(1))\n// => 1', imports: [], expected: ['1'] })
        })

        it('可離線之 @example 實跑: 子程序輸出與 // => 逐行相符(首行 need test in nodejs. 者不跑)', async function() {
            this.timeout(240000)
            let bs = getBlocks().filter((b) => b.doc && /@example\b/.test(b.doc))
            let runnable = bs.filter((b) => !/@example\s*\n\s*need test in nodejs\./.test(b.doc.replace(/\r\n/g, '\n')))
            assert.ok(runnable.length >= 15, `可實跑之範例過少: ${runnable.length}`)
            let tmp = makeTmp('package-ex')
            try {
                let fails = []
                let id = 0
                for (let b of runnable) {
                    let ex = examplesOf(b.doc)
                    if (!ex || !ex.expected.length) {
                        fails.push(`${b.rel}:${b.name} 可實跑之範例須有 // => 預期輸出`)
                        continue
                    }
                    let names = (await import(new URL(`file:///${b.file.replace(/\\/g, '/')}`).href))
                    let r = await runExample({ file: b.file, names: Object.keys(names).filter((k) => k !== 'default'), isDefault: b.isDefault, name: b.name, ex, tmpDir: tmp.dir, id: ++id })
                    if (!r.ok) {
                        fails.push(`${b.rel}:${b.name} status=${r.status} 預期 ${JSON.stringify(r.expected)} 實得 ${JSON.stringify(r.got)} ${r.stderr}`)
                    }
                }
                assert.deepStrictEqual(fails, [])
            }
            finally {
                tmp.cleanup()
            }
        })

    })

    describe('⑥ 發布內容不含通用機敏樣式', () => {

        let files = () => [
            ...srcFiles(),
            ...testFiles().filter((f) => f !== SELF),
            'README.md', 'g.mjs', 'package.json', 'script.txt',
            ...fs.readdirSync(path.join(ROOT, 'toolg')).map((f) => `toolg/${f}`),
            ...fs.readdirSync(path.join(ROOT, 'sgud'), { recursive: true }).filter((f) => /\.md$/.test(String(f))).map((f) => `sgud/${String(f).replace(/\\/g, '/')}`),
        ]

        it('判準自檢: 被抓到與不誤判(自檢字串皆為中性假名 / 假值, 權杖以拼接組成)', () => {
            let hit = (s) => SENSITIVE_PATTERNS.some(([, re]) => re.test(s))
            for (let s of ['D:/work/x', 'c:\\a\\b', '/Users/someone/work/x', 'C:\\Users\\someone\\x', '/home/someone/x', 'http://192.0.2.1:8080/', 'host 10.0.0.1 ok', 'ghp_' + 'a'.repeat(36), 'npm_' + 'b'.repeat(36), '-----BEGIN ' + 'RSA PRIVATE KEY-----']) {
                assert.ok(hit(s), s)
            }
            for (let s of ['w-trade-strategy/src/cfg.mjs', 'https://api.binance.com/api/v3/klines', 'price_ohlc_none_RSI_rsi_1day', 'ETHUSDT 4hr', 'test/_tmp/x', '2026-11-08', 'w-data-trade ^1.0.34', 'version 1.0.34.5.6', 'ghp_short', 'npm_config_cache']) {
                assert.ok(!hit(s), s)
            }
        })

        it('src、test、README、g.mjs、toolg、sgud、package.json 不含通用機敏樣式', () => {
            let bad = []
            for (let f of files()) {
                let text = read(f)
                text.split(/\r?\n/).forEach((l, i) => {
                    for (let [label, re] of SENSITIVE_PATTERNS) {
                        if (re.test(l)) {
                            bad.push(`${f}:${i + 1} [${label}] ${l.trim().slice(0, 90)}`)
                        }
                    }
                })
            }
            assert.deepStrictEqual(bad, [])
            assert.ok(files().length >= 35, '掃描量過少')
        })

    })

})
