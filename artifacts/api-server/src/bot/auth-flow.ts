/**
 * auth-flow.ts — User registration, CAPTCHA, and approval gate for iCast
 */

import TelegramBot from "node-telegram-bot-api";
import { db, usersTable, userActivityTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCaptchaChallenge, verifyCaptcha, maxCaptchaAttempts } from "./captcha.js";
import { notifyNewUser, blockUser, isAdmin } from "./admin.js";

// ─── User roles ───────────────────────────────────────────────────────────────

export type UserRole = "pending" | "user" | "admin" | "superadmin" | "blocked" | "new";

export interface AuthState {
  role: UserRole;
  isBlocked: boolean;
  blockReason?: string | null;
  captchaSolved: boolean;
  captchaAttempts: number;
}

// ─── Get or create user ───────────────────────────────────────────────────────

export async function getOrCreateUser(
  msg: TelegramBot.Message
): Promise<AuthState> {
  const chatId    = String(msg.chat.id);
  const username  = msg.from?.username ?? null;
  const firstName = msg.from?.first_name ?? null;
  const lastName  = msg.from?.last_name ?? null;

  const superadmin = process.env.SUPERADMIN_CHAT_ID;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.chatId, chatId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(usersTable)
      .set({ lastActiveAt: new Date(), username, firstName, lastName })
      .where(eq(usersTable.chatId, chatId));

    return {
      role:            (existing[0].role ?? "pending") as UserRole,
      isBlocked:       existing[0].isBlocked ?? false,
      blockReason:     existing[0].blockReason,
      captchaSolved:   existing[0].captchaSolved ?? false,
      captchaAttempts: existing[0].captchaAttempts ?? 0,
    };
  }

  // Superadmin bypass
  if (superadmin && chatId === superadmin) {
    await db.insert(usersTable).values({
      chatId, username, firstName, lastName,
      role: "superadmin", captchaSolved: true,
    }).onConflictDoNothing();
    return { role: "superadmin", isBlocked: false, captchaSolved: true, captchaAttempts: 0 };
  }

  // New user
  await db.insert(usersTable).values({
    chatId, username, firstName, lastName,
    role: "pending", captchaSolved: false, captchaAttempts: 0,
  }).onConflictDoNothing();

  return { role: "new", isBlocked: false, captchaSolved: false, captchaAttempts: 0 };
}

// ─── Check auth for any message ───────────────────────────────────────────────

export async function checkAuth(chatId: string): Promise<AuthState | null> {
  const superadmin = process.env.SUPERADMIN_CHAT_ID;
  if (superadmin && chatId === superadmin) {
    return { role: "superadmin", isBlocked: false, captchaSolved: true, captchaAttempts: 0 };
  }

  const user = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.chatId, chatId))
    .limit(1);

  if (!user[0]) return null;

  return {
    role:            (user[0].role ?? "pending") as UserRole,
    isBlocked:       user[0].isBlocked ?? false,
    blockReason:     user[0].blockReason,
    captchaSolved:   user[0].captchaSolved ?? false,
    captchaAttempts: user[0].captchaAttempts ?? 0,
  };
}

// ─── Handle /start for new / returning users ──────────────────────────────────

export async function handleStart(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<boolean> {
  const chatId = String(msg.chat.id);
  const state  = await getOrCreateUser(msg);

  // Superadmin / admin / approved user → let normal /start proceed
  if (!state.isBlocked && (
    state.role === "superadmin" ||
    state.role === "admin" ||
    state.role === "user"
  )) {
    return false; // continue normal handling
  }

  // Blocked user
  if (state.isBlocked) {
    await bot.sendMessage(
      msg.chat.id,
      `🚷 تم حظرك. السبب: ${state.blockReason ?? "غير محدد"}`,
      { parse_mode: "Markdown" }
    );
    return true;
  }

  // New user → send CAPTCHA first
  if (state.role === "new" || (!state.captchaSolved && state.role === "pending")) {
    const challenge = getCaptchaChallenge();
    await bot.sendMessage(msg.chat.id, challenge.question, { parse_mode: "MarkdownV2" });
    return true;
  }

  // Pending (captcha solved, waiting admin approval)
  if (state.role === "pending" && state.captchaSolved) {
    await bot.sendMessage(
      msg.chat.id,
      "⏳ طلبك قيد المراجعة من الأدمن. سيتم إعلامك بالنتيجة قريباً.",
      { parse_mode: "Markdown" }
    );
    return true;
  }

  return false;
}

// ─── Handle CAPTCHA answer ────────────────────────────────────────────────────

export async function handleCaptchaAnswer(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<boolean> {
  const chatId = String(msg.chat.id);
  const text   = msg.text?.trim() ?? "";

  // Only handle if user exists and hasn't solved captcha
  const user = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.chatId, chatId))
    .limit(1);

  if (!user[0]) return false;
  if (user[0].captchaSolved) return false;
  if (user[0].isBlocked) return false;

  // Check if input looks like a number (captcha answer)
  if (!/^\d+$/.test(text)) return false;

  const isCorrect = verifyCaptcha(text);
  const maxAttempts = maxCaptchaAttempts();

  if (isCorrect) {
    await db.update(usersTable).set({ captchaSolved: true }).where(eq(usersTable.chatId, chatId));

    await bot.sendMessage(
      msg.chat.id,
      "✅ *إجابة صحيحة!*\n\n⏳ تم إرسال طلب الانضمام للأدمن. سيتم إعلامك بالنتيجة قريباً.",
      { parse_mode: "Markdown" }
    );

    await notifyNewUser(bot, {
      chatId,
      firstName: user[0].firstName,
      username:  user[0].username,
    });

    return true;
  }

  // Wrong answer
  const newAttempts = (user[0].captchaAttempts ?? 0) + 1;
  await db
    .update(usersTable)
    .set({ captchaAttempts: newAttempts })
    .where(eq(usersTable.chatId, chatId));

  if (newAttempts >= maxAttempts) {
    await db
      .update(usersTable)
      .set({ isBlocked: true, blockReason: `فشل CAPTCHA ${maxAttempts} مرات` })
      .where(eq(usersTable.chatId, chatId));

    await bot.sendMessage(
      msg.chat.id,
      `🚷 تم حظرك تلقائياً بسبب ${maxAttempts} محاولات فاشلة.`,
      { parse_mode: "Markdown" }
    );
    return true;
  }

  await bot.sendMessage(
    msg.chat.id,
    `❌ خطأ! المحاولة ${newAttempts}/${maxAttempts}. حاول مرة أخرى.`,
    { parse_mode: "Markdown" }
  );
  return true;
}

// ─── Gate check for every incoming message ────────────────────────────────────

export async function authGate(
  chatId: string
): Promise<"allow" | "block" | "pending"> {
  const superadmin = process.env.SUPERADMIN_CHAT_ID;
  if (superadmin && chatId === superadmin) return "allow";

  const state = await checkAuth(chatId);
  if (!state) return "pending"; // unknown user

  if (state.isBlocked) return "block";
  if (state.role === "user" || state.role === "admin" || state.role === "superadmin") return "allow";
  return "pending";
}

// ─── Log user activity ────────────────────────────────────────────────────────

export async function logActivity(
  chatId: string,
  action: string,
  details?: string
): Promise<void> {
  await db.insert(userActivityTable).values({ chatId, action, details }).catch(() => {});
}
