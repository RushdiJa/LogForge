import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const testTable = pgTable("test_table", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});