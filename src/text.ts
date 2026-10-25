/**
 * Turn any value into readable text: errors become their message and objects become JSON,
 * never "[object Object]".
 */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return Object.prototype.toString.call(value);
  }
}
