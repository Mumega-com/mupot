// A software WebAuthn authenticator for tests: ES256 keys, attestation 'none', real authenticator data and
// real ECDSA signatures, so the server's WebCrypto verification is exercised end to end.
import { b64uEncode } from '../../src/secure-moments/webauthn'

const enc = new TextEncoder()

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n]
  if (n < 256) return [(major << 5) | 24, n]
  return [(major << 5) | 25, n >> 8, n & 0xff]
}
type CborIn = number | string | Uint8Array | Map<number | string, CborIn>
function cborEncode(v: CborIn): number[] {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v)
  if (typeof v === 'string') { const b = enc.encode(v); return [...cborHead(3, b.length), ...b] }
  if (v instanceof Uint8Array) return [...cborHead(2, v.length), ...v]
  const out = [...cborHead(5, v.size)]
  for (const [k, x] of v) out.push(...cborEncode(k), ...cborEncode(x))
  return out
}

async function sha256(d: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : d))
}

function p1363ToDer(sig: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): number[] => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    const t = [...b.slice(i)]
    if (t[0] & 0x80) t.unshift(0)
    return [0x02, t.length, ...t]
  }
  const body = [...int(sig.slice(0, 32)), ...int(sig.slice(32))]
  return new Uint8Array([0x30, body.length, ...body])
}

export interface CeremonyOpts {
  rpId: string
  origin: string
  challenge: string
  uv?: boolean
  up?: boolean
  type?: string
  crossOrigin?: boolean
  /** Override the rpIdHash host (rpId confusion tests). */
  hashRpId?: string
  /** Force the signature counter (default: increment). */
  counter?: number
  /** COSE alg label to advertise for the key (default -7, ES256). */
  coseAlg?: number
}

export class SoftAuthenticator {
  signCount = 0
  constructor(public privateKey: CryptoKey, public x: Uint8Array, public y: Uint8Array, public credentialId: Uint8Array) {}

  static async create(): Promise<SoftAuthenticator> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const dec = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))
    return new SoftAuthenticator(pair.privateKey, dec(jwk.x ?? ''), dec(jwk.y ?? ''), crypto.getRandomValues(new Uint8Array(32)))
  }

  get id(): string { return b64uEncode(this.credentialId) }

  private async flags(o: CeremonyOpts, at: boolean): Promise<number> {
    return (o.up === false ? 0 : 0x01) | (o.uv === false ? 0 : 0x04) | (at ? 0x40 : 0)
  }

  private clientData(o: CeremonyOpts, type: string): Uint8Array {
    return enc.encode(JSON.stringify({ type: o.type ?? type, challenge: o.challenge, origin: o.origin, ...(o.crossOrigin ? { crossOrigin: true } : {}) }))
  }

  async register(o: CeremonyOpts): Promise<{ id: string; rawId: string; type: string; response: { clientDataJSON: string; attestationObject: string } }> {
    const rpHash = await sha256(o.hashRpId ?? o.rpId)
    const cose = new Map<number | string, CborIn>([[1, 2], [3, o.coseAlg ?? -7], [-1, 1], [-2, this.x], [-3, this.y]])
    const credData = new Uint8Array([
      ...new Uint8Array(16), (this.credentialId.length >> 8) & 0xff, this.credentialId.length & 0xff, ...this.credentialId, ...cborEncode(cose),
    ])
    const counter = o.counter ?? 0
    const authData = new Uint8Array([...rpHash, await this.flags(o, true), (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff, ...credData])
    const att = new Uint8Array(cborEncode(new Map<number | string, CborIn>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])))
    return { id: this.id, rawId: this.id, type: 'public-key', response: { clientDataJSON: b64uEncode(this.clientData(o, 'webauthn.create')), attestationObject: b64uEncode(att) } }
  }

  async assert(o: CeremonyOpts): Promise<{ id: string; rawId: string; type: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } }> {
    this.signCount = o.counter ?? this.signCount + 1
    const c = this.signCount
    const authData = new Uint8Array([...(await sha256(o.hashRpId ?? o.rpId)), await this.flags(o, false), (c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff])
    const cd = this.clientData(o, 'webauthn.get')
    const signed = new Uint8Array([...authData, ...(await sha256(cd))])
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, signed))
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: b64uEncode(cd), authenticatorData: b64uEncode(authData), signature: b64uEncode(p1363ToDer(raw)) },
    }
  }
}
