const capturedReflectApply = Reflect.apply
const capturedReflectGet = Reflect.get
const capturedObjectFreeze = Object.freeze
const capturedObjectHasOwn = Object.hasOwn
const capturedArrayIsArray = Array.isArray
const capturedArrayIncludes = Array.prototype.includes
const capturedArrayPush = Array.prototype.push
const capturedWeakSetHas = WeakSet.prototype.has
const capturedWeakSetAdd = WeakSet.prototype.add
const capturedMapGet = Map.prototype.get
const capturedMapSet = Map.prototype.set
const capturedMapHas = Map.prototype.has
const capturedSetHas = Set.prototype.has
const capturedSetAdd = Set.prototype.add
const capturedNumberIsFinite = Number.isFinite
const capturedNumberIsInteger = Number.isInteger
const capturedDateParse = Date.parse
const capturedDateToISOString = Date.prototype.toISOString
const capturedStringTrim = String.prototype.trim
const capturedStringStartsWith = String.prototype.startsWith
const capturedRegExpTest = RegExp.prototype.test
const CapturedWeakSet = WeakSet
const CapturedMap = Map
const CapturedSet = Set
const CapturedDate = Date

export function applyIntrinsic<T>(
  target: (...args: never[]) => T,
  receiver: unknown,
  args: readonly unknown[],
): T {
  return capturedReflectApply(target, receiver, args) as T
}

export function getIntrinsic(target: object, property: PropertyKey): unknown {
  return capturedReflectGet(target, property)
}

export function freezeIntrinsic<T>(value: T): Readonly<T> {
  return capturedObjectFreeze(value)
}

export function hasOwnIntrinsic(target: object, property: PropertyKey): boolean {
  return capturedObjectHasOwn(target, property)
}

export function isArrayIntrinsic(value: unknown): value is unknown[] {
  return capturedArrayIsArray(value)
}

export function includesIntrinsic<T>(values: readonly T[], value: unknown): boolean {
  return capturedReflectApply(capturedArrayIncludes, values, [value]) as boolean
}

export function pushIntrinsic<T>(values: T[], value: T): number {
  return capturedReflectApply(capturedArrayPush, values, [value]) as number
}

export function createWeakSet<T extends object>(): WeakSet<T> {
  return new CapturedWeakSet<T>()
}

export function weakSetHasIntrinsic<T extends object>(values: WeakSet<T>, value: object): boolean {
  return capturedReflectApply(capturedWeakSetHas, values, [value]) as boolean
}

export function weakSetAddIntrinsic<T extends object>(values: WeakSet<T>, value: T): void {
  capturedReflectApply(capturedWeakSetAdd, values, [value])
}

export function createMap<K, V>(): Map<K, V> {
  return new CapturedMap<K, V>()
}

export function mapGetIntrinsic<K, V>(values: Map<K, V>, key: K): V | undefined {
  return capturedReflectApply(capturedMapGet, values, [key]) as V | undefined
}

export function mapSetIntrinsic<K, V>(values: Map<K, V>, key: K, value: V): void {
  capturedReflectApply(capturedMapSet, values, [key, value])
}

export function mapHasIntrinsic<K, V>(values: Map<K, V>, key: K): boolean {
  return capturedReflectApply(capturedMapHas, values, [key]) as boolean
}

export function createSet<T>(): Set<T> {
  return new CapturedSet<T>()
}

export function setHasIntrinsic<T>(values: Set<T>, value: T): boolean {
  return capturedReflectApply(capturedSetHas, values, [value]) as boolean
}

export function setAddIntrinsic<T>(values: Set<T>, value: T): void {
  capturedReflectApply(capturedSetAdd, values, [value])
}

export function isFiniteIntrinsic(value: unknown): boolean {
  return capturedNumberIsFinite(value)
}

export function isIntegerIntrinsic(value: unknown): boolean {
  return capturedNumberIsInteger(value)
}

export function parseDateIntrinsic(value: string): number {
  return capturedDateParse(value)
}

export function dateToISOStringIntrinsic(timestamp: number): string {
  const date = new CapturedDate(timestamp)
  return capturedReflectApply(capturedDateToISOString, date, []) as string
}

export function trimIntrinsic(value: string): string {
  return capturedReflectApply(capturedStringTrim, value, []) as string
}

export function startsWithIntrinsic(value: string, search: string): boolean {
  return capturedReflectApply(capturedStringStartsWith, value, [search]) as boolean
}

export function testIntrinsic(expression: RegExp, value: string): boolean {
  return capturedReflectApply(capturedRegExpTest, expression, [value]) as boolean
}
