// Combined Drizzle schema export used by the Better Auth adapter and
// by Worker domain code. Imports must use this barrel so a single
// `drizzle(env.DB, { schema })` call gives both auth and domain
// tables to the same client.

export * from "./auth.schema";
export * from "./domain.schema";

import * as authSchema from "./auth.schema";
import * as domainSchema from "./domain.schema";

export const schema = { ...authSchema, ...domainSchema };
