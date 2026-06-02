import { pgTable, text, serial, integer, boolean, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const feedsTable = pgTable("feeds", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull(),
  lastChecked: timestamp("last_checked"),
  lastEpisodeGuid: text("last_episode_guid"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const episodesTable = pgTable("episodes", {
  id: serial("id").primaryKey(),
  feedId: integer("feed_id").notNull().references(() => feedsTable.id),
  guid: text("guid").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  audioUrl: text("audio_url"),
  pubDate: timestamp("pub_date"),
  duration: text("duration"),
  listened: boolean("listened").default(false),
  progress: real("progress").default(0),
  transcript: text("transcript"),
  transcriptAt: timestamp("transcript_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const favoritesTable = pgTable("favorites", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  episodeId: integer("episode_id").notNull().references(() => episodesTable.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const queueTable = pgTable("queue", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  episodeId: integer("episode_id").notNull().references(() => episodesTable.id),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFeedSchema    = createInsertSchema(feedsTable).omit({ id: true, createdAt: true });
export const insertEpisodeSchema = createInsertSchema(episodesTable).omit({ id: true, createdAt: true });
export const insertFavoriteSchema = createInsertSchema(favoritesTable).omit({ id: true, createdAt: true });
export const insertQueueSchema   = createInsertSchema(queueTable).omit({ id: true, createdAt: true });

export type Feed           = typeof feedsTable.$inferSelect;
export type Episode        = typeof episodesTable.$inferSelect;
export type Favorite       = typeof favoritesTable.$inferSelect;
export type Queue          = typeof queueTable.$inferSelect;
export type InsertFeed     = z.infer<typeof insertFeedSchema>;
export type InsertEpisode  = z.infer<typeof insertEpisodeSchema>;
