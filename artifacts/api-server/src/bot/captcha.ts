/**
 * captcha.ts — Math CAPTCHA system for iCast
 * Formula: (first_number + last_number) × 7
 * Numbers are read from CAPTCHA_NUMBERS env var (comma-separated)
 * Answer is validated against CAPTCHA_ANSWER env var
 */

export interface CaptchaChallenge {
  numbers: number[];
  question: string;
  answer: number;
}

export function getCaptchaChallenge(): CaptchaChallenge {
  const raw = process.env.CAPTCHA_NUMBERS ?? "2,5,6,7,3,7,9";
  const numbers = raw.split(",").map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));

  const first = numbers[0] ?? 2;
  const last  = numbers[numbers.length - 1] ?? 9;
  const answer = parseInt(process.env.CAPTCHA_ANSWER ?? String((first + last) * 7), 10);

  const numbersDisplay = numbers.join("  ");
  const question = [
    `🧮 *أهلاً بك في iCast\\!*`,
    ``,
    `للدخول، حلِّ هذه المعادلة:`,
    `\\(الرقم الأول \\+ الرقم السابع\\) × 7`,
    ``,
    `الأرقام: \`${numbersDisplay}\``,
    ``,
    `أرسل الناتج فقط:`,
  ].join("\n");

  return { numbers, question, answer };
}

export function verifyCaptcha(input: string): boolean {
  const raw    = process.env.CAPTCHA_NUMBERS ?? "2,5,6,7,3,7,9";
  const numbers = raw.split(",").map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
  const first  = numbers[0] ?? 2;
  const last   = numbers[numbers.length - 1] ?? 9;
  const answer = parseInt(process.env.CAPTCHA_ANSWER ?? String((first + last) * 7), 10);

  const userAnswer = parseInt(input.trim(), 10);
  return !isNaN(userAnswer) && userAnswer === answer;
}

export function maxCaptchaAttempts(): number {
  return parseInt(process.env.MAX_CAPTCHA_ATTEMPTS ?? "3", 10);
}
