/**
 * admin.ts — Admin notification & management helpers for iCast
 */

import TelegramBot from "node-telegram-bot-api";
import { db, usersTable, adminLogsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ─── Get all admins ───────────────────────────────────────────────────────────

export async function getAdminChatIds(): Promise<string[]> {
  const superadmin = process.env.SUPERADMIN_CHAT_ID;
  const admins = await db
    .select({ chatId: usersTable.chatId })
    .from(usersTable)
    .where(inArray(usersTable.role, ["admin", "superadmin"]));

  const ids = admins.map((a) => a.chatId);
  if (superadmin && !ids.includes(superadmin)) ids.unshift(superadmin);
  return ids;
}

// ─── Notify all admins ────────────────────────────────────────────────────────

export async function notifyAdmins(
  bot: TelegramBot,
  message: string,
  keyboard?: TelegramBot.InlineKeyboardMarkup
): Promise<void> {
  const adminIds = await getAdminChatIds();
  await Promise.allSettled(
    adminIds.map((id) =>
      bot.sendMessage(id, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
    )
  );
}

// ─── Log admin action ─────────────────────────────────────────────────────────

export async function logAdminAction(
  adminChatId: string,
  action: string,
  targetChatId?: string,
  details?: string
): Promise<void> {
  await db.insert(adminLogsTable).values({
    adminChatId,
    targetChatId,
    action,
    details,
  });
}

// ─── Send new user notification ───────────────────────────────────────────────

export async function notifyNewUser(
  bot: TelegramBot,
  user: { chatId: string; firstName?: string | null; username?: string | null }
): Promise<void> {
  const name     = user.firstName ?? "Unknown";
  const username = user.username ? `@${user.username}` : "no username";
  const message  = `🆕 *مستخدم جديد يريد الدخول*\n👤 ${name} (${username})\n🆔 \`${user.chatId}\``;

  const keyboard: TelegramBot.InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "✅ موافقة", callback_data: `admin_approve:${user.chatId}` },
        { text: "❌ رفض",   callback_data: `admin_reject:${user.chatId}` },
        { text: "🚷 حظر",   callback_data: `admin_block:${user.chatId}` },
      ],
    ],
  };

  await notifyAdmins(bot, message, keyboard);
}

// ─── Approve user ─────────────────────────────────────────────────────────────

