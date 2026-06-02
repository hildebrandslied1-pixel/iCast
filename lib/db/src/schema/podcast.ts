import {
  pgTable, text, serial, integer, boolean,
  timestamp, real, index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Feeds ────────────────────────────────────────────────────────────────────

export const feedsTable = pgTable("feeds", {
  id:               serial("id").primaryKey(),
  chatId:           text("chat_id").notNull(),
  title:            text("title").notNull().default(""),
  url:              text("url").notNull(),
  author:           text("author"),
  imageUrl:         text("image_url"),
  lastChecked:      timestamp("last_checked"),
  lastEpisodeGuid:  text("last_episode_guid"),
  createdAt:        timestamp("created_at").defaultNow(),
});

// ─── Episodes ─────────────────────────────────────────────────────────────────

export const episodesTable = pgTable("episodes", {
  id:             serial("id").primaryKey(),
  feedId:         integer("feed_id").notNull().references(() => feedsTable.id, { onDelete: "cascade" }),
  guid:           text("guid").notNull(),
  title:          text("title").notNull(),
  description:    text("description"),
  audioUrl:       text("audio_url"),
  imageUrl:       text("image_url"),
  pubDate:        timestamp("pub_date"),
  duration:       text("duration"),
  episodeNumber:  integer("episode_number"),
  listened:       boolean("listened").default(false),
  progress:       real("progress").default(0),
  transcript:     text("transcript"),
  transcriptAt:   timestamp("transcript_at"),
  chapters:       text("chapters"),
  createdAt:      timestamp("created_at").defaultNow(),
  updatedAt:      timestamp("updated_at").defaultNow(),
}, (t) => [
  index("episodes_feed_id_idx").on(t.feedId),
  index("episodes_pub_date_idx").on(t.pubDate),
]);

// ─── Favourites ───────────────────────────────────────────────────────────────

export const favoritesTable = pgTable("favorites", {
  id:         serial("id").primaryKey(),
  chatId:     text("chat_id").notNull(),
  episodeId:  integer("episode_id").notNull().references(() => episodesTable.id, { onDelete: "cascade" }),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── Queue ────────────────────────────────────────────────────────────────────

export const queueTable = pgTable("queue", {
  id:         serial("id").primaryKey(),
  chatId:     text("chat_id").notNull(),
  episodeId:  integer("episode_id").notNull().references(() => episodesTable.id, { onDelete: "cascade" }),
  position:   integer("position").notNull().default(0),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

export const tagsTable = pgTable("tags", {
  id:         serial("id").primaryKey(),
  chatId:     text("chat_id").notNull(),
  name:       text("name").notNull(),
  createdAt:  timestamp("created_at").defaultNow(),
});

export const episodeTagsTable = pgTable("episode_tags", {
  id:         serial("id").primaryKey(),
  episodeId:  integer("episode_id").notNull().references(() => episodesTable.id, { onDelete: "cascade" }),
  tagId:      integer("tag_id").notNull().references(() => tagsTable.id, { onDelete: "cascade" }),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── User Preferences ─────────────────────────────────────────────────────────

export const userPrefsTable = pgTable("user_prefs", {
  chatId:        text("chat_id").primaryKey(),
  autoDownload:  boolean("auto_download").default(false),
  notifications: text("notifications").default("all"),
  language:      text("language").default("en"),
  playbackSpeed: text("playback_speed").default("1"),
  updatedAt:     timestamp("updated_at").defaultNow(),
});

// ─── Bookmarks / Notes ────────────────────────────────────────────────────────

export const bookmarksTable = pgTable("bookmarks", {
  id:         serial("id").primaryKey(),
  chatId:     text("chat_id").notNull(),
  episodeId:  integer("episode_id").notNull().references(() => episodesTable.id, { onDelete: "cascade" }),
  note:       text("note"),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── Ratings ──────────────────────────────────────────────────────────────────

export const ratingsTable = pgTable("ratings", {
  id:         serial("id").primaryKey(),
  chatId:     text("chat_id").notNull(),
  feedId:     integer("feed_id").notNull().references(() => feedsTable.id, { onDelete: "cascade" }),
  rating:     integer("rating").notNull(),
  review:     text("review"),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── Users (Auth & Access Control) ───────────────────────────────────────────

export const usersTable = pgTable("users", {
  id:              serial("id").primaryKey(),
  chatId:          text("chat_id").unique().notNull(),
  username:        text("username"),
  firstName:       text("first_name"),
  lastName:        text("last_name"),
  role:            text("role").default("pending"),   // pending | user | admin | superadmin
  isBlocked:       boolean("is_blocked").default(false),
  blockReason:     text("block_reason"),
  captchaAttempts: integer("captcha_attempts").default(0),
  captchaSolved:   boolean("captcha_solved").default(false),
  joinedAt:        timestamp("joined_at").defaultNow(),
  lastActiveAt:    timestamp("last_active_at").defaultNow(),
});

// ─── Admin Logs ───────────────────────────────────────────────────────────────

export const adminLogsTable = pgTable("admin_logs", {
  id:            serial("id").primaryKey(),
  adminChatId:   text("admin_chat_id").notNull(),
  targetChatId:  text("target_chat_id"),
  action:        text("action").notNull(),   // approve | block | unblock | promote | demote | message | broadcast
  details:       text("details"),
  createdAt:     timestamp("created_at").defaultNow(),
});

// ─── User Activity ────────────────────────────────────────────────────────────

export const userActivityTable = pgTable("user_activity", {
  id:         serial("id").primaryKey(),
  chatId:     text("chat_id").notNull(),
  action:     text("action").notNull(),
  details:    text("details"),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const insertFeedSchema        = createInsertSchema(feedsTable).omit({ id: true, createdAt: true });
export const insertEpisodeSchema     = createInsertSchema(episodesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFavoriteSchema    = createInsertSchema(favoritesTable).omit({ id: true, createdAt: true });
export const insertQueueSchema       = createInsertSchema(queueTable).omit({ id: true, createdAt: true });
export const insertTagSchema         = createInsertSchema(tagsTable).omit({ id: true, createdAt: true });
export const insertEpisodeTagSchema  = createInsertSchema(episodeTagsTable).omit({ id: true, createdAt: true });
export const insertBookmarkSchema    = createInsertSchema(bookmarksTable).omit({ id: true, createdAt: true });
export const insertRatingSchema      = createInsertSchema(ratingsTable).omit({ id: true, createdAt: true });
export const insertUserSchema        = createInsertSchema(usersTable).omit({ id: true, joinedAt: true, lastActiveAt: true });
export const insertAdminLogSchema    = createInsertSchema(adminLogsTable).omit({ id: true, createdAt: true });
export const insertUserActivitySchema = createInsertSchema(userActivityTable).omit({ id: true, createdAt: true });

// ─── TS Types ─────────────────────────────────────────────────────────────────

export type Feed          = typeof feedsTable.$inferSelect;
export type Episode       = typeof episodesTable.$inferSelect;
export type Favorite      = typeof favoritesTable.$inferSelect;
export type Queue         = typeof queueTable.$inferSelect;
export type Tag           = typeof tagsTable.$inferSelect;
export type EpisodeTag    = typeof episodeTagsTable.$inferSelect;
export type UserPrefs     = typeof userPrefsTable.$inferSelect;
export type Bookmark      = typeof bookmarksTable.$inferSelect;
export type Rating        = typeof ratingsTable.$inferSelect;
export type User          = typeof usersTable.$inferSelect;
export type AdminLog      = typeof adminLogsTable.$inferSelect;
export type UserActivity  = typeof userActivityTable.$inferSelect;

export type InsertFeed    = z.infer<typeof insertFeedSchema>;
export type InsertEpisode = z.infer<typeof insertEpisodeSchema>;
export type InsertUser    = z.infer<typeof insertUserSchema>;
