/**
 * auth-flow.ts — iCast User Registration
 * Policy: Anyone who sends /start is immediately approved as a user.
 * Admins are promoted via SUPERADMIN_CHAT_ID env var or /adminsetup command.
 */

import TelegramBot from "node-telegram-bot-api";
import { db, usersTable, userActivityTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── User roles ───────────────────────────────────────────────────────────────

export type UserRole = "pending" | "user" | "admin" | "superadmin" | "blocked" | "new";

export interface AuthState {
  role:            UserRole;
  isBlocked:       boolean;
  blockReason?:    string | null;
  captchaSolved:   boolean;
  captchaAttempts: number;
}

// ─── Get or create user ───────────────────────────────────────────────────────
// Every new user is immediately granted "user" role.
// If SUPERADMIN_CHAT_ID matches, they get "superadmin".

export async function getOrCreateUser(
  msg: TelegramBot.Message
): Promise<AuthState> {
  const chatId    = String(msg.chat.id);
  const username  = msg.from?.username  ?? null;
  const firstName = msg.from?.first_name ?? null;
  const lastName  = msg.from?.last_name  ?? null;

  const superadminId = process.env.SUPERADMIN_CHAT_ID?.trim();

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.chatId, chatId))
    .limit(1);

  if (existing[0]) {
    // Update activity timestamp
    await db
      .update(usersTable)
      .set({ lastActiveAt: new Date(), username, firstName, lastName })
      .where(eq(usersTable.chatId, chatId));

    // If this is the superadmin and they're not already promoted, promote them
    if (superadminId && chatId === superadminId && existing[0].role !== "superadmin") {
      await db.update(usersTable).set({ role: "superadmin" }).where(eq(usersTable.chatId, chatId));
      return { role: "superadmin", isBlocked: false, captchaSolved: true, captchaAttempts: 0 };
    }

    return {
      role:            (existing[0].role ?? "user") as UserRole,
      isBlocked:       existing[0].isBlocked  ?? false,
      blockReason:     existing[0].blockReason,
      captchaSolved:   existing[0].captchaSolved  ?? true,
      captchaAttempts: existing[0].captchaAttempts ?? 0,
    };
  }

  // New user — immediately approved
  const role: UserRole = superadminId && chatId === superadminId ? "superadmin" : "user";

  await db.insert(usersTable).values({
    chatId, username, firstName, lastName,
    role,
    captchaSolved:   true,
    captchaAttempts: 0,
  }).onConflictDoNothing();

  return { role, isBlocked: false, captchaSolved: true, captchaAttempts: 0 };
}

// ─── Check auth for any chatId ────────────────────────────────────────────────

export async function checkAuth(chatId: string): Promise<AuthState | null> {
  const superadminId = process.env.SUPERADMIN_CHAT_ID?.trim();
  if (superadminId && chatId === superadminId) {
    return { role: "superadmin", isBlocked: false, captchaSolved: true, captchaAttempts: 0 };
  }

  const user = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.chatId, chatId))
    .limit(1);

  if (!user[0]) return null;

  return {
    role:            (user[0].role ?? "user") as UserRole,
    isBlocked:       user[0].isBlocked  ?? false,
    blockReason:     user[0].blockReason,
    captchaSolved:   user[0].captchaSolved  ?? true,
    captchaAttempts: user[0].captchaAttempts ?? 0,
  };
}

// ─── Handle /start ────────────────────────────────────────────────────────────
// Returns true only if user is blocked (to prevent normal /start handling).

export async function handleStart(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<boolean> {
  const state = await getOrCreateUser(msg);

  if (state.isBlocked) {
    await bot.sendMessage(
      msg.chat.id,
      `🚷 *You have been blocked\\.*\n_Reason: ${state.blockReason ?? "No reason given"}_`,
      { parse_mode: "MarkdownV2" }
    );
    return true; // stop further handling
  }

  return false; // continue normal /start handling
}

// ─── CAPTCHA stub — no longer used but kept for import compatibility ───────────

export async function handleCaptchaAnswer(
  _bot: TelegramBot,
  _msg: TelegramBot.Message
): Promise<boolean> {
  return false; // CAPTCHA disabled — always pass through
}

// ─── Auth gate middleware ─────────────────────────────────────────────────────

export async function authGate(
  bot: TelegramBot,
  chatId: number
): Promise<boolean> {
  const auth = await checkAuth(String(chatId));

  if (!auth) {
    // Unknown user — create them now
    await db.insert(usersTable).values({
      chatId:          String(chatId),
      role:            "user",
      captchaSolved:   true,
      captchaAttempts: 0,
    }).onConflictDoNothing();
    return true;
  }

  if (auth.isBlocked) {
    await bot.sendMessage(chatId, "🚷 You have been blocked\\.", { parse_mode: "MarkdownV2" });
    return false;
  }

  return true;
}

// ─── Log activity ─────────────────────────────────────────────────────────────

export async function logActivity(
  chatId: number,
  action: string
): Promise<void> {
  await db.insert(userActivityTable).values({
    chatId:    String(chatId),
    action,
    createdAt: new Date(),
  }).catch(() => {});
}
