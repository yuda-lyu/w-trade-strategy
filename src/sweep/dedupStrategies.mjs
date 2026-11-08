import map from 'lodash-es/map.js'
import orderBy from 'lodash-es/orderBy.js'
import { eqYrOf } from './common.mjs'


/**
 * 入庫前之進場重疊去重：同向(mode)且共用至少一個cond key之策略間，進場位元遮罩之Jaccard(交集/聯集)>overlap視為同質，只留eqYr較高者(greedy)
 *
 * 治「同一訊號的多重包裝」；限制：不同key但高度相關之同質策略不在比對範圍
 *
 * @function
 * @param {Array} items 輸入策略物件陣列，各須含_entMask(進場位元遮罩Uint8Array)、conds、mode、summary
 * @param {Number} overlap 輸入Jaccard門檻(0~1)
 * @returns {Object} 回傳{kept(留存之策略陣列),nDrop(剔除數)}
 * @example
 *
 * let mk = (eqYr, mask) => ({ mode: 'long', conds: [{ key: 'k1' }, { key: 'k2' }], summary: { rEquivalentCumuProfitOrLossFinalNormYear: `${eqYr}%` }, _entMask: Uint8Array.from(mask) })
 * let r = dedupStrategies([mk(10, [0b1111]), mk(20, [0b1110]), mk(5, [0b0001])], 0.5)
 * console.log(r.kept.map((s) => s.summary.rEquivalentCumuProfitOrLossFinalNormYear).join(','), r.nDrop)
 * // => 20%,5% 1
 *
 */
let dedupStrategies = (items, overlap) => {

    let POP = new Uint8Array(256)
    for (let v = 1; v < 256; v++) {
        POP[v] = POP[v >> 1] + (v & 1)
    }
    let cntOf = (m) => {
        let c = 0
        for (let i = 0; i < m.length; i++) {
            c += POP[m[i]]
        }
        return c
    }
    let interOf = (a, b) => {
        let c = 0
        for (let i = 0; i < a.length; i++) {
            c += POP[a[i] & b[i]]
        }
        return c
    }

    let sorted = orderBy(items.map((s) => ({ s, eqYr: eqYrOf(s.summary) ?? -Infinity, cnt: cntOf(s._entMask) })), ['eqYr'], ['desc'])
    let kept = []
    let byKeyMode = new Map()
    let nDrop = 0
    for (let it of sorted) {
        let keys = map(it.s.conds, 'key')
        let mode = it.s.mode
        let seen = new Set()
        let dup = false
        for (let key of keys) {
            let g = byKeyMode.get(`${key}|${mode}`)
            if (!g) {
                continue
            }
            for (let ki of g) {
                if (seen.has(ki)) {
                    continue
                }
                seen.add(ki)
                let kp = kept[ki]
                let inter = interOf(it.s._entMask, kp.s._entMask)
                let union = it.cnt + kp.cnt - inter
                if (union > 0 && inter / union > overlap) {
                    dup = true
                    break
                }
            }
            if (dup) {
                break
            }
        }
        if (dup) {
            nDrop++
            continue
        }
        let ki = kept.length
        kept.push(it)
        for (let key of keys) {
            let gk = `${key}|${mode}`
            if (!byKeyMode.has(gk)) {
                byKeyMode.set(gk, [])
            }
            byKeyMode.get(gk).push(ki)
        }
    }

    return { kept: kept.map((it) => it.s), nDrop }
}


export default dedupStrategies
