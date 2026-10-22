// ISO 4217 allowlist with minor-unit exponents, for amounts that arrive as integer minor units.
//
// An amount of `price_minor` in an unlisted or mis-scaled currency is a money bug waiting for a
// reader: 1000 JPY is 1000 yen, not 10.00, and 1000 KWD is 1.000 dinar, not 10.00. So a currency is
// accepted only if it is listed here, and its exponent is the one place that says how to read the
// integer. Default exponent is 2; the exceptions are listed explicitly. Funds codes (CLF, UYI,
// UYW), testing/precious-metal/supranational codes (XTS, XXX, XAU, ...) are deliberately absent.

const EXPONENT_0: readonly string[] = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]
const EXPONENT_3: readonly string[] = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']
const EXPONENT_2: readonly string[] = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BMD', 'BND',
  'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK',
  'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'JMD', 'KES', 'KGS', 'KHR', 'KPW', 'KYD', 'KZT', 'LAK',
  'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN',
  'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'QAR', 'RON',
  'RSD', 'RUB', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP',
  'SZL', 'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'USD', 'UYU', 'UZS', 'VES', 'WST', 'XCD',
  'YER', 'ZAR', 'ZMW', 'ZWG',
]

const EXPONENTS: ReadonlyMap<string, number> = new Map([
  ...EXPONENT_0.map((code): [string, number] => [code, 0]),
  ...EXPONENT_3.map((code): [string, number] => [code, 3]),
  ...EXPONENT_2.map((code): [string, number] => [code, 2]),
])

/** Minor-unit exponent for an allowlisted ISO 4217 code, or null when the code is not allowed. */
export function currencyExponent(code: string): number | null {
  return EXPONENTS.get(code) ?? null
}

/** Render integer minor units in the currency's own scale, e.g. (1000,'JPY') -> '1000 JPY', (1000,'KWD') -> '1.000 KWD'. */
export function formatMinorUnits(minor: number, code: string): string {
  const exponent = currencyExponent(code)
  if (exponent === null) throw new Error(`currency_not_allowlisted: ${code}`)
  if (exponent === 0) return `${minor} ${code}`
  const scale = 10 ** exponent
  const whole = Math.floor(minor / scale)
  const frac = String(minor % scale).padStart(exponent, '0')
  return `${whole}.${frac} ${code}`
}
