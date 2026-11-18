// db/schema.sql is the single source of truth. Workers cannot read files at
// runtime, so the DDL is embedded into a TS module at build time.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const sql = readFileSync("db/schema.sql", "utf8");
const out = `// GENERATED from db/schema.sql by scripts/gen-schema.mjs - do not edit by hand.
export const SCHEMA_SQL = ${JSON.stringify(sql)};
`;
mkdirSync("lib", { recursive: true });
writeFileSync("lib/schema.ts", out);
console.log(`lib/schema.ts written (${sql.length} bytes of DDL)`);