export async function approveUser(
  bot: TelegramBot,
  targetChatId: string,
  adminChatId: string
): Promise<void> {
  await db
    .update(usersTable)
    .set({ role: "user" })
    .where(eq(usersTable.chatId, targetChatId));

  await logAdminAction(adminChatId, "approve", targetChatId);

  await bot.sendMessage(
    targetChatId,
    "✅ *تمت الموافقة على حسابك!*\n\nمرحباً بك في iCast. يمكنك الآن استخدام البوت بالكامل.\n\nابدأ بـ /start",
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ─── Reject user ──────────────────────────────────────────────────────────────

export async function rejectUser(
  bot: TelegramBot,
  targetChatId: string,
  adminChatId: string,
  reason = "لم يتم قبول طلبك"
): Promise<void> {
  await db
    .update(usersTable)
    .set({ role: "pending" })
    .where(eq(usersTable.chatId, targetChatId));

  await logAdminAction(adminChatId, "reject", targetChatId, reason);

  await bot.sendMessage(
    targetChatId,
    `❌ *تم رفض طلبك*\n📌 السبب: ${reason}`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ─── Block user ───────────────────────────────────────────────────────────────

export async function blockUser(
  bot: TelegramBot,
  targetChatId: string,
  adminChatId: string,
  reason = "تم حظرك من قبل الأدمن"
): Promise<void> {
  await db
    .update(usersTable)
    .set({ isBlocked: true, blockReason: reason })
    .where(eq(usersTable.chatId, targetChatId));

  await logAdminAction(adminChatId, "block", targetChatId, reason);

  const user = await db
    .select({ firstName: usersTable.firstName })
    .from(usersTable)
    .where(eq(usersTable.chatId, targetChatId))
    .limit(1);

  const name = user[0]?.firstName ?? targetChatId;
  await notifyAdmins(bot, `🚷 *تم حظر مستخدم*\n👤 ${name}\n📌 السبب: ${reason}`);

  await bot.sendMessage(
    targetChatId,
    `🚷 *تم حظرك*\n📌 السبب: ${reason}`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ─── Unblock user ─────────────────────────────────────────────────────────────

export async function unblockUser(
  bot: TelegramBot,
  targetChatId: string,
  adminChatId: string
): Promise<void> {
  await db
    .update(usersTable)
    .set({ isBlocked: false, blockReason: null, role: "user" })
    .where(eq(usersTable.chatId, targetChatId));

  await logAdminAction(adminChatId, "unblock", targetChatId);

  const user = await db
    .select({ firstName: usersTable.firstName })
    .from(usersTable)
    .where(eq(usersTable.chatId, targetChatId))
    .limit(1);

  const name = user[0]?.firstName ?? targetChatId;
  await notifyAdmins(bot, `✅ *تم فك الحظر*\n👤 ${name}`);

  await bot.sendMessage(
    targetChatId,
    "✅ *تم فك حظرك!*\nيمكنك الآن استخدام البوت.",
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ─── Promote user ─────────────────────────────────────────────────────────────

export async function promoteUser(
  bot: TelegramBot,
  targetChatId: string,
  adminChatId: string
): Promise<void> {
  await db
    .update(usersTable)
    .set({ role: "admin" })
    .where(eq(usersTable.chatId, targetChatId));

  await logAdminAction(adminChatId, "promote", targetChatId);

  const user = await db
    .select({ firstName: usersTable.firstName })
    .from(usersTable)
    .where(eq(usersTable.chatId, targetChatId))
    .limit(1);

  const name = user[0]?.firstName ?? targetChatId;
  await notifyAdmins(bot, `⭐ *تم ترقية مستخدم*\n👤 ${name} → Admin`);

  await bot.sendMessage(
    targetChatId,
    "⭐ *تمت ترقيتك إلى أدمن!*\nيمكنك الآن استخدام /admin",
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ─── Demote user ──────────────────────────────────────────────────────────────

export async function demoteUser(
  bot: TelegramBot,
  targetChatId: string,
  adminChatId: string
): Promise<void> {
  await db
    .update(usersTable)
    .set({ role: "user" })
    .where(eq(usersTable.chatId, targetChatId));

  await logAdminAction(adminChatId, "demote", targetChatId);

  await bot.sendMessage(
    targetChatId,
    "⬇️ *تم إلغاء صلاحيات الأدمن.*",
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ─── Check if user is admin ───────────────────────────────────────────────────

export async function isAdmin(chatId: string): Promise<boolean> {
  const superadmin = process.env.SUPERADMIN_CHAT_ID;
  if (superadmin && chatId === superadmin) return true;

  const user = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.chatId, chatId))
    .limit(1);

  return user[0]?.role === "admin" || user[0]?.role === "superadmin";
}

// ─── Broadcast to all users ───────────────────────────────────────────────────

export async function broadcastMessage(
  bot: TelegramBot,
  text: string,
  adminChatId: string
): Promise<{ sent: number; failed: number }> {
  const users = await db
    .select({ chatId: usersTable.chatId })
    .from(usersTable)
    .where(eq(usersTable.isBlocked, false));

  let sent = 0;
  let failed = 0;

  for (const u of users) {
    if (u.chatId === adminChatId) continue;
    try {
      await bot.sendMessage(u.chatId, text, { parse_mode: "Markdown" });
      sent++;
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      failed++;
    }
  }

  await logAdminAction(adminChatId, "broadcast", undefined, `sent:${sent} failed:${failed}`);
  return { sent, failed };
}
