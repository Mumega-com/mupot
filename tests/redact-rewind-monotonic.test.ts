// Generated synthetic inputs only. Exact adversarial receipts remain private.
// The frozen oracle is the public implementation at the task's main/base pin.
import {describe,expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {redactSecretPatterns as base} from './fixtures/redactor-base-8fa6d772'
import {redactSecretPatterns as candidate} from '../src/lib/redact'

function corpus(seed:number,count:number) {
  let state=seed>>>0
  const rnd=(n:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n}
  const keys=['password','token','secret','api_key','credentials','note','status','name']
  const spaces=['',' ','\t','\n','\r\n','\r','\u2028','\u2029','\n\n','\u00a0']
  const joins=[' ','\n','\r\n','\r','\u2028','\u2029',', ','; ',']','&']
  const docs:Array<{text:string;markers:string[]}>=[]
  for(let i=0;i<count;i++) {
    const markers:string[]=[];let text='';const fields=2+rnd(7)
    for(let j=0;j<fields;j++) {
      const marker=`Mq${i.toString(36)}p${j}V`;const key=keys[rnd(keys.length)]
      const quote=rnd(3)===0?'"':'';const sep=rnd(2)?'=':':'
      const value=rnd(3)===0?'':marker;if(value)markers.push(marker)
      text+=`${j?joins[rnd(joins.length)]:''}${quote}${key}${quote}${spaces[rnd(3)]}${sep}${spaces[rnd(spaces.length)]}${value}`
    }
    docs.push({text,markers})
  }
  return docs
}

describe('redactor monotonic extension',()=>{
  it('pins the frozen public baseline oracle',()=>{
    const hash=createHash('sha256').update(readFileSync(new URL('./fixtures/redactor-base-8fa6d772.ts',import.meta.url))).digest('hex')
    expect(hash).toBe('48da33c11ffe1255e92f1db236ef5f752bfc388a6d1b11c96dea680c9e4aed1f')
  })

  it('never restores a position marker that the frozen base removed',()=>{
    let weakened=0
    for(const seed of [1,7,42])for(const doc of corpus(seed,3000)) {
      const before=base(doc.text),after=candidate(doc.text)
      for(const marker of doc.markers)if(!before.includes(marker)&&after.includes(marker))weakened++
    }
    expect(weakened).toBe(0)
  })
  it('preserves exact output whenever the frozen base left the input unchanged',()=>{
    let changed=0
    for(const doc of corpus(103,4000))if(base(doc.text)===doc.text&&candidate(doc.text)!==doc.text)changed++
    expect(changed).toBe(0)
  })
  it('adds coverage within the generated corpus without exposing test inputs',()=>{
    let gained=0
    for(const doc of corpus(29,10000)) {
      const before=base(doc.text),after=candidate(doc.text)
      for(const marker of doc.markers)if(before.includes(marker)&&!after.includes(marker))gained++
    }
    expect(gained).toBeGreaterThan(0)
  })
  it('keeps the exact baseline result for generated single-physical-line inputs',()=>{
    let changed=0
    for(const doc of corpus(211,6000)) {
      const text=doc.text.replace(/[\r\n]/g,' ')
      if(candidate(text)!==base(text))changed++
    }
    expect(changed).toBe(0)
  })

})
