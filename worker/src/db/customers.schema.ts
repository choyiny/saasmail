import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";
import { people } from "./people.schema";

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const customerPeople = sqliteTable(
  "customer_people",
  {
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .unique()
      .references(() => people.id, { onDelete: "cascade" }),
    linkedBy: text("linked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    linkedAt: integer("linked_at").notNull(),
  },
  (table) => [index("customer_people_customer_idx").on(table.customerId)],
);
