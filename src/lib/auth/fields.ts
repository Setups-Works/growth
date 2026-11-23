/**
 * Sign-up field rules, shared by the form (instant feedback) and the API
 * (the real check). No server-only imports, so the browser can use it too.
 */

export const NAME_MAX = 80;

/** A trimmed name with inner whitespace collapsed, or null when unusable. */
export function normaliseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > NAME_MAX) return null;
  // Letters from any script, plus the punctuation real names use.
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u.test(name)) return null;
  return name;
}

/**
 * A mobile number in E.164 form (+919876543210), or null.
 *
 * A bare 10-digit number is read as Indian (+91), the common case here; a
 * number typed with its country code is kept as it is. Spaces, dashes and
 * brackets are ignored.
 */
export function normalisePhone(raw: unknown, defaultCountry = "91"): string | null {
  if (typeof raw !== "string") return null;
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) digits = defaultCountry + digits.slice(1);
  else if (/^\d{10}$/.test(digits)) digits = defaultCountry + digits;
  if (!/^[1-9]\d{9,14}$/.test(digits)) return null;
  // Indian mobiles are 10 digits starting 6–9.
  if (digits.startsWith("91") && !/^91[6-9]\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}

/** 0–4: rough password strength for the meter. The server only enforces the minimum length. */
export function passwordScore(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(4, score);
}
