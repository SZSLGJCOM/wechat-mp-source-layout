const MAX_VERSION_PART = 65535;
const VERSION_PART_PATTERN = /^(0|[1-9]\d*)$/;

export function isValidChromeExtensionVersion(value) {
  if (typeof value !== 'string') return false;

  const parts = value.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every((part) => VERSION_PART_PATTERN.test(part))) return false;

  const numbers = parts.map(Number);
  return numbers.some((part) => part !== 0)
    && numbers.every((part) => part <= MAX_VERSION_PART);
}

export function assertValidChromeExtensionVersion(value) {
  if (!isValidChromeExtensionVersion(value)) {
    throw new Error(
      `Invalid Chrome extension version "${value}": use 1-4 integers from 0 to ${MAX_VERSION_PART} without leading zeros`
    );
  }
}
