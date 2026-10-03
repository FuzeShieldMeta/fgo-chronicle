import { PrismaClient } from "../generated/prisma/index.js";
import {
  manageCuratorAccess,
  parseCuratorAccessArguments,
} from "./lib/curator-access.mjs";

const db = new PrismaClient({ log: [] });
try {
  const input = parseCuratorAccessArguments(process.argv.slice(2));
  console.log(JSON.stringify(await manageCuratorAccess(db, input)));
} catch {
  console.error(
    "Curator access was not changed. Check the command, account ID, confirmation, reason, and database connection.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
