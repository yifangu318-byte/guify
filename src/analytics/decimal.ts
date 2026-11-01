import { validDecimal } from '../orders/models.js';

/** Arbitrary decimal precision. Only integer BigInt coefficients are added;
 * preserve the largest input scale, including trailing zeroes. */
export function sumDecimalAmounts(values: readonly string[]): string {
  if (!Array.isArray(values) || !values.every(validDecimal)) throw new Error('Invalid analytics amount');
  let coefficient = 0n, scale = 0;
  for (const value of values) {
    const [whole, fraction = ''] = value.split('.');
    if (fraction.length > scale) {
      coefficient *= 10n ** BigInt(fraction.length - scale);
      scale = fraction.length;
    }
    coefficient += BigInt(whole! + fraction) * 10n ** BigInt(scale - fraction.length);
  }
  const digits = coefficient.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : digits.slice(0, -scale) + '.' + digits.slice(-scale);
}
